/** Strict E.164: +, leading non-zero digit, 7-15 digits total. */
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(raw: string): string {
  return raw.replace(/[\s().-]/g, '');
}

export function isE164(raw: string): boolean {
  return E164_REGEX.test(normalizePhone(raw));
}
