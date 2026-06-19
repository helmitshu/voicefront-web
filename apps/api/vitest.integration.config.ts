import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Integration tests need a REAL Postgres. Point the Prisma client at a dedicated
// test database: prefer TEST_DATABASE_URL, fall back to DATABASE_URL (e.g. the
// Postgres service in CI). Never silently reuse a dev DB without opting in.
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // One DB, one worker: the suite drives concurrency itself via Promise.all.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-1234',
      VAPI_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    },
  },
});
