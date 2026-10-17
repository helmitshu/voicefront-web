import { randomBytes } from 'node:crypto';
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
import { requiresInvite, inviteOnlyIndustries } from '../config/env';
import { resolvePlatformRole } from '../services/platform-admin.service';
import {
  resolveSignupPricingRegion,
  normalizePricingRegion,
  type PricingRegion,
} from '../services/pricing-region.service';
import { consumeAccessCode } from '../services/access-code.service';
import { verifyGoogleIdToken } from '../services/google-auth.service';
import { getOnboarding, toOnboardingView } from '../services/onboarding.service';
import { isBillingGateEnabled } from '../services/billing.service';

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
  /** The business website, mirroring the demo's field. Optional; when
   *  given, the server reads it (SSRF-guarded, same pipeline as the demo)
   *  to verify the pricing region. It is a verification input only: the
   *  region itself is never accepted from the client. */
  website: z.string().trim().url().max(300).optional(),
  /** One-time invitation code from the founder. Required for ordinary
   *  customers; platform operators (bootstrap/granted) are exempt. */
  accessCode: z.string().trim().max(40).optional(),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/** The three signed-in app themes (mirrors AppTheme in the web app). */
const APP_THEMES = ['pearl', 'midnight', 'deepteal'] as const;
type AppTheme = (typeof APP_THEMES)[number];

/** Stored theme values are validated on write; anything unexpected that
 *  somehow lands in the column reads back as "no account choice". */
function toAppTheme(value: string | null): AppTheme | null {
  return APP_THEMES.includes(value as AppTheme) ? (value as AppTheme) : null;
}

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
    /** App theme saved to the account, or null when never chosen. */
    theme: AppTheme | null;
    /** Calm mode saved to the account, or null when never chosen. */
    calmMode: boolean | null;
  };
  tenant: {
    id: string;
    companyName: string;
    slug: string;
    industry: 'CLINIC' | 'CONSTRUCTION';
    subscriptionStatus: string;
    /** Server-owned price book ('USD' default, 'CAD' only for a verified
     *  Canadian business or an admin override). */
    pricingRegion: PricingRegion;
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
      theme: toAppTheme(user.theme),
      calmMode: user.calmMode ?? null,
    },
    tenant: {
      id: user.tenant.id,
      companyName: user.tenant.companyName,
      slug: user.tenant.slug,
      industry: user.tenant.industry,
      subscriptionStatus: user.tenant.subscriptionStatus,
      pricingRegion: normalizePricingRegion(user.tenant.pricingRegion),
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

    // Invitation gate is PER INDUSTRY: clinics are invite-only (a vetted
    // prospect enters the one-time code the founder sent), trades is open
    // self-serve. Platform operators (founder + granted staff) always bypass.
    const isOperator = (await resolvePlatformRole(body.email)) !== null;
    const needsInvite = !isOperator && requiresInvite(body.industry);
    if (needsInvite && !body.accessCode) {
      throw new HttpError(403, 'An invitation code is required to create this kind of account.', 'CODE_REQUIRED');
    }

    const passwordHash = await hashPassword(body.password);
    const persona = industryPersona(body.industry);
    const defaults = industryDefaults(body.industry, {
      companyName: body.companyName,
      personaName: persona.personaName,
    });

    // Billing gate: while the founder has the gate switched off (tester
    // access before Stripe exists), a new workspace is born billing-exempt
    // so it can run its trial with no card. Gate on: the create below is
    // untouched and the tenant takes the schema default (not exempt).
    const billingGateOff = !(await isBillingGateEnabled());

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
            data: {
              companyName: body.companyName,
              industry: body.industry,
              slug,
              ...(billingGateOff ? { billingExempt: true } : {}),
            },
          });
          // Spend the invitation atomically with account creation: a failure
          // here rolls back the whole signup, and the conditional update makes
          // reuse/double-claim impossible. Only invite-only industries consume a
          // code; open (trades) signups create without one.
          if (needsInvite) {
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
        // Pricing region: verify the business before the first response
        // is built, so the grant is already visible in `me`. Carry-over
        // from the demo first, then the website given at signup. Never
        // throws; the USD default stands unless the business verifies
        // as Canadian.
        await resolveSignupPricingRegion(result.tenant.id, {
          email: body.email,
          website: body.website ?? null,
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

/** Public: which industries require an invitation code, so the signup form
 *  knows when to ask for one (trades is open; clinics are invite-only). */
authRouter.get(
  '/signup-config',
  asyncHandler(async (_req, res) => {
    res.json({ inviteOnlyIndustries });
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

const GoogleSchema = z.object({
  /** Google Identity Services ID token (the GIS `credential` value). */
  credential: z.string().min(1),
  /** Optional industry selected in the signup form. */
  industry: z.enum(['CLINIC', 'CONSTRUCTION']).optional(),
});

/**
 * Default industry for workspaces created through Google sign-up when the
 * request does not carry the form's selected industry. New workspaces use
 * the Google profile name as a provisional company name when Google sent
 * one; when it sent none, a neutral placeholder stands in (never the email
 * or its prefix) and the owner sets the real business name in onboarding's
 * Quick check step. Whether the request-selected or default industry
 * is used, the invite gate is mirrored from /register, so an invite-only
 * industry refuses with CODE_REQUIRED instead of slipping past the gate
 * (operators bypass, as with /register).
 */
const DEFAULT_GOOGLE_SIGNUP_INDUSTRY = 'CONSTRUCTION' as const;

authRouter.post(
  '/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = GoogleSchema.parse(req.body);
    const profile = await verifyGoogleIdToken(body.credential);

    const existing = await prisma.user.findUnique({
      where: { email: profile.email },
      include: { tenant: { select: { isBlocked: true } } },
    });
    if (existing) {
      // Same suspension rule as password login.
      if (existing.tenant.isBlocked) {
        throw new HttpError(403, 'This account has been suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
      }
      const token = signAccessToken({
        userId: existing.id,
        tenantId: existing.tenantId,
        role: existing.role,
      });
      const me = await buildMe(existing.id);
      res.json({ token, ...me });
      return;
    }

    const signupIndustry = body.industry ?? DEFAULT_GOOGLE_SIGNUP_INDUSTRY;
    const isOperator = (await resolvePlatformRole(profile.email)) !== null;
    if (!isOperator && requiresInvite(signupIndustry)) {
      throw new HttpError(
        403,
        'This kind of workspace is invitation-only. Please sign up with your email so you can enter your invitation code.',
        'CODE_REQUIRED',
      );
    }

    // The schema's password column is non-nullable, so a Google account
    // stores a hash of a random secret nobody knows (never issued, never
    // shown): password login for it is impossible, Google is the only way
    // in, and "forgot password" style recovery is a non-issue.
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
    const persona = industryPersona(signupIndustry);
    // The workspace name comes from the Google profile name only. When
    // Google sent no name, fall back to a neutral placeholder — the email
    // address and its prefix are never a company name. (profile.fullName
    // still carries the email-prefix fallback, but that value is only the
    // USER's display name, never the tenant's.)
    const companyName = profile.profileName ?? 'My business';
    const defaults = industryDefaults(signupIndustry, {
      companyName,
      personaName: persona.personaName,
    });

    // Billing gate, same rule as /register: gate off at creation means the
    // workspace is born billing-exempt; gate on leaves the create untouched.
    const billingGateOff = !(await isBillingGateEnabled());

    // Same atomic unit as /register (tenant + owner + onboarding +
    // settings), with the same slug-collision retry.
    const baseSlug = toSlug(companyName);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`;
      try {
        const result = await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              companyName,
              industry: signupIndustry,
              slug,
              ...(billingGateOff ? { billingExempt: true } : {}),
            },
          });
          const user = await tx.user.create({
            data: {
              tenantId: tenant.id,
              email: profile.email,
              fullName: profile.fullName,
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
        // Pricing region: Google signup collects no website, so only the
        // demo carry-over can grant CAD here (same email as a verified
        // demo lead). Never throws; the USD default otherwise stands.
        await resolveSignupPricingRegion(result.tenant.id, {
          email: profile.email,
          website: null,
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

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    res.json(await buildMe(auth.userId));
  }),
);

const PreferencesSchema = z
  .object({
    /** App theme to save to the account; null clears the saved choice. */
    theme: z.enum(APP_THEMES).nullable().optional(),
    /** Calm mode to save to the account; null clears the saved choice. */
    calmMode: z.boolean().nullable().optional(),
  })
  .refine((value) => value.theme !== undefined || value.calmMode !== undefined, {
    message: 'Nothing to update.',
  });

/**
 * Save display preferences (app theme, calm mode) to the signed-in user's
 * account so they follow the user across devices. Either field may be sent
 * on its own; a field sent as null clears that saved choice. Responds with
 * the full me payload, same as GET /me.
 */
authRouter.patch(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const body = PreferencesSchema.parse(req.body);
    const data: { theme?: string | null; calmMode?: boolean | null } = {};
    if (body.theme !== undefined) data.theme = body.theme;
    if (body.calmMode !== undefined) data.calmMode = body.calmMode;
    await prisma.user.update({ where: { id: auth.userId }, data });
    res.json(await buildMe(auth.userId));
  }),
);
