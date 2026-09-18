/**
 * The label for a player's own agent in the UI: "<username> agent"
 * (founder, 2026-09-18: "if anything it should just say 'username agent'. so
 * mine would be 'itachi agent'"). The username is the account's public name,
 * so the label follows a username change without renaming the avatar.
 * Falls back to the avatar name for an account with no username yet, and
 * never doubles the suffix.
 */
export function agentDisplayName(
  username: string | null | undefined,
  avatarName: string | null | undefined,
): string {
  const base = (username ?? '').trim() || (avatarName ?? '').trim();
  if (!base) return 'Your agent';
  return /\sagent$/i.test(base) ? base : `${base} agent`;
}
