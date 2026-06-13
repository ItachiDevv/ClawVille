/**
 * Partner-signature verification — shared by the cross-world portal
 * (`apps/api/src/routes/portal.ts`) and the Hatcher partner-registration API
 * (`apps/api/src/routes/partner-hatcher.ts`).
 *
 * Inbound partner-signed requests carry `X-<Partner>-Issuer-Pubkey` +
 * `X-<Partner>-Signature` over `sha256(rawBody)`. We compare the presented
 * pubkey against the `PARTNER_PUBKEYS[partnerId]` allowlist from env and
 * verify the ed25519 signature over the EXACT raw body bytes the partner
 * sent (no canonicalization on the inbound side — verify what was received).
 * This mirrors the outbound `signPayload()` scheme in `service-issuer.ts`.
 *
 * Extracted from portal.ts (2026-06-01, Hatcher Phase A) so the Hatcher
 * partner API can reuse the identical primitive instead of duplicating it —
 * one verification implementation, one allowlist parser.
 */

import { createHash } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

/**
 * Parse PARTNER_PUBKEYS env var (JSON: `{"scape":"<base58>","hatcher":"<base58>"}`)
 * into a lookup map keyed by partner id. Returns null if the env var is
 * missing or malformed — callers treat that as "no partners allowed" and 401
 * every inbound signed request.
 */
export function loadPartnerPubkeys(): Record<string, string> | null {
  const raw = process.env.PARTNER_PUBKEYS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export type PartnerSignatureResult =
  | { ok: true; partnerId: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// STAGING-ONLY test partner pubkey (mock-Hatcher pre-ship harness)
// ---------------------------------------------------------------------------
//
// `ALLOW_TEST_PARTNER_PUBKEY` lets the mock-Hatcher client (a generated ed25519
// keypair, NOT Hatcher's real key) drive the LIVE `/api/partner/hatcher/*`
// surface on staging so the full register → spawn → stats path is exercised
// before any real partner traffic. When set to a base58 pubkey it is accepted
// as an ADDITIONAL valid signer FOR THE `hatcher` PARTNER ONLY — it never
// replaces or shadows the real `PARTNER_PUBKEYS.hatcher` entry, and it is inert
// for every other partnerId (e.g. `scape`).
//
// HARD GATE: this is a pre-ship test affordance, NOT a production knob. The env
// name screams TEST; ARCHITECTURE.md documents that it MUST NEVER be set off
// staging. The gate is an EXPLICIT, IMMUTABLE deploy signal — `CLAWVILLE_ENV` —
// NOT a fragile inference off `CORS_ORIGIN` (a comma-list, an unset value, or a
// mis-set value could re-open the test signer on prod). We accept the test key
// ONLY when `CLAWVILLE_ENV === 'staging'`, and if the var is set on ANY other
// env we FAIL BOOT (throw at module load, like `FINGERPRINT_SECRET`) so a
// prod-forbidden var can never run silently inert — it crashes loudly until
// removed. `NODE_ENV` can't be the discriminator (it is 'production' on BOTH
// Coolify boxes), which is exactly why we introduced a dedicated env.
const TEST_PARTNER_ID = 'hatcher';

/**
 * The single explicit-environment gate for the staging-only test signer. Reads
 * the immutable `CLAWVILLE_ENV` deploy signal (set per-box in Coolify) and
 * returns whether the box is allowed to honor `ALLOW_TEST_PARTNER_PUBKEY`. ONLY
 * `'staging'` qualifies — production, an unset value, or any other value does
 * not. This is deliberately a single literal equality (no substring matching, no
 * comma-list parsing) so it cannot be widened by a malformed value the way the
 * old `CORS_ORIGIN` inference could.
 */
function isStagingEnv(): boolean {
  return process.env.CLAWVILLE_ENV === 'staging';
}

/**
 * FAIL-BOOT INVARIANT (auditor hardening, 2026-06-12). Throws at module load if
 * `ALLOW_TEST_PARTNER_PUBKEY` is set while `CLAWVILLE_ENV !== 'staging'`. This
 * converts "never set the test signer off staging" from ops discipline into an
 * invariant the code enforces: a prod box that somehow carries the test-signer
 * var refuses to start at all (mirrors the `FINGERPRINT_SECRET` crash-loud
 * pattern in middleware/fingerprint.ts) instead of running with a silently inert
 * — or, under the old fragile CORS_ORIGIN check, a silently ACTIVE — test
 * signer. A missing/blank var is fine on every env (the override is simply
 * absent). Runs once, at import time, before any request is served.
 */
const RAW_TEST_PARTNER_PUBKEY = process.env.ALLOW_TEST_PARTNER_PUBKEY;
if (RAW_TEST_PARTNER_PUBKEY && RAW_TEST_PARTNER_PUBKEY.trim() && !isStagingEnv()) {
  throw new Error(
    `[partner-signature] ALLOW_TEST_PARTNER_PUBKEY is set but CLAWVILLE_ENV is '${process.env.CLAWVILLE_ENV ?? '(unset)'}', not 'staging'. ` +
      'This var is a STAGING-ONLY pre-ship harness affordance and MUST NEVER be set on production. ' +
      'Unset ALLOW_TEST_PARTNER_PUBKEY on this box (or set CLAWVILLE_ENV=staging if this genuinely IS the staging box).',
  );
}

/**
 * Read + validate the `ALLOW_TEST_PARTNER_PUBKEY` override. Returns the trimmed
 * base58 pubkey only when (a) we are on STAGING (`CLAWVILLE_ENV === 'staging'`)
 * AND (b) it is a syntactically valid 32-byte ed25519 key. A missing / blank /
 * malformed value — OR not being on staging — yields null (the override is
 * simply absent and the real allowlist is untouched). The off-staging case can
 * only be reached if the var is BLANK (a non-blank value off staging fails boot
 * above), so this is a defense-in-depth re-check, not the primary gate.
 * Validating the key here means a typo'd override can never be silently treated
 * as "some opaque allowed value".
 */
function loadTestPartnerPubkey(): string | null {
  const raw = process.env.ALLOW_TEST_PARTNER_PUBKEY;
  if (!raw || !raw.trim()) return null;
  // Belt-and-suspenders: the module-load invariant already crashed boot if the
  // var is set off staging, so this can only be staging here — but re-check so a
  // future refactor that drops the boot throw can never silently honor the key
  // off staging.
  if (!isStagingEnv()) return null;

  const candidate = raw.trim();
  try {
    const decoded = bs58.decode(candidate);
    if (decoded.length !== 32) return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * BOOT-TIME alarm for the staging-only test partner pubkey. Called once from
 * `index.ts` at startup (AFTER the module-load fail-boot invariant above, which
 * already crashes a prod box that carries the var). On staging with a valid key
 * this logs a loud one-line warning that the additive test signer is live —
 * expected during a harness run, and impossible to miss in the logs. A
 * set-but-off-staging box never reaches here (it threw at import); a
 * set-but-malformed key on staging is already inert via the validation path, so
 * no extra alarm is needed.
 */
export function warnIfTestPartnerPubkeyEnabled(): void {
  const testKey = loadTestPartnerPubkey();
  if (testKey) {
    console.warn(
      `[partner-signature] ⚠️  ALLOW_TEST_PARTNER_PUBKEY is SET on staging (CLAWVILLE_ENV=staging) — accepting an ADDITIONAL test signer for partner '${TEST_PARTNER_ID}' (${testKey}). This is a STAGING-ONLY pre-ship harness affordance and MUST NEVER be set on production.`,
    );
  }
}

/**
 * Is `presentedPubkey` an accepted signer for `partnerId`? True when it equals
 * the real `PARTNER_PUBKEYS[partnerId]` allowlist entry, OR — for the `hatcher`
 * partner ONLY — the `ALLOW_TEST_PARTNER_PUBKEY` staging override. The real
 * allowlist value always remains valid; the test key is purely additive and
 * scoped to one partner. `allowlist` is passed in so callers that already
 * loaded it (and need to distinguish "no allowlist at all" → a distinct reason)
 * don't re-parse the env.
 */
function isAllowedPartnerPubkey(
  partnerId: string,
  presentedPubkey: string,
  allowlist: Record<string, string>,
): boolean {
  if (allowlist[partnerId] && presentedPubkey === allowlist[partnerId]) {
    return true;
  }
  if (partnerId === TEST_PARTNER_ID) {
    const testKey = loadTestPartnerPubkey();
    if (testKey && presentedPubkey === testKey) return true;
  }
  return false;
}

/**
 * Verify a partner-signed inbound request. `partnerId` selects the allowlist
 * entry (`PARTNER_PUBKEYS[partnerId]`); the request's
 * `X-<Partner>-Issuer-Pubkey` header MUST equal that entry. The signature is
 * ed25519(sha256(rawBody)). All decoding failures map to a single generic
 * reason so callers can return an opaque 401.
 */
export function verifyPartnerSignature(
  partnerId: string,
  args: {
    pubkeyHeader: string | null;
    signatureHeader: string | null;
    rawBody: string;
  },
): PartnerSignatureResult {
  if (!args.pubkeyHeader || !args.signatureHeader) {
    return { ok: false, reason: 'missing_signature' };
  }
  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };

  // The presented pubkey must match the allowlist entry for THIS partner (or,
  // for hatcher on staging, the additive ALLOW_TEST_PARTNER_PUBKEY override).
  if (!isAllowedPartnerPubkey(partnerId, args.pubkeyHeader, allowlist)) {
    return { ok: false, reason: 'unknown_partner' };
  }

  // Digest MUST be computed over the exact raw body bytes the partner signed;
  // verifying against a re-parsed-then-re-stringified JSON would fail as soon
  // as key order or whitespace differed.
  const digest = createHash('sha256').update(args.rawBody).digest();
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(args.signatureHeader);
    pubBytes = bs58.decode(args.pubkeyHeader);
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return { ok: false, reason: 'bad_signature_length' };
  }
  if (!nacl.sign.detached.verify(new Uint8Array(digest), sigBytes, pubBytes)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, partnerId };
}

/**
 * Freshness window for partner-signed WRITES (POST/PATCH/DELETE). Mirrors the
 * GET window (5 min) but is a SEPARATE constant so the write window can be tuned
 * independently of the read window later (e.g. a tighter write window once we
 * have live traffic) without touching the read path. See
 * `verifyPartnerWriteSignature` below for the full scheme rationale.
 *
 * REPLAY RESIDUAL (SEC-2, tracked — NOT a seen-signature cache). Within this
 * window the SAME signed bytes verify more than once (ed25519 over identical
 * bytes verifies forever). This is an ACCEPTED residual, not a hole, because
 * every partner write is idempotent-by-agentId (register/PATCH upsert the same
 * row, DELETE is a no-op once gone) so a replay produces no NEW effect, and the
 * window matches Hatcher's agreed `authNonceExpirySecs:300` skew ceiling.
 * We deliberately do NOT keep a consumed-signature cache: a cache that rejects
 * an exact re-presentation would falsely 401 a LEGITIMATE client retry after a
 * 400/5xx/dropped-response (the original request never durably succeeded), which
 * is a worse failure than the benign replay it would block (Codex review
 * 2026-06-13). If a FUTURE non-idempotent partner verb is added, it MUST carry
 * proper replay protection AT THAT TIME — a partner-supplied nonce bound into
 * the signed challenge and consumed delete-on-read (mirror `consumeNonce` in
 * auth-challenge.ts), with consumption gated on the route's DURABLE SUCCESS so a
 * retry of a failed request is never mistaken for a replay.
 */
export const PARTNER_WRITE_SIGNATURE_WINDOW_MS = 5 * 60_000;

/**
 * The CANONICAL CHALLENGE a partner must sign for a WRITE (POST/PATCH/DELETE).
 * Newline-joined, fixed field order, domain-separated, so the partner can
 * reproduce it byte-for-byte:
 *
 *   clawville-partner-write\n<METHOD>\n<PATH>\n<UNIX_MS>\n<sha256hex(rawBody)>
 *
 *   - METHOD  uppercased HTTP method (POST / PATCH / DELETE).
 *   - PATH    the request path INCLUDING the leading slash, EXCLUDING the
 *             scheme/host AND the query string (Hono `c.req.path` semantics),
 *             identical to the GET challenge's path field.
 *   - UNIX_MS the millisecond unix timestamp the partner also sends in the
 *             `X-Hatcher-Timestamp` header (decimal digits, no fraction).
 *   - sha256hex(rawBody) the lowercase hex sha256 of the EXACT raw request body
 *             bytes (the empty string hashes to a fixed digest for body-less
 *             DELETEs).
 *
 * Why a write needs all four bindings PLUS a window, even though the write
 * handlers are idempotent by `agentId` (POST upserts, DELETE no-ops if gone):
 * defense in depth before production. The four bindings each close a distinct
 * gap, and the window caps how long a captured-on-the-wire request stays
 * replayable:
 *   - The DOMAIN PREFIX (`clawville-partner-write`, distinct from
 *     `clawville-partner-get`) means a GET signature can NEVER be replayed as a
 *     write and vice-versa, even for the same path/timestamp.
 *   - Binding METHOD + PATH stops a captured POST sig from being replayed as a
 *     PATCH/DELETE, or against a different agent's path (cross-verb,
 *     cross-path replay).
 *   - Binding the body HASH gives body integrity: a captured signature cannot be
 *     reattached to a mutated body.
 *   - Binding the TIMESTAMP + enforcing the window gives replay-window
 *     protection: a captured-on-the-wire request expires after the window
 *     instead of being replayable forever (idempotency alone does not bound how
 *     LONG a captured request stays valid, and a future non-idempotent write
 *     verb would inherit this protection for free).
 */
export function partnerWriteChallenge(args: {
  method: string;
  path: string;
  tsMillis: string;
  rawBody: string;
}): string {
  const bodyHashHex = createHash('sha256').update(args.rawBody).digest('hex');
  return `clawville-partner-write\n${args.method.toUpperCase()}\n${args.path}\n${args.tsMillis}\n${bodyHashHex}`;
}

/**
 * Verify a partner-signed WRITE (POST/PATCH/DELETE). Structurally MIRRORS
 * `verifyPartnerGetSignature`: same ed25519 key + `PARTNER_PUBKEYS[partnerId]`
 * allowlist, same strict timestamp parse + freshness window, same generic
 * failure reasons so callers return an opaque 401. The signed material is
 * `sha256(partnerWriteChallenge(...))` (which itself binds method, path,
 * timestamp, and the body hash) rather than the GET challenge, and the window
 * is the WRITE window so it can be tuned independently.
 *
 * The domain-separated prefix (`clawville-partner-write`) is what makes a write
 * signature unforgeable from a GET signature and vice-versa: even an attacker
 * holding a valid GET signature for the same path/timestamp cannot present it
 * here, because the signed bytes start with a different domain string.
 */
export function verifyPartnerWriteSignature(
  partnerId: string,
  args: {
    method: string;
    path: string;
    tsHeader: string | null;
    pubkeyHeader: string | null;
    sigHeader: string | null;
    rawBody: string;
    nowMs?: number;
  },
): PartnerSignatureResult {
  if (!args.pubkeyHeader || !args.sigHeader || !args.tsHeader) {
    return { ok: false, reason: 'missing_signature' };
  }

  // Timestamp must be a plain integer of milliseconds inside the freshness
  // window. Reject NaN, fractional, negative, stale (past) and early (future)
  // timestamps. `Number.parseInt` would silently accept `"123abc"`, so guard
  // with a strict digits-only test first (identical to the GET path).
  if (!/^\d{1,15}$/.test(args.tsHeader)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const tsMs = Number(args.tsHeader);
  const now = args.nowMs ?? Date.now();
  if (Math.abs(now - tsMs) > PARTNER_WRITE_SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };
  if (!isAllowedPartnerPubkey(partnerId, args.pubkeyHeader, allowlist)) {
    return { ok: false, reason: 'unknown_partner' };
  }

  const challenge = partnerWriteChallenge({
    method: args.method,
    path: args.path,
    tsMillis: args.tsHeader,
    rawBody: args.rawBody,
  });
  const digest = createHash('sha256').update(challenge).digest();
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(args.sigHeader);
    pubBytes = bs58.decode(args.pubkeyHeader);
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return { ok: false, reason: 'bad_signature_length' };
  }
  if (!nacl.sign.detached.verify(new Uint8Array(digest), sigBytes, pubBytes)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, partnerId };
}

/**
 * Freshness window for partner-signed GETs. A GET carries no body to sign, so
 * the signed bytes are a CANONICAL CHALLENGE derived from method + path +
 * timestamp. The signature alone can't prevent replay (the same bytes verify
 * forever), so the timestamp must fall inside this window — past requests
 * expire and clock-skew-from-the-future requests are rejected. 5 min matches
 * Hatcher's `authNonceExpirySecs:300` (plan §1) so both sides agree on skew.
 */
export const PARTNER_GET_SIGNATURE_WINDOW_MS = 5 * 60_000;

/**
 * The CANONICAL CHALLENGE a partner must sign for a GET. Newline-joined,
 * fixed field order, no JSON/whitespace ambiguity, so the partner can
 * reproduce it byte-for-byte:
 *
 *   clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>
 *
 *   - METHOD  uppercased HTTP method (always `GET`).
 *   - PATH    the request path INCLUDING the leading slash, EXCLUDING the
 *             scheme/host AND the query string (e.g.
 *             `/api/partner/hatcher/agents/abc/stats`). The server uses Hono's
 *             `c.req.path`, which is the decoded path with NO query string, so
 *             the partner MUST sign the same path-only value — do not append
 *             `?foo=bar` to the signed material even if the URL carries a query.
 *   - UNIX_MS the millisecond unix timestamp the partner also sends in the
 *             `X-Hatcher-Timestamp` header (decimal digits, no fraction).
 *
 * The domain-separator prefix (`clawville-partner-get`) prevents a GET
 * signature from ever being replayed against a body-signed (POST/PATCH/DELETE)
 * verifier and vice-versa.
 */
export function partnerGetChallenge(args: {
  method: string;
  path: string;
  tsMillis: string;
}): string {
  return `clawville-partner-get\n${args.method.toUpperCase()}\n${args.path}\n${args.tsMillis}`;
}

/**
 * Verify a partner-signed GET. Same ed25519 key + `PARTNER_PUBKEYS[partnerId]`
 * allowlist as the body-signed path, but the signed material is
 * `sha256(partnerGetChallenge(...))` instead of `sha256(rawBody)` and a
 * freshness window gates replay. All failures collapse to a generic reason so
 * callers return an opaque 401.
 */
export function verifyPartnerGetSignature(
  partnerId: string,
  args: {
    method: string;
    path: string;
    tsHeader: string | null;
    pubkeyHeader: string | null;
    sigHeader: string | null;
    nowMs?: number;
  },
): PartnerSignatureResult {
  if (!args.pubkeyHeader || !args.sigHeader || !args.tsHeader) {
    return { ok: false, reason: 'missing_signature' };
  }

  // Timestamp must be a plain integer of milliseconds inside the freshness
  // window. Reject NaN, fractional, negative, stale (past) and early (future)
  // timestamps. `Number.parseInt` would silently accept `"123abc"`, so guard
  // with a strict digits-only test first.
  if (!/^\d{1,15}$/.test(args.tsHeader)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const tsMs = Number(args.tsHeader);
  const now = args.nowMs ?? Date.now();
  if (Math.abs(now - tsMs) > PARTNER_GET_SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };
  if (!isAllowedPartnerPubkey(partnerId, args.pubkeyHeader, allowlist)) {
    return { ok: false, reason: 'unknown_partner' };
  }

  const challenge = partnerGetChallenge({
    method: args.method,
    path: args.path,
    tsMillis: args.tsHeader,
  });
  const digest = createHash('sha256').update(challenge).digest();
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(args.sigHeader);
    pubBytes = bs58.decode(args.pubkeyHeader);
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return { ok: false, reason: 'bad_signature_length' };
  }
  if (!nacl.sign.detached.verify(new Uint8Array(digest), sigBytes, pubBytes)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, partnerId };
}
