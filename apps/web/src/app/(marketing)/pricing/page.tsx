import type { Metadata } from 'next';
import { PricingSection, RoiSection, FaqSection, FinalCtaSection } from '@/components/marketing/sections';
import { getPricingCurrency } from '@/lib/visitor-country';

export const metadata: Metadata = {
  title: 'Pricing: Two plans, priced in the open',
  description:
    'Starter After-Hours and Core 24/7, priced in US dollars. Canadian clinics are billed in Canadian dollars. $0 setup, a 7-day free trial on both plans, and cancel anytime. See what missed calls are costing your clinic with the calculator.',
};

// Prices are per visitor (CAD for Canadian visitors, USD for everyone
// else), so this page renders per request.
export const dynamic = 'force-dynamic';

export default async function PricingPage() {
  const currency = await getPricingCurrency();
  return (
    <>
      <PricingSection currency={currency} />
      <RoiSection />
      <FaqSection />
      <FinalCtaSection />
    </>
  );
}
