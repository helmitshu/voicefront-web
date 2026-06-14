import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env, corsOrigins } from './config/env';
import { errorHandler, notFound } from './middleware/error';
import { authRouter } from './routes/auth.routes';
import { onboardingRouter } from './routes/onboarding.routes';
import { adminRouter } from './routes/admin.routes';
import { agentRouter } from './routes/agent.routes';
import { appointmentsRouter } from './routes/appointments.routes';
import { callsRouter } from './routes/calls.routes';
import { voiceRouter } from './routes/voice.routes';
import { mediaRouter } from './routes/media.routes';
import { inboundRouter } from './routes/inbound.routes';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1); // accurate client IPs for rate limiting behind a proxy
  }

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'voicefront-api' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/vapi/inbound', inboundRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
