import * as Sentry from '@sentry/node';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Sentry error reporting — dormant until a DSN is configured, so it ships safely
 * with nothing to set up, and switches on the moment SENTRY_DSN is set. Errors
 * only (no performance tracing) to keep it free-tier-friendly.
 */
let enabled = false;

export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    logger.info('Sentry DSN not set — error reporting disabled (logs still emitted).');
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    tracesSampleRate: 0,
  });
  enabled = true;
  logger.info('Sentry error reporting enabled.');
}

/** Report an exception to Sentry (no-op when disabled). */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let reporting throw into the request path */
  }
}
