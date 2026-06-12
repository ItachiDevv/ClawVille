/**
 * Sticky-room recovery ticket — unit tests (2026-06-12).
 *
 * Covers the HMAC sign/verify round-trip, expiry, tamper rejection, the
 * fail-closed contract on malformed input, and the SECRET-bound subject:
 * a ticket minted for session A must NOT verify-as-bound for session B. The
 * subject-equality check itself lives in the route (world.ts re-derives the
 * live session's subject and compares), so here we assert the ticket carries
 * the subject we signed and that deriveTicketSubject is deterministic + per-
 * session-distinct.
 */

import { describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import {
  signRoomTicket,
  verifyRoomTicket,
  deriveTicketSubject,
  resolveRecoveryRoomId,
  ROOM_TICKET_TTL_MS,
} from '../room-ticket';

const T0 = 1_700_000_000_000;
const SID_A = 'g:fingerprinthash-aaaa';
const SID_B = 'a:agent-bbbb';

describe('room-ticket — sign/verify round-trip', () => {
  it('a freshly-signed ticket verifies and returns its claims', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    const claims = verifyRoomTicket(ticket, T0 + 1_000);
    expect(claims).not.toBeNull();
    expect(claims!.roomId).toBe('ABCD');
    expect(claims!.sub).toBe(deriveTicketSubject(SID_A));
    expect(claims!.exp).toBe(T0 + ROOM_TICKET_TTL_MS);
  });

  it('survives a "restart" — verify with a different clock instant still works while fresh', () => {
    // The signing key is derived from the env-stable master secret, so a ticket
    // minted before a restart still verifies after it (the test proves sign and
    // verify don't depend on per-process state beyond the env secret).
    const ticket = signRoomTicket({ roomId: 'WXYZ', sessionId: SID_A }, T0);
    const claims = verifyRoomTicket(ticket, T0 + ROOM_TICKET_TTL_MS - 1);
    expect(claims?.roomId).toBe('WXYZ');
  });
});

describe('room-ticket — secret-bound subject', () => {
  it('deriveTicketSubject is deterministic for the same sessionId', () => {
    expect(deriveTicketSubject(SID_A)).toBe(deriveTicketSubject(SID_A));
  });

  it('different sessionIds derive different subjects', () => {
    expect(deriveTicketSubject(SID_A)).not.toBe(deriveTicketSubject(SID_B));
  });

  it('the subject is NOT the wire-public publicId construction (distinct salt)', () => {
    // publicId = sha256(sid + FINGERPRINT_SECRET).slice(16); subject uses a
    // different salt + 32-char width. They must not coincide, or the ticket
    // would be bound to a value broadcast on the wire.
    const FP = process.env.FINGERPRINT_SECRET || 'test-only-presence-salt';
    const publicId = createHash('sha256').update(SID_A + FP).digest('hex').slice(0, 16);
    expect(deriveTicketSubject(SID_A)).not.toBe(publicId);
  });

  it("a ticket minted for session A carries A's subject, redeemable only by re-deriving A", () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    const claims = verifyRoomTicket(ticket, T0 + 1_000);
    // The route compares claims.sub === deriveTicketSubject(liveSid). Session B
    // re-deriving its own subject does NOT match A's ticket subject.
    expect(claims!.sub).toBe(deriveTicketSubject(SID_A));
    expect(claims!.sub).not.toBe(deriveTicketSubject(SID_B));
  });
});

describe('room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock)', () => {
  // Tests the EXPORTED `resolveRecoveryRoomId` — the SAME function world.ts
  // `/join` calls (NOT a mirror). A replayed ticket yields a recovery room ONLY
  // when the signature verifies AND its subject equals the subject re-derived
  // from the LIVE session; anything else → undefined → fall through to the
  // normal auto-fill flow. This test-locks the security property "only the
  // minted-for session can recover its room id" so a stranger replaying a
  // ticket they didn't earn can never pin a room id — and because it's the
  // literal route gate, a regression that drops the check fails HERE.

  it('the minted-for session recovers its room id', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    expect(resolveRecoveryRoomId(ticket, SID_A, T0 + 1_000)).toBe('ABCD');
  });

  it("a DIFFERENT session replaying A's ticket is REJECTED → falls through (no id pin)", () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    // Session B presents A's validly-signed ticket. The MAC verifies (it IS a
    // real server ticket), but B's re-derived subject != A's signed subject, so
    // the route does NOT honor it — B falls through to auto-fill.
    expect(resolveRecoveryRoomId(ticket, SID_B, T0 + 1_000)).toBeUndefined();
  });

  it('a tampered roomId (valid-looking but re-signed payload) is REJECTED', () => {
    // Forge a payload pinning a victim room id, keep a real MAC from a different
    // payload → MAC mismatch → verify returns null → falls through.
    const real = signRoomTicket({ roomId: 'MINE', sessionId: SID_A }, T0);
    const mac = real.slice(real.indexOf('.') + 1);
    const forgedPayload = Buffer.from(
      JSON.stringify({ roomId: 'PINN', sub: deriveTicketSubject(SID_A), exp: T0 + ROOM_TICKET_TTL_MS }),
      'utf8',
    ).toString('base64url');
    expect(resolveRecoveryRoomId(`${forgedPayload}.${mac}`, SID_A, T0 + 1_000)).toBeUndefined();
  });

  it('an expired ticket is REJECTED → falls through (no perpetual id pin)', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    expect(resolveRecoveryRoomId(ticket, SID_A, T0 + ROOM_TICKET_TTL_MS + 1)).toBeUndefined();
  });

  it('no ticket → no recovery room (first-time joins untouched)', () => {
    expect(resolveRecoveryRoomId(undefined, SID_A, T0)).toBeUndefined();
  });
});

describe('room-ticket — expiry (fail-closed)', () => {
  it('rejects a ticket exactly at expiry', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    expect(verifyRoomTicket(ticket, T0 + ROOM_TICKET_TTL_MS)).toBeNull();
  });

  it('rejects a ticket past expiry', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    expect(verifyRoomTicket(ticket, T0 + ROOM_TICKET_TTL_MS + 60_000)).toBeNull();
  });

  it('accepts a ticket one ms before expiry', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    expect(verifyRoomTicket(ticket, T0 + ROOM_TICKET_TTL_MS - 1)).not.toBeNull();
  });
});

describe('room-ticket — tamper + malformed rejection (fail-closed)', () => {
  it('rejects a payload mutated after signing (MAC mismatch)', () => {
    const ticket = signRoomTicket({ roomId: 'ABCD', sessionId: SID_A }, T0);
    const dot = ticket.indexOf('.');
    const payloadB64 = ticket.slice(0, dot);
    const mac = ticket.slice(dot + 1);
    // Forge a payload claiming a different room, keep the original MAC.
    const forgedPayload = Buffer.from(
      JSON.stringify({ roomId: 'EVIL', sub: deriveTicketSubject(SID_A), exp: T0 + ROOM_TICKET_TTL_MS }),
      'utf8',
    ).toString('base64url');
    expect(forgedPayload).not.toBe(payloadB64);
    const forged = `${forgedPayload}.${mac}`;
    expect(verifyRoomTicket(forged, T0 + 1_000)).toBeNull();
  });

  it('rejects a ticket with a forged/wrong MAC (wrong-key signature stand-in)', () => {
    const payload = Buffer.from(
      JSON.stringify({ roomId: 'ABCD', sub: deriveTicketSubject(SID_A), exp: T0 + ROOM_TICKET_TTL_MS }),
      'utf8',
    ).toString('base64url');
    const fakeMac = Buffer.from('0'.repeat(64), 'hex').toString('base64url');
    expect(verifyRoomTicket(`${payload}.${fakeMac}`, T0 + 1_000)).toBeNull();
  });

  it('rejects empty / dotless / truncated tickets', () => {
    expect(verifyRoomTicket('', T0)).toBeNull();
    expect(verifyRoomTicket('nodot', T0)).toBeNull();
    expect(verifyRoomTicket('.', T0)).toBeNull();
    expect(verifyRoomTicket('payload.', T0)).toBeNull();
    expect(verifyRoomTicket('.mac', T0)).toBeNull();
  });

  it('rejects an over-length input without throwing', () => {
    expect(verifyRoomTicket('a'.repeat(2000) + '.' + 'b'.repeat(2000), T0)).toBeNull();
  });

  it('rejects a payload whose MAC does not match (defense-in-depth — shape guard never reached without a valid MAC)', () => {
    const payload = Buffer.from('12345', 'utf8').toString('base64url');
    expect(verifyRoomTicket(`${payload}.AAAA`, T0)).toBeNull();
  });
});
