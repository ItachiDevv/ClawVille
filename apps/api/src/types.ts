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
