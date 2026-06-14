import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Throwable error carrying an HTTP status and a stable machine code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Wraps an async route so rejected promises reach the central error
 * handler instead of becoming unhandled rejections (Express 4 does not
 * catch async errors on its own).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
