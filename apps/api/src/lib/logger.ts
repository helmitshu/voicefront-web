import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured JSON logger. One line per event with consistent fields, so logs
 * are searchable/filterable in production (Railway captures stdout) instead of
 * ad-hoc console strings. Obvious secrets are redacted defensively in case an
 * object carrying one is ever logged.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'voicefront-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'token',
      'secret',
      'DATABASE_URL',
      'credentialsEnc',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
