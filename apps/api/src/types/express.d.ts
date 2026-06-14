import type { PlatformRole, Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        tenantId: string;
        role: Role;
      };
      /** Set by requirePlatformAdmin — the verified founder/operator email. */
      adminEmail?: string;
      /** Set by requirePlatformAdmin — the operator's access level. */
      adminRole?: PlatformRole;
    }
  }
}

export {};
