import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { verifyMediaToken } from '../lib/jwt';

/**
 * Streams call recordings through the platform so the provider's storage URL
 * is never exposed to the browser. Auth rides in the URL (a short-lived
 * signed token) because <audio> elements cannot send Authorization headers.
 * Range requests are passed through so seeking works in custom players.
 */
export const mediaRouter = Router();

mediaRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const payload = verifyMediaToken(req.params.token);

    const log = await prisma.callLog.findFirst({
      where: { id: payload.cid, tenantId: payload.tid },
      select: { recordingUrl: true },
    });
    if (!log || !log.recordingUrl) {
      throw new HttpError(404, 'No recording is available for this call.', 'NO_RECORDING');
    }

    const range = req.headers.range;
    let upstream: Response;
    try {
      upstream = await fetch(log.recordingUrl, {
        headers: range ? { Range: range } : undefined,
        redirect: 'follow',
      });
    } catch {
      throw new HttpError(502, 'The recording is temporarily unavailable.', 'UPSTREAM_FAILED');
    }
    if (!upstream.ok && upstream.status !== 206) {
      throw new HttpError(502, 'The recording is temporarily unavailable.', 'UPSTREAM_FAILED');
    }

    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!upstream.headers.get('content-type')) {
      res.setHeader('content-type', 'audio/wav');
    }
    res.setHeader('cache-control', 'private, no-store');
    // The web app and API are different origins (e.g. :3000 vs :4000), so the
    // global Helmet `Cross-Origin-Resource-Policy: same-origin` would stop the
    // browser's <audio> element from using this stream. The URL is already
    // gated by a short-lived signed token, so relax CORP for this route only.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (!upstream.body) {
      res.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
    // If the listener closes the player mid-stream, stop pulling upstream
    // bytes instead of buffering into a dead socket.
    res.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    stream.pipe(res);
  }),
);
