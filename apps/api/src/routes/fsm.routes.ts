import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  getFsmConnections,
  connectFsm,
  disconnectFsm,
  setFsmPushJobs,
} from '../services/fsm.service';

/**
 * Field-service-management connections for the FSM_INTEGRATION feature. The
 * feature gate is enforced in the service on every mutation; the client UI hides
 * itself entirely when the feature isn't entitled. Credentials go in, never come
 * back out.
 */
export const fsmRouter = Router();
fsmRouter.use(requireAuth);

fsmRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const connections = await getFsmConnections(auth.tenantId);
    res.json({ connections });
  }),
);

const ConnectSchema = z.object({
  provider: z.string(),
  credentials: z.record(z.string()),
});

fsmRouter.post(
  '/connect',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { provider, credentials } = ConnectSchema.parse(req.body);
    const connection = await connectFsm(auth.tenantId, provider, credentials);
    res.json({ connection });
  }),
);

const PushSchema = z.object({ pushJobs: z.boolean() });

fsmRouter.patch(
  '/:provider',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { pushJobs } = PushSchema.parse(req.body);
    await setFsmPushJobs(auth.tenantId, req.params.provider, pushJobs);
    res.json({ ok: true });
  }),
);

fsmRouter.delete(
  '/:provider',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    await disconnectFsm(auth.tenantId, req.params.provider);
    res.json({ ok: true });
  }),
);
