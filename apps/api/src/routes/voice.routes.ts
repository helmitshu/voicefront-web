import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getSettingValue } from '../services/platform-config.service';
import { getAuth, requireAuth } from '../middleware/auth';
import { buildTransientAssistant } from '../domain/assistant-builder';

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

/**
 * Powers the in-browser simulator. The browser never holds a hardcoded key:
 * it asks the server for a session, and the server returns the public web key
 * plus a transient assistant built from the tenant's *current* settings —
 * so "Save then Test" always tests what was just saved.
 */
voiceRouter.post(
  '/web-session',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const publicKey = await getSettingValue('VAPI_PUBLIC_KEY');
    if (!publicKey) {
      throw new HttpError(
        503,
        'Voice simulation is not configured on this server yet. Ask your administrator to set the voice public key.',
        'VOICE_NOT_CONFIGURED',
      );
    }

    const [tenant, settings] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { id: true, companyName: true },
      }),
      prisma.agentSettings.findUnique({ where: { tenantId: auth.tenantId } }),
    ]);
    if (!tenant || !settings) {
      throw new HttpError(409, 'Receptionist settings are missing for this workspace.', 'SETTINGS_MISSING');
    }

    const publicApiUrl = await getSettingValue('PUBLIC_API_URL');
    const assistant = buildTransientAssistant(tenant, settings, 'web', new Date(), {
      // Browser test calls have no phone-number server config, so tool calls
      // (booking) only work when the API's public URL is configured.
      serverUrl: publicApiUrl ? `${publicApiUrl}/api/vapi/inbound` : undefined,
    });
    res.json({ publicKey, assistant });
  }),
);
