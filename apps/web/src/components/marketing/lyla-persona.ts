/**
 * Lyla's persona, the public landing-page host. Mirrors the support
 * agent's persona pattern (one small config module next to the widget),
 * but she is a separate agent from Adam: different surface (marketing
 * pages only, never the dashboard), different brain (the public agent on
 * the API), and her own name, title, and portrait.
 *
 * The greeting carries the same honesty as Adam's: she says she is an AI
 * host up front, before anyone has to ask.
 */
export const LYLA_PERSONA = {
  name: 'Lyla',
  role: 'Customer Experience Specialist',
  avatarPath: '/lyla.jpg',
  identityLine: "I'm Lyla, an AI host from VoiceFront.",
  greeting:
    "Hi, I'm Lyla, an AI host from VoiceFront. Ask me anything about how VoiceFront works, or I can set up your personalized demo.",
} as const;

/** 'Lyla' -> 'L'; a two-part name -> two initials; empty -> '?'. */
export function lylaInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}
