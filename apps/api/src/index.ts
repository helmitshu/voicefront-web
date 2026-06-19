import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { startReminderJob } from './jobs/reminder.job';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`✔ VoiceFront API listening on http://localhost:${env.PORT}`);
  startReminderJob();
});

// Belt-and-braces: every route is wrapped in asyncHandler, but anything that
// escapes (timers, fire-and-forget) is logged instead of crashing silently.
process.on('unhandledRejection', (reason) => {
  console.error('[api] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[api] Uncaught exception:', err);
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
