import type { User, Session } from 'lucia';

export interface AppContext {
  Variables: {
    user: User | null;
    session: Session | null;
    /**
     * Phase 1 anti-farm — sha256(FINGERPRINT_SECRET || browser_fp).
     * Set by global fingerprintMiddleware on every request.
     * Always present (UA+IP fallback if browser header missing).
     */
    fpHash: string;
    /**
     * Phase 1 anti-farm — sha256(FINGERPRINT_SECRET || ip_first_3_octets).
     * Same lifecycle as fpHash.
     */
    ipPrefixHash: string;
    /**
     * Hatcher partner #2 Phase C — set by `requirePartnerKey()` on the partner-
     * gated skill routes ONLY. Identifies the validated partner key holder.
     * Undefined on every other request (the middleware never runs there).
     */
    partnerId?: string;
    /**
     * Hatcher partner #2 Phase C — granted scopes for the validated partner key.
     * Set alongside `partnerId` by `requirePartnerKey()`.
     */
    partnerScopes?: string[];
    /**
     * Hatcher partner #2 Phase C — how the per-building SKILL.md read was
     * authorized, tagged onto the `skill_md.fetched` event payload's `via`.
     * `'partner-import'` for partner-key bulk fetches (excluded from the
     * leaderboard); `undefined` for organic end-user fetches (in-game "Claim
     * Skill" button, connected agents — still count, under the 11/day cap).
     * Set by the `endUserOrPartnerKey` gate in `routes/skills.ts`.
     */
    skillReadVia?: 'partner-import' | undefined;
  };
}

export interface AuthenticatedContext {
  Variables: {
    user: User;
    session: Session;
    fpHash: string;
    ipPrefixHash: string;
  };
}
