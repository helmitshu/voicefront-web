-- Display preferences saved to the account: the signed-in app theme
-- ('pearl' | 'midnight' | 'deepteal', validated in the auth routes) and
-- calm mode (reduced motion and effects). Both nullable: null means the
-- user has never chosen, and devices use their local default.
ALTER TABLE "users" ADD COLUMN "theme" TEXT;
ALTER TABLE "users" ADD COLUMN "calm_mode" BOOLEAN;
