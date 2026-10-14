import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { env } from '../config/env';
import { HttpError } from '../lib/http';

/**
 * "Continue with Google" sign-in (Google Identity Services ID-token flow).
 * The browser obtains an ID token from Google and posts it to
 * POST /api/auth/google; this service is the only place that token is
 * trusted, and only after google-auth-library verifies its signature,
 * issuer, and expiry against Google's keys and its audience against our
 * own client ID. No client secret exists in this flow.
 */

export interface GoogleProfile {
  /** Verified email, normalized the same way /register normalizes it. */
  email: string;
  /** Display name from the token, or the email local part when Google sent none. */
  fullName: string;
}

export async function verifyGoogleIdToken(credential: string): Promise<GoogleProfile> {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new HttpError(
      503,
      'Google sign-in is not available right now. Please use your email and password.',
      'GOOGLE_AUTH_NOT_CONFIGURED',
    );
  }

  let payload: TokenPayload | undefined;
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(
      401,
      'That Google sign-in could not be verified. Please try again.',
      'GOOGLE_TOKEN_INVALID',
    );
  }

  const email = payload?.email?.trim().toLowerCase();
  if (!payload || !email || payload.email_verified !== true) {
    throw new HttpError(
      401,
      'Google did not confirm a verified email for this sign-in. Please try again.',
      'GOOGLE_EMAIL_UNVERIFIED',
    );
  }

  const fullName = payload.name?.trim() || email.split('@')[0] || email;
  return { email, fullName };
}
