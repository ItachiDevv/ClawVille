/**
 * Phase 2 (Q3 plan §3.1) — derived user tier from (hasAccount, hasAgent).
 *
 * Replaces the originally-planned controlMode rename. The existing
 * `controlMode` union ('explore' | 'npc' | 'player' | 'autonomous') describes
 * how INPUT routes through the game loop; `userTier` describes the user's
 * relationship with the platform (anonymous, signed-in-but-unbound,
 * signed-in-with-agent). Two orthogonal axes — both stay.
 *
 * Rationale for not renaming controlMode:
 *   - 14 callers across the web app reference 'explore'/'player' literals.
 *     Rename = high-blast-radius refactor for a purely cosmetic alignment
 *     with brand-identity terminology.
 *   - controlMode is about input routing; userTier is about platform tier.
 *     They genuinely describe different things and shouldn't collapse.
 *
 * Use this helper anywhere you need to render tier-aware UI:
 *   - "Upgrade to Trainer" button visibility (only when tier === 'player')
 *   - Tutorial gating ("Connect an agent to unlock autonomous mode")
 *   - Dashboard segmentation
 */

export type UserTier =
  /** Anonymous — never signed up. Public visitors, before /api/auth/guest fires. */
  | 'guest'
  /** Signed in + has a pet, but no agent connected. The Q3 brand-identity addition. */
  | 'player'
  /** Signed in + agent connected. The original "controlled gameplay" tier. */
  | 'trainer';

export interface UserTierInputs {
  /** True when api.me() resolved a non-guest user with a session cookie. */
  hasAccount: boolean;
  /** True when an OpenClaw/Hermes/Milady agent is currently bound + alive
   *  (matches GameState.hasAgent in the zustand store). */
  hasAgent: boolean;
}

export function deriveUserTier(inputs: UserTierInputs): UserTier {
  if (!inputs.hasAccount) return 'guest';
  if (inputs.hasAgent) return 'trainer';
  return 'player';
}
