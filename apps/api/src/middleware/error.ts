import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/http';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { captureError } from '../lib/sentry';

/** Uniform JSON 404 for unknown API paths (instead of Express HTML). */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
}

interface ErrorBody {
  error: { message: string; code?: string; details?: unknown };
}

/**
 * Central error handler. Every route uses asyncHandler, so rejected promises
 * land here too — no unhandled rejections from request paths.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    // A streaming response (e.g. the media proxy) already started; the only
    // safe move is to terminate the socket.
    res.destroy();
    return;
  }

  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        message: 'Some fields are invalid. Please review and try again.',
        code: 'VALIDATION_ERROR',
        details: err.flatten(),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof HttpError) {
    const body: ErrorBody = {
      error: { message: err.message, code: err.code, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }

  // Prisma known errors arrive as plain objects with a string `code`.
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2002') {
    res.status(409).json({
      error: { message: 'That value is already in use.', code: 'DUPLICATE' },
    } satisfies ErrorBody);
    return;
  }

  // Unexpected (500-class): log with the request id and report to Sentry.
  const log = req.log ?? logger;
  log.error({ err, requestId: req.id, path: req.originalUrl }, 'unhandled error');
  captureError(err, { requestId: req.id, path: req.originalUrl, method: req.method });
  res.status(500).json({
    error: {
      message: 'Something went wrong on our side. Please try again.',
      code: 'INTERNAL',
      ...(env.NODE_ENV === 'development' && err instanceof Error ? { details: err.message } : {}),
    },
  } satisfies ErrorBody);
}
