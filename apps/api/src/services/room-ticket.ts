/**
 * Multiplayer Phase 1 — sticky-room recovery tickets (2026-06-12).
 *
 * THE BUG: RoomRegistry is an in-memory singleton, so every API deploy/restart
 * wipes all rooms. Real clients auto-recover (use-world-stream.ts recoverFrom409
 * re-runs join), but a bare rejoin gets AUTO-FILLED — a deploy can SPLIT a group
 * of friends who were together in one room across two freshly-minted rooms.
 *
 * THE FIX (mirrors openclaw-session-restore.ts "persist the minimum durable
 * anchor, rebuild on demand, fail closed"): on join the server hands the client
 * a signed ticket naming the room it landed in. The CLIENT holds the ticket
 * (the durable anchor — no server state, no DB row). On a RECOVERY rejoin the
 * client replays the ticket; the server verifies the signature, re-lands the
 * session in that exact room, and RECREATES the room if a restart wiped it.
 *
 * WHY A SIGNED TICKET, NOT A BARE roomId ASSERTION: honoring a client's
 * unauthenticated "put me in room ABCD" would reopen the B2 guest room-id-spam
 * hole (room-registry.ts pickOrCreateRoom deliberately drops a guest's
 * requestedRoomId to auto-fill so an anonymous attacker can't pin ID-space by
 * replaying random codes). The ticket is PROOF of prior membership: the server
 * only ever mints one for a session it actually placed in that room, and binds
 * it to that session's publicId, so it cannot be replayed by a DIFFERENT
 * session to pin an arbitrary room.
 *
 * SECURITY PROPERTIES:
 *   - HMAC-SHA256 over the payload with FINGERPRINT_SECRET. That key is
 *     hard-required at boot (middleware/fingerprint.ts throws at module load if
 *     missing or <32 chars) and is ENV-STABLE across restarts, which is exactly
 *     why a ticket minted before a deploy still verifies after it. Server-only,
 *     never leaves the box.
 *   - Right blast radius: a DERIVED sub-key off FINGERPRINT_SECRET — NOT the bare
 *     secret (avoids cross-domain key reuse with derivePublicId + fpHash; see
 *     TICKET_HMAC_KEY) and NOT the service-issuer key. A leaked room-ticket key
 *     only lets an attacker forge ROOM PLACEMENT (land in a room they could
 *     already auto-fill into anyway, capped at the hard cap), never CT/identity
 *     capability. The issuer key signs cross-service portal authority and must
 *     keep a tighter blast radius.
 *   - exp baked INTO the signed payload (not a sidecar field) so a client cannot
 *     extend its own TTL. Self-expiring at ROOM_TICKET_TTL_MS (15 min) — past
 *     that the group has dispersed and a stale ticket must not resurrect a dead
 *     room. Comfortably above a Coolify restart + client reconnect-backoff
 *     window so a deploy never expires stickiness mid-recovery.
 *   - SECRET-bound subject (NOT the wire-public publicId): the ticket commits to
 *     `sub = sha256(sessionId + subject-salt)` (deriveTicketSubject). The raw
 *     sessionId is a secret only the real session can present (Lucia cookie
 *     bearer / agent handle / guest fp), and it never enters the token itself.
 *     The route re-derives `sub` from the LIVE sessionId on recovery and requires
 *     equality, so even a fully-leaked valid ticket is useless to anyone who
 *     can't present the matching session. We deliberately do NOT bind to
 *     `publicId` — it is broadcast to every room member on the wire, so binding
 *     to it would let a co-member redeem "as you" given any valid MAC.
 *   - timingSafeEqual on the MAC compare (matches admin-only.ts) so signature
 *     verification leaks no timing oracle.
 *
 * The ticket is NOT an auth credential — it never substitutes for resolvePresence
 * at any privileged gate. It only influences WHICH room a recovering session
 * re-lands in, and only up to the hard cap. Worst case of a fully-forged ticket
 * is landing in a room you could reach by auto-fill regardless.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC key — a DERIVED sub-key, NOT the bare FINGERPRINT_SECRET.
 *
 * FINGERPRINT_SECRET is hard-required + length-validated at boot by
 * middleware/fingerprint.ts, so by the time any room ticket is minted the value
 * is guaranteed present, and it is ENV-STABLE across restarts (which is why a
 * ticket minted pre-deploy verifies post-deploy). But that one secret already
 * keys TWO other constructions — `derivePublicId` (room-registry.ts) and the
 * `fpHash`/`ipPrefixHash` (fingerprint.ts). Reusing it RAW as a third HMAC key
 * is cross-domain key reuse: a weakness or oracle in any one construction could
 * cross-contaminate the others. We therefore derive a domain-separated sub-key
 * `sha256(FINGERPRINT_SECRET + "room-rejoin-ticket-v1:")` and HMAC with THAT.
 * The `v1` lets us rotate the ticket key independently (bump to v2) without
 * touching the master secret or the other two derivations. No new env var —
 * adding a hard-required one would crash boot (fingerprint.ts pattern).
 *
 * The fallback master string is only ever exercised in unit tests that import
 * this module without the env wired up (sign/verify stay internally consistent
 * there, which is all the tests need — mirrors room-registry.ts PRESENCE_ID_SALT).
 */
const TICKET_MASTER_SECRET = process.env.FINGERPRINT_SECRET || 'test-only-room-ticket-salt';
const TICKET_HMAC_KEY = createHash('sha256')
  .update(TICKET_MASTER_SECRET + 'room-rejoin-ticket-v1:')
  .digest();

/**
 * Salt for the per-ticket SUBJECT hash. Distinct domain from `derivePublicId`'s
 * salt so the subject committed in a ticket is NOT the same value broadcast on
 * the wire as `publicId` (see below).
 */
const TICKET_SUBJECT_SALT = TICKET_MASTER_SECRET + 'room-rejoin-subject-v1:';

/** Ticket lifetime. After this the group is assumed dispersed; a stale ticket
 *  is rejected and the recovering session falls through to auto-fill. Set well
 *  above a realistic Coolify api restart + client backoff window (~2-3 min
 *  restart + up to 60 s reconnect backoff) so a deploy never silently expires a
 *  group's stickiness mid-recovery. */
export const ROOM_TICKET_TTL_MS = 15 * 60_000; // 15 minutes

/**
 * Derive the per-ticket SUBJECT — a non-reversible commitment to the raw
 * sessionId, bound to a SECRET the attacker cannot present.
 *
 * SECURITY (auditor trap, 2026-06-12): the ticket must NOT be bound to the
 * wire-broadcast `publicId`. `publicId` is emitted to every room member in each
 * SSE snapshot (room-registry.ts getPlayerSnapshots), so it is public — binding
 * to it would let anyone who saw your publicId redeem a ticket "as you" if they
 * could also obtain a valid MAC. We instead commit to `sha256(sessionId + SALT)`
 * with a salt distinct from the publicId salt: the raw sessionId is the secret
 * (a Lucia cookie bearer / agent handle / guest fp hash) that ONLY the real
 * session can present, and we never put the raw bearer itself into the ticket
 * (a DB dump / log of a ticket must not yield a spendable credential — same rule
 * as openclaw-session-restore.ts hashing the bearer into session_key_hash). On
 * redeem the route re-derives this subject from the LIVE sessionId and requires
 * equality, so a fully-leaked valid ticket is useless to anyone who can't also
 * present the matching cookie/agent-session/fingerprint.
 */
export function deriveTicketSubject(sessionId: string): string {
  return createHash('sha256').update(sessionId + TICKET_SUBJECT_SALT).digest('hex').slice(0, 32);
}

export interface RoomTicketClaims {
  /** The room the session was placed in. */
  roomId: string;
  /**
   * Non-reversible, secret-bound commitment to the sessionId this ticket was
   * minted for (see deriveTicketSubject). NOT the wire-public publicId.
   */
  sub: string;
  /** Absolute expiry (epoch ms). Baked into the signed payload. */
  exp: number;
}

/**
 * Compute the base64url-encoded HMAC-SHA256 of the payload string. Returns the
 * raw Buffer so callers can timingSafeEqual without re-decoding.
 */
function macOf(payload: string): Buffer {
  return createHmac('sha256', TICKET_HMAC_KEY).update(payload).digest();
}

/**
 * Mint a signed recovery ticket. The caller passes the RAW sessionId; we commit
 * to it via `deriveTicketSubject` (the raw sessionId never enters the token).
 * The exp is computed from `now` (injectable for tests) + ROOM_TICKET_TTL_MS and
 * signed INTO the payload. Format: `<base64url(JSON payload)>.<base64url(HMAC)>`.
 *
 * Called by /api/world/join AFTER the registry assigns the room, so the ticket
 * always names the room the session actually landed in.
 */
export function signRoomTicket(
  claims: { roomId: string; sessionId: string },
  now: number = Date.now(),
): string {
  const payload: RoomTicketClaims = {
    roomId: claims.roomId,
    sub: deriveTicketSubject(claims.sessionId),
    exp: now + ROOM_TICKET_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = macOf(payloadB64).toString('base64url');
  return `${payloadB64}.${mac}`;
}

/**
 * Verify a recovery ticket. Returns the claims `{ roomId, sub, exp }` when the
 * signature is valid AND not expired; null otherwise. FAIL-CLOSED on every
 * malformed / tampered / expired / wrong-key input — the caller treats null as
 * "no valid ticket" and falls through to the normal join flow.
 *
 * Does NOT check subject binding — that's the route's job (it re-derives the
 * live session's subject via deriveTicketSubject and requires equality), because
 * only the route knows the live sessionId. Here we only prove the ticket was
 * issued by THIS server and is fresh.
 */
export function verifyRoomTicket(
  ticket: string,
  now: number = Date.now(),
): RoomTicketClaims | null {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 512) {
    return null;
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const payloadB64 = ticket.slice(0, dot);
  const macB64 = ticket.slice(dot + 1);

  // Recompute the expected MAC and constant-time compare. A length mismatch
  // (tampered/truncated MAC) is rejected before timingSafeEqual, which throws
  // on unequal-length buffers.
  const expectedMac = macOf(payloadB64);
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(macB64, 'base64url');
  } catch {
    return null;
  }
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  // Signature is authentic — now parse + validate the claims.
  let claims: RoomTicketClaims;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RoomTicketClaims).roomId !== 'string' ||
      typeof (parsed as RoomTicketClaims).sub !== 'string' ||
      typeof (parsed as RoomTicketClaims).exp !== 'number'
    ) {
      return null;
    }
    claims = parsed as RoomTicketClaims;
  } catch {
    return null;
  }

  if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;
  return claims;
}

/**
 * Resolve the sticky-recovery room id for a join request — THE security gate.
 *
 * This is the single authoritative decision the route delegates to (world.ts
 * `/join` calls it directly), so the literal code that gates recovery IS the
 * tested unit: a regression that drops the subject check fails the unit tests
 * here, not just a mirror of them.
 *
 * Returns the room id to recover into ONLY when ALL hold:
 *   - a ticket was presented,
 *   - it verifies (authentic MAC + unexpired — verifyRoomTicket, fail-closed),
 *   - AND its subject equals the subject re-derived from the LIVE sessionId.
 * The last check is the anti-replay boundary: a ticket captured off another
 * session is bound to THAT session's subject, so a different caller re-deriving
 * its own subject can never match — it falls through (undefined) to the normal
 * requestedRoomId / auto-fill flow. Returns undefined on every failure so the
 * caller treats "no recovery" as "join normally" (B2 anti-spam preserved — a
 * bare/forged/foreign ticket can never pin an arbitrary room id).
 */
export function resolveRecoveryRoomId(
  ticket: string | undefined,
  liveSessionId: string,
  now: number = Date.now(),
): string | undefined {
  if (!ticket) return undefined;
  const claims = verifyRoomTicket(ticket, now);
  if (!claims) return undefined;
  if (claims.sub !== deriveTicketSubject(liveSessionId)) return undefined;
  return claims.roomId;
}
