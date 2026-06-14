import { PrismaClient } from '@prisma/client';

/**
 * Single PrismaClient for the process. `tsx watch` re-imports modules on
 * reload, so we stash the instance on globalThis to avoid exhausting the
 * connection pool during development.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
