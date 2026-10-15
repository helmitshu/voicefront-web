/**
 * The in-app support agent's persona. ONE place: renaming the agent or
 * swapping the photo is a one-line change here. The avatar lives in the
 * web public folder; if the file is missing (or fails to load) the widget
 * falls back to the agent's initials in a colored circle.
 */
export const SUPPORT_PERSONA = {
  name: 'Adam',
  role: 'Customer Care Specialist',
  avatarPath: '/support-agent.jpg',
  identityLine: "I'm an AI assistant from VoiceFront Customer Care.",
  greeting: "Hi, I'm Adam, an AI assistant from VoiceFront Customer Care.",
} as const;

/** "Adam" -> "A"; "Adam Rivera" -> "AR". */
export function personaInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}
