import type { ReactNode } from 'react';
import { WaveBackground } from '@/components/WaveBackground';
import { SiteHeader, SiteFooter } from '@/components/marketing/sections';

/**
 * Shared chrome for every marketing page: the ambient wave backdrop, the fixed
 * site header, and the footer. `pt-[100px]` on <main> clears the fixed header
 * (36px announcement bar + 64px nav) so each page's first section isn't hidden.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative text-ink">
      <WaveBackground />
      <SiteHeader />
      <main className="pt-[100px]">{children}</main>
      <SiteFooter />
    </div>
  );
}
