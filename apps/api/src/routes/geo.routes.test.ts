import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { geoRouter } from './geo.routes';
import { errorHandler } from '../middleware/error';
import { detectIpCountry } from '../services/geo.service';

/**
 * Route tests for GET /api/geo/country. Only the ipapi.co lookup is mocked;
 * clientIp and parsePublicIp run for real, so these pin the header contract
 * the web tier relies on: a valid public `x-visitor-ip` wins, anything else
 * falls back to the connection chain exactly as before.
 */
vi.mock('../services/geo.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/geo.service')>();
  return { ...actual, detectIpCountry: vi.fn() };
});

const detectMock = vi.mocked(detectIpCountry);

// Public documentation-range IPs (never private per isPrivateIp).
const CA_IP = '198.51.100.23';
const US_IP = '198.51.100.24';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/geo', geoRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  detectMock.mockImplementation(async (ip: string | null) =>
    ip === CA_IP ? 'CA' : ip === US_IP ? 'US' : null,
  );
});

async function getCountry(headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/geo/country`, { headers });
  return { status: res.status, body: (await res.json()) as { country: string | null } };
}

describe('GET /api/geo/country', () => {
  it('honours a valid public x-visitor-ip over the connection IP', async () => {
    // The test client connects from 127.0.0.1, so without the header the
    // route would resolve the loopback (null). The header must win.
    const { status, body } = await getCountry({ 'x-visitor-ip': CA_IP });
    expect(status).toBe(200);
    expect(body).toEqual({ country: 'CA' });
    expect(detectMock).toHaveBeenCalledWith(CA_IP);
  });

  it('ignores a garbage x-visitor-ip and falls back to the forwarded chain', async () => {
    const { status, body } = await getCountry({
      'x-visitor-ip': 'not-an-ip',
      'x-forwarded-for': US_IP,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ country: 'US' });
    expect(detectMock).toHaveBeenCalledWith(US_IP);
  });

  it('ignores a private x-visitor-ip and falls back to the forwarded chain', async () => {
    const { body } = await getCountry({
      'x-visitor-ip': '10.1.2.3',
      'x-forwarded-for': US_IP,
    });
    expect(body).toEqual({ country: 'US' });
    expect(detectMock).toHaveBeenCalledWith(US_IP);
  });

  it('behaves as before when the header is absent', async () => {
    const { status, body } = await getCountry();
    expect(status).toBe(200);
    expect(body).toEqual({ country: null });
    expect(detectMock).toHaveBeenCalledWith('127.0.0.1');
  });
});
