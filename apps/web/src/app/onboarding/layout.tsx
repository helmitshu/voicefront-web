'use client';

import type { ReactNode } from 'react';
import { RequireAuth, useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Button } from '@/components/ui/Button';

function OnboardingChrome({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth();
  return (
    <div className="min-h-screen bg-paper">
      <header className="flex items-center justify-between border-b border-line bg-white px-6 py-4">
        <Logo />
        <div className="flex items-center gap-4">
          {me && <span className="hidden text-sm text-ink-muted sm:block">{me.tenant.companyName}</span>}
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <OnboardingChrome>{children}</OnboardingChrome>
    </RequireAuth>
  );
}
