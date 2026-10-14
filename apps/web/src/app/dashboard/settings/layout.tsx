import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/app-shell/SettingsNav';

/** Settings home shell: the sub-navigation above the receptionist settings. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
