import Stripe from 'stripe';
import { getSettingValue } from '../services/platform-config.service';

/**
 * Stripe client, resolved from the configured secret key. Returns null when no
 * key is set, so the whole billing feature stays dormant (and the app behaves
 * exactly as before) until an operator adds keys in admin — same pattern as
 * Sentry/Twilio. Cached per key so a key rotation is picked up automatically.
 */
let cached: { key: string; client: Stripe } | null = null;

export async function getStripe(): Promise<Stripe | null> {
  const key = (await getSettingValue('STRIPE_SECRET_KEY'))?.trim();
  if (!key) return null;
  if (cached && cached.key === key) return cached.client;
  const client = new Stripe(key);
  cached = { key, client };
  return client;
}
