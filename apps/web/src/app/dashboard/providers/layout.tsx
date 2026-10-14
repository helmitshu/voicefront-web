import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/app-shell/SettingsNav';

/**
 * Providers & services are part of the Settings home (the receptionist books
 * against them), so this route wears the same sub-navigation. The route
 * itself is unchanged.
 */
export default function ProvidersLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
