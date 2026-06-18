import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests need a real DB and run under their own config.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    // Dummy values so importing modules that construct the Prisma client or read
    // config never aborts the runner. Unit tests here are pure (no DB queries).
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-1234',
      VAPI_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    },
  },
});
