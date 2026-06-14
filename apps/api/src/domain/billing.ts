/**
 * Money is handled in integer cents end-to-end; the provider reports dollars
 * as a float, which is converted exactly once at ingestion.
 */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars < 0) return 0;
  return Math.round(dollars * 100);
}

/** Applies the tenant-facing markup in basis points (5000 = +50%). */
export function applyMarkup(providerCostCents: number, markupBps: number): number {
  const safeBps = Number.isFinite(markupBps) && markupBps >= 0 ? Math.floor(markupBps) : 0;
  return Math.round((providerCostCents * (10000 + safeBps)) / 10000);
}
