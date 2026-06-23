import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger, type Logger } from '../lib/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request — echoed back in the x-request-id header. */
      id: string;
      /** Per-request child logger carrying the request id. */
      log: Logger;
    }
  }
}

/**
 * Assigns a correlation id to every request and logs one structured line when it
 * finishes (method, path, status, duration) — so a slow or failing call is
 * traceable end to end. The id is echoed in `x-request-id` and attached to the
 * error reporter, tying logs, the response, and Sentry together.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('x-request-id', id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const fields = {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs,
    };
    if (res.statusCode >= 500) req.log.error(fields, 'request');
    else if (res.statusCode >= 400) req.log.warn(fields, 'request');
    else req.log.info(fields, 'request');
  });

  next();
}
