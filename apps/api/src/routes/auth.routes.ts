import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { signAccessToken } from '../lib/jwt';
import { randomSuffix, toSlug } from '../lib/slug';
import { defaultBusinessHours } from '../domain/agent-config';
import { industryDefaults, industryPersona } from '../domain/prompt-templates';
import { getAuth, requireAuth } from '../middleware/auth';
import { resolvePlatformRole } from '../services/platform-admin.service';
import { consumeAccessCode } from '../services/access-code.service';
import { getOnboarding, toOnboardingView } from '../services/onboarding.service';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please wait a few minutes.', code: 'RATE_LIMITED' } },
});

const RegisterSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is too short').max(80),
  industry: z.enum(['CLINIC', 'CONSTRUCTION']),
  fullName: z.string().trim().min(2, 'Please enter your name').max(80),
  email: z.string().trim().toLowerCase().email('Please enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  /** One-time invitation code from the founder. Required for ordinary
   *  customers; platform operators (bootstrap/granted) are exempt. */
  accessCode: z.string().trim().max(40).optional(),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

interface MeResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: 'OWNER' | 'MANAGER' | 'AGENT';
    /** True for any platform operator (founder, granted admin, or support). */
    isPlatformAdmin: boolean;
    /** Operator access level, or null for ordinary customers. */
    adminRole: 'ADMIN' | 'SUPPORT' | null;
  };
  tenant: {
    id: string;
    companyName: string;
    slug: string;
    industry: 'CLINIC' | 'CONSTRUCTION';
    subscriptionStatus: string;
  };
  onboarding: ReturnType<typeof toOnboardingView>;
}

async function buildMe(userId: string): Promise<MeResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { tenant: true },
  });
  if (!user) throw new HttpError(401, 'Your account could not be found.', 'UNAUTHENTICATED');
  const [onboarding, adminRole] = await Promise.all([
    getOnboarding(user.tenantId),
    resolvePlatformRole(user.email),
  ]);
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isPlatformAdmin: adminRole !== null,
      adminRole,
    },
    tenant: {
      id: user.tenant.id,
      companyName: user.tenant.companyName,
      slug: user.tenant.slug,
      industry: user.tenant.industry,
      subscriptionStatus: user.tenant.subscriptionStatus,
    },
    onboarding: toOnboardingView(onboarding),
  };
}

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = RegisterSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new HttpError(409, 'An account with this email already exists.', 'EMAIL_TAKEN');
    }

    // Signups are invite-only: a vetted prospect enters the one-time code the
    // founder sent after their demo/call. Platform operators (the founder and
    // any granted staff) are exempt so they can never be locked out by the gate.
    const isOperator = (await resolvePlatformRole(body.email)) !== null;
    if (!isOperator && !body.accessCode) {
      throw new HttpError(403, 'An invitation code is required to create an account.', 'CODE_REQUIRED');
    }

    const passwordHash = await hashPassword(body.password);
    const persona = industryPersona(body.industry);
    const defaults = industryDefaults(body.industry, {
      companyName: body.companyName,
      personaName: persona.personaName,
    });

    // Tenant + owner + onboarding + settings are one atomic unit: a partial
    // signup must never leave a tenant without settings or vice versa.
    // Slug collisions retry with a fresh random suffix.
    const baseSlug = toSlug(body.companyName);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`;
      try {
        const result = await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { companyName: body.companyName, industry: body.industry, slug },
          });
          // Spend the invitation atomically with account creation: a failure
          // here rolls back the whole signup, and the conditional update makes
          // reuse/double-claim impossible. Operators skip the gate entirely.
          if (!isOperator) {
            const consumed = await consumeAccessCode(tx, body.accessCode ?? '', tenant.id);
            if (!consumed) {
              throw new HttpError(403, 'That invitation code is invalid or has already been used.', 'INVALID_CODE');
            }
          }
          const user = await tx.user.create({
            data: {
              tenantId: tenant.id,
              email: body.email,
              fullName: body.fullName,
              passwordHash,
              role: 'OWNER',
            },
          });
          await tx.onboardingStatus.create({ data: { tenantId: tenant.id } });
          await tx.agentSettings.create({
            data: {
              tenantId: tenant.id,
              displayName: persona.personaName,
              voiceId: persona.voiceId,
              systemPrompt: defaults.systemPrompt,
              firstMessage: defaults.firstMessage,
              voicemailGreeting: defaults.voicemailGreeting,
              businessHours: defaultBusinessHours() as unknown as Prisma.InputJsonValue,
              forwardingNumbers: [] as unknown as Prisma.InputJsonValue,
            },
          });
          return { tenant, user };
        });

        const token = signAccessToken({
          userId: result.user.id,
          tenantId: result.tenant.id,
          role: result.user.role,
        });
        const me = await buildMe(result.user.id);
        res.status(201).json({ token, ...me });
        return;
      } catch (err) {
        lastError = err;
        const code = (err as { code?: unknown })?.code;
        const target = (err as { meta?: { target?: unknown } })?.meta?.target;
        const isSlugCollision =
          code === 'P2002' && Array.isArray(target) && target.includes('slug');
        if (!isSlugCollision) throw err;
        // else: loop and retry with a suffixed slug
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new HttpError(500, 'Could not create your workspace. Please try again.', 'INTERNAL');
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { tenant: { select: { isBlocked: true } } },
    });

    // Always run a bcrypt compare (against a dummy hash when the user is
    // unknown) so response timing does not reveal which emails exist.
    const hash =
      user?.passwordHash ??
      '$2a$12$C6UzMDM.H6dfI/f/IKcEeO9pZ0eXboDheGq2Yw0fO5oQGXyGopW2e';
    const ok = await verifyPassword(body.password, hash);
    if (!user || !ok) {
      throw new HttpError(401, 'Incorrect email or password.', 'BAD_CREDENTIALS');
    }
    // Suspended workspace: refuse login regardless of correct credentials.
    if (user.tenant.isBlocked) {
      throw new HttpError(403, 'This account has been suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
    }

    const token = signAccessToken({ userId: user.id, tenantId: user.tenantId, role: user.role });
    const me = await buildMe(user.id);
    res.json({ token, ...me });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    res.json(await buildMe(auth.userId));
  }),
);
