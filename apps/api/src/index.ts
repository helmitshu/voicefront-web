import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { logger } from './lib/logger';
import { initSentry, captureError } from './lib/sentry';
import { startReminderJob } from './jobs/reminder.job';
import { startReactivationJob } from './jobs/reactivation.job';
import { startDispatchJob } from './jobs/dispatch.job';
import { startRetentionJob } from './jobs/retention.job';

// Initialise error reporting before anything else can throw.
initSentry();

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'VoiceFront API listening');
  startReminderJob();
  startReactivationJob();
  startDispatchJob();
  startRetentionJob();
});

// Belt-and-braces: every route is wrapped in asyncHandler, but anything that
// escapes (timers, fire-and-forget) is logged + reported instead of crashing
// silently.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
  captureError(reason);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  captureError(err);
  shutdown(1);
});

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => process.exit(code));
  });
  // Hard exit if connections refuse to drain.
  setTimeout(() => process.exit(code), 10_000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
