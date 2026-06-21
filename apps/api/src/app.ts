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
import { documentsRouter } from './routes/documents.routes';
import { demoRouter } from './routes/demo.routes';
import { bookingRouter } from './routes/booking.routes';
import { providersRouter } from './routes/providers.routes';
import { smsRouter } from './routes/sms.routes';
import { analyticsRouter } from './routes/analytics.routes';
import { waitlistRouter } from './routes/waitlist.routes';
import { reactivationRouter } from './routes/reactivation.routes';
import { calendarRouter } from './routes/calendar.routes';
import { screeningRouter } from './routes/screening.routes';
import { unsubscribeRouter } from './routes/unsubscribe.routes';

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
      // X-File-Name / X-File-Type carry document metadata on raw-binary uploads.
      allowedHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'X-File-Type'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false })); // for Twilio webhook form-posts

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'voicefront-api' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/providers', providersRouter);
  app.use('/api/sms', smsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/waitlist', waitlistRouter);
  app.use('/api/reactivation', reactivationRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/screening', screeningRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/vapi/inbound', inboundRouter);
  app.use('/api/demo', demoRouter);
  app.use('/api/booking', bookingRouter);
  app.use('/api/unsubscribe', unsubscribeRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
