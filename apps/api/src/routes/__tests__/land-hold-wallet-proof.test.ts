/**
 * Land hold-wallet OWNERSHIP PROOF — structural + pure-function contract.
 *
 * Founder ruling 2026-08-10: "optional proof is just not proof". Declaring a
 * hold wallet you do not control previously let an account claim hold-door land
 * backed by SOMEONE ELSE'S CLV balance. These tests pin the fail-closed spine:
 * the pubkey-bound verification state (T1), the un-forgeable one-shot
 * grandfather stamp (T2), BOTH claim-hold reads gated on the same tuple (T3),
 * the door-1 nonce store's single-use/cross-account/repoint guards, the bs58
 * length checks before nacl verify (T13), the E5 middleware chain on every
 * verify route (T11), and the untouched rent sweeper (T12).
 *
 * No DATABASE_URL required — the executed DB legs live in
 * `land-hold-wallet-proof-db.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  _expireLandHoldWalletNonceForTest,
  _resetLandHoldWalletNoncesForTest,
  buildLandHoldWalletMessage,
  consumeLandHoldWalletChallenge,
  issueLandHoldWalletChallenge,
} from '../../services/land-hold-wallet-challenge';
import {
  holdWalletProofAccepted,
  holdWalletVerificationState,
} from '../../services/land-tenure-settlement';

const API_SRC = join(import.meta.dir, '..', '..');
const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const service = readFileSync(join(API_SRC, 'services', 'land-tenure-settlement.ts'), 'utf8');
const routes = readFileSync(join(API_SRC, 'routes', 'land.ts'), 'utf8');
const challengeStore = readFileSync(
  join(API_SRC, 'services', 'land-hold-wallet-challenge.ts'),
  'utf8',
);
const sweeper = readFileSync(join(API_SRC, 'services', 'land-rent-sweeper.ts'), 'utf8');
const verifyService = readFileSync(
  join(API_SRC, 'services', 'land-hold-transfer-verify.ts'),
  'utf8',
);
const protocol = readFileSync(join(API_SRC, 'services', 'skill-protocol.ts'), 'utf8');
const MIGRATIONS = join(ROOT, 'packages', 'database', 'migrations');
const migration = readFileSync(join(MIGRATIONS, '0060_land_hold_wallet_proof.sql'), 'utf8');
const enumMigration = readFileSync(join(MIGRATIONS, '0060a_land_hold_verify_purpose.sql'), 'utf8');
const singletonMigration = readFileSync(
  join(MIGRATIONS, '0060b_land_hold_verify_wallet_singleton.sql'),
  'utf8',
);
const usersSchema = readFileSync(
  join(ROOT, 'packages', 'database', 'src', 'schema', 'users.ts'),
  'utf8',
);
const challengeSchema = readFileSync(
  join(ROOT, 'packages', 'database', 'src', 'schema', 'land-hold-verify.ts'),
  'utf8',
);

const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const OTHER_ACCOUNT = '99999999-8888-7777-6666-555555555555';

function walletKeypair(): { pubkey: string; secret: Uint8Array } {
  const pair = nacl.sign.keyPair();
  return { pubkey: bs58.encode(pair.publicKey), secret: pair.secretKey };
}

function sign(message: string, secret: Uint8Array): Uint8Array {
  return nacl.sign.detached(new TextEncoder().encode(message), secret);
}

/** SQL with every `--` comment line removed, so an assertion about STATEMENTS is
 *  not satisfied (or defeated) by prose in a comment. */
function statementsOf(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function verify(message: string, signature: Uint8Array, pubkey: string): boolean {
  return nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    signature,
    bs58.decode(pubkey),
  );
}

describe('door 1 — hold-wallet challenge store', () => {
  beforeEach(() => _resetLandHoldWalletNoncesForTest());

  it('issues the frozen four-line message bound to BOTH the account and the wallet', () => {
    const wallet = walletKeypair().pubkey;
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet);
    expect(issued.walletAddress).toBe(wallet);
    expect(issued.messageToSign).toBe(
      `ClawVille land hold wallet\naccount: ${ACCOUNT}\nwallet: ${wallet}\nnonce: ${issued.nonce}`,
    );
    // The account line kills the phished blind-signature redirect; the wallet
    // line kills a repoint-then-replay.
    expect(issued.messageToSign.split('\n')).toHaveLength(4);
    expect(bs58.decode(issued.nonce)).toHaveLength(32);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('consumes a nonce exactly once — a replay is refused', () => {
    const wallet = walletKeypair().pubkey;
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet);
    expect(consumeLandHoldWalletChallenge(issued.nonce, ACCOUNT, wallet)).toBe(true);
    expect(consumeLandHoldWalletChallenge(issued.nonce, ACCOUNT, wallet)).toBe(false);
  });

  it('refuses a nonce presented by a different account (cross-account replay)', () => {
    const wallet = walletKeypair().pubkey;
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet);
    expect(consumeLandHoldWalletChallenge(issued.nonce, OTHER_ACCOUNT, wallet)).toBe(false);
    // Burned on the mismatched read too, so a leaked nonce cannot be probed twice.
    expect(consumeLandHoldWalletChallenge(issued.nonce, ACCOUNT, wallet)).toBe(false);
  });

  it('refuses a nonce presented for a different declared wallet (repoint replay)', () => {
    const wallet = walletKeypair().pubkey;
    const repointed = walletKeypair().pubkey;
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet);
    expect(consumeLandHoldWalletChallenge(issued.nonce, ACCOUNT, repointed)).toBe(false);
  });

  it('refuses an expired nonce', () => {
    const wallet = walletKeypair().pubkey;
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet);
    expect(_expireLandHoldWalletNonceForTest(issued.nonce)).toBe(true);
    expect(consumeLandHoldWalletChallenge(issued.nonce, ACCOUNT, wallet)).toBe(false);
  });

  it('refuses an unknown nonce', () => {
    const wallet = walletKeypair().pubkey;
    expect(consumeLandHoldWalletChallenge(bs58.encode(new Uint8Array(32)), ACCOUNT, wallet)).toBe(
      false,
    );
  });

  it('keeps the 120s TTL, the size cap and the unref-d janitor of the wallet-link sibling', () => {
    expect(challengeStore).toContain('const NONCE_TTL_MS = 120 * 1000');
    expect(challengeStore).toContain('const MAX_NONCES = 10_000');
    expect(challengeStore).toContain('cleanupTimer.unref?.()');
  });
});

describe('door 1 — ed25519 proof over the exact message bytes', () => {
  beforeEach(() => _resetLandHoldWalletNoncesForTest());

  it('verifies a real signature made by the declared wallet', () => {
    const wallet = walletKeypair();
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet.pubkey);
    const signature = sign(issued.messageToSign, wallet.secret);
    expect(signature).toHaveLength(64);
    expect(
      verify(
        buildLandHoldWalletMessage(ACCOUNT, wallet.pubkey, issued.nonce),
        signature,
        wallet.pubkey,
      ),
    ).toBe(true);
  });

  it('rejects a signature produced by a different signer (wrong-signer)', () => {
    const declared = walletKeypair();
    const attacker = walletKeypair();
    const issued = issueLandHoldWalletChallenge(ACCOUNT, declared.pubkey);
    const forged = sign(issued.messageToSign, attacker.secret);
    expect(verify(issued.messageToSign, forged, declared.pubkey)).toBe(false);
  });

  it('rejects a signature over a message naming a different account', () => {
    const wallet = walletKeypair();
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet.pubkey);
    const phished = sign(
      buildLandHoldWalletMessage(OTHER_ACCOUNT, wallet.pubkey, issued.nonce),
      wallet.secret,
    );
    expect(verify(issued.messageToSign, phished, wallet.pubkey)).toBe(false);
  });

  it('rejects a signature over a message naming a different wallet', () => {
    const wallet = walletKeypair();
    const other = walletKeypair();
    const issued = issueLandHoldWalletChallenge(ACCOUNT, wallet.pubkey);
    const wrongWallet = sign(
      buildLandHoldWalletMessage(ACCOUNT, other.pubkey, issued.nonce),
      wallet.secret,
    );
    expect(verify(issued.messageToSign, wrongWallet, wallet.pubkey)).toBe(false);
  });
});

describe('trap T1 — verification is PUBKEY-BOUND, never row-bound', () => {
  const A = 'AwalletAwalletAwalletAwalletAwalletAwallet';
  const B = 'BwalletBwalletBwalletBwalletBwalletBwallet';

  it('treats a proof for a DIFFERENT pubkey as unverified (declare-A verify-A change-to-B)', () => {
    const proof = {
      declaredWallet: B,
      verifiedPubkey: A,
      verifiedMethod: 'signature',
      grandfatheredPubkey: null,
    };
    expect(holdWalletVerificationState(proof)).toBe('unverified');
    expect(holdWalletProofAccepted(proof)).toBe(false);
  });

  it('reports verified only when the proven pubkey IS the declared pubkey', () => {
    expect(
      holdWalletVerificationState({
        declaredWallet: A,
        verifiedPubkey: A,
        verifiedMethod: 'signature',
        grandfatheredPubkey: null,
      }),
    ).toBe('verified');
  });

  it('reports grandfathered only when the one-shot stamp IS the declared pubkey', () => {
    expect(
      holdWalletVerificationState({
        declaredWallet: A,
        verifiedPubkey: null,
        verifiedMethod: null,
        grandfatheredPubkey: A,
      }),
    ).toBe('grandfathered');
    expect(
      holdWalletVerificationState({
        declaredWallet: B,
        verifiedPubkey: null,
        verifiedMethod: null,
        grandfatheredPubkey: A,
      }),
    ).toBe('unverified');
  });

  it('is unverified with no declaration at all, whatever the other columns say', () => {
    expect(
      holdWalletVerificationState({
        declaredWallet: null,
        verifiedPubkey: A,
        verifiedMethod: 'transfer',
        grandfatheredPubkey: A,
      }),
    ).toBe('unverified');
  });

  it('prefers a real proof over the grandfather stamp', () => {
    expect(
      holdWalletVerificationState({
        declaredWallet: A,
        verifiedPubkey: A,
        verifiedMethod: 'custodial',
        grandfatheredPubkey: A,
      }),
    ).toBe('verified');
  });
});

describe('trap T3 — BOTH claim-hold reads are gated on the same proof tuple', () => {
  it('gates the pre-transaction read and throws wallet_not_verified', () => {
    expect(service).toContain(
      'const declaredRows = await db.execute<HoldWalletProofRow>(',
    );
    expect(service).toContain("proofState = holdWalletVerificationState(declaredProof)");
    // Both gates run the SAME predicate, so `grandfathered` can never open one
    // gate and close the other.
    expect(service).toContain('if (!holdWalletProofAccepted(declaredProof))');
    expect(service).toContain("new LandTenureSettlementError('wallet_not_verified', 403");
  });

  it('re-reads the SAME tuple under FOR SHARE inside the transaction', () => {
    expect(service).toContain('const walletRows = await tx.execute<HoldWalletProofRow>(');
    expect(service).toContain('FOR SHARE');
    expect(service).toContain('!sameProof(currentProof, declaredProof)');
    expect(service).toContain('if (!holdWalletProofAccepted(currentProof))');
  });

  it('reads one shared column list so the two gates can never drift apart', () => {
    const uses = service.split('${HOLD_WALLET_PROOF_COLUMNS}').length - 1;
    expect(uses).toBeGreaterThanOrEqual(3);
  });

  it('keeps wallet_not_declared ahead of the verification gate', () => {
    const declaredAt = service.indexOf("throw new LandTenureSettlementError('wallet_not_declared', 403)");
    const verifiedAt = service.indexOf("proofState = holdWalletVerificationState(declaredProof)");
    expect(declaredAt).toBeGreaterThan(-1);
    expect(verifiedAt).toBeGreaterThan(declaredAt);
  });
});

describe('traps T1 + T2 — a declaration change destroys the proof', () => {
  it('nulls the verification tuple AND the grandfather stamp in the repoint UPDATE', () => {
    const update = service.slice(
      service.indexOf('SET land_hold_wallet_pubkey = ${canonicalWallet}'),
    );
    const statement = update.slice(0, update.indexOf('WHERE id = ${identity.userId}'));
    expect(statement).toContain('land_hold_wallet_verified_at = NULL');
    expect(statement).toContain('land_hold_wallet_verified_method = NULL');
    expect(statement).toContain('land_hold_wallet_verified_pubkey = NULL');
    expect(statement).toContain('land_hold_wallet_grandfathered_pubkey = NULL');
  });

  it('never writes a NON-NULL grandfather value anywhere in the API source', () => {
    const files = readdirSync(API_SRC, { recursive: true })
      .filter(
        (entry): entry is string =>
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          // Skip test sources — they QUOTE the SQL they assert on.
          !entry.includes('__tests__') &&
          !entry.endsWith('.test.ts'),
      )
      .map((entry) => join(API_SRC, entry));
    const assignments: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /land_hold_wallet_grandfathered_pubkey\s*=\s*([^,\n]+)/g,
      )) {
        assignments.push(`${file}: ${match[1]!.trim()}`);
      }
    }
    // Only ever NULLed — the stamp itself is migration-only (T2).
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment.endsWith('NULL')).toBe(true);
    }
  });

  it('only reaches the clearing UPDATE on an actual change, never on a re-declare', () => {
    expect(service).toContain('if (current === canonicalWallet)');
    expect(service).toContain('firstDeclaration: false, changed: false');
  });
});

describe('migration 0060 — schema contract', () => {
  it('adds the four proof columns to users', () => {
    for (const column of [
      'land_hold_wallet_verified_at',
      'land_hold_wallet_verified_method',
      'land_hold_wallet_verified_pubkey',
      'land_hold_wallet_grandfathered_pubkey',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
      expect(usersSchema).toContain(`'${column}'`);
    }
  });

  it('constrains the method vocabulary and the all-or-nothing verification tuple', () => {
    expect(migration).toContain("IN ('signature', 'transfer', 'custodial')");
    expect(migration).toContain('users_land_hold_wallet_verified_shape');
    expect(usersSchema).toContain('users_land_hold_wallet_verified_method_valid');
    expect(usersSchema).toContain('users_land_hold_wallet_verified_shape');
  });

  it('stamps the grandfather column ONCE against a HARD-CODED literal cutoff (T2)', () => {
    const stamp = migration.slice(
      migration.indexOf('SET "land_hold_wallet_grandfathered_pubkey"'),
    );
    expect(stamp).toContain("TIMESTAMPTZ '2026-08-10 00:00:00+00'");
    expect(stamp).toContain('"land_hold_wallet_grandfathered_pubkey" IS NULL');
    expect(stamp).toContain('"land_hold_wallet_pubkey" IS NOT NULL');
    // A fresh declare stamps declared_at = now() >= the cutoff, so a re-run can
    // never capture a post-migration declaration.
    expect(stamp).toContain('"land_hold_wallet_declared_at" < TIMESTAMPTZ');
    expect(stamp).not.toContain('now()');
    expect(stamp).not.toContain('verified_pubkey" IS NULL');
  });

  it('makes pending challenge amounts unique so attribution cannot collide (T6)', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_pending_lamports_unique"',
    );
    expect(migration).toContain(`WHERE "status" = 'pending'`);
    expect(challengeSchema).toContain(
      'land_hold_wallet_transfer_challenges_pending_lamports_unique',
    );
  });

  it('lets one inbound signature satisfy at most one challenge (T7)', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_inbound_signature_unique"',
    );
    expect(migration).toContain('WHERE "inbound_signature" IS NOT NULL');
  });

  it('pairs the refund claim lease columns like the gas sponsor does', () => {
    expect(migration).toContain(
      'CHECK (("refund_claim_id" IS NULL) = ("refund_claimed_at" IS NULL))',
    );
    expect(challengeSchema).toContain(
      'land_hold_wallet_transfer_challenges_refund_claim_lease_pair',
    );
  });

  it('bounds the status and refund_state vocabularies', () => {
    expect(migration).toContain(
      `CHECK ("status" IN ('pending', 'observed', 'verified', 'expired', 'failed',
                        'rejected', 'unclaimed'))`,
    );
    expect(migration).toContain(`'none', 'sending', 'sent', 'reconcile', 'skipped'`);
    expect(migration).toContain('CHECK ("lamports" > 0)');
  });

  it('carries the rejected-reason vocabulary and its all-or-nothing pairing', () => {
    // An EXACT-amount inbound that cannot be proof (no memo naming the
    // challenge, or a program signing for the source) is still attributed so
    // the money is refunded, and the reason is what the UI turns into a
    // sentence instead of a silent wait.
    expect(migration).toContain(`"rejected_reason" varchar(32)`);
    expect(migration).toContain(
      `IN ('memo_missing', 'source_not_signer', 'transfer_not_top_level')`,
    );
    expect(migration).toContain(
      `CHECK (("status" = 'rejected') = ("rejected_reason" IS NOT NULL))`,
    );
    expect(challengeSchema).toContain(
      'land_hold_wallet_transfer_challenges_rejected_reason_valid',
    );
    expect(challengeSchema).toContain(
      'land_hold_wallet_transfer_challenges_rejected_reason_pair',
    );
  });

  it('records refund obligations durably, so an alert is never the only record', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "land_hold_wallet_refund_obligations"',
    );
    expect(migration).toContain(
      `CHECK ("reason" IN ('retained_leg', 'destination_rotated', 'unclaimed_inbound'))`,
    );
    // One claim per (signature, recipient, reason): re-observing the same
    // retained funds must never create a second claim on the same money.
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_refund_obligations_unique"',
    );
    expect(challengeSchema).toContain('landHoldWalletRefundObligations');
    expect(verifyService).toContain('export function retainedLegObligations(');
    expect(verifyService).toContain('async function discoverUnclaimedInbound(');
    // Written in the SAME transaction as the attribution, so a crash between the
    // two can never leave an alert as the only record of retained funds.
    const attribute = verifyService.slice(
      verifyService.indexOf('async attributeInbound({'),
      verifyService.indexOf('async grantVerification('),
    );
    expect(attribute).toContain('INSERT INTO land_hold_wallet_refund_obligations');
    expect(attribute).toContain(
      'ON CONFLICT (destination_pubkey, signature, recipient_pubkey, reason) DO NOTHING',
    );
    // The same funds can never be owed twice, and the void is DESTINATION-scoped
    // so it cannot erase a debt belonging to a different verify address.
    expect(attribute).toContain("SET state = 'void'");
    expect(attribute).toContain('WHERE destination_pubkey = ${destination}');
    // A deposit an operator already settled by hand never re-enters the queue.
    expect(attribute).toContain("AND state = 'settled'");
    expect(attribute).toContain("SET refund_state = 'reconcile'");
  });

  it('DISCOVERS a retired-destination debt from the parsed transaction (round 6)', () => {
    // Attribution consumes a signature globally, so a leg paid to a different
    // verify address of ours would never be looked at again. The parsed
    // transaction is already in hand, so the debt is derived there.
    expect(verifyService).toContain('export function rotatedDestinationObligations(');
    expect(verifyService).toContain('async function knownVerifyDestinations(');
    expect(verifyService).toContain('listVerifyDestinations(): Promise<string[]>;');
    // Facts keep legs to ANY known verify address, each with its own
    // destination, so the sweep can see the retired leg too.
    const factsFn = verifyService.slice(
      verifyService.indexOf('export function scanFactsOf('),
      verifyService.indexOf('/** Re-inflate stored facts'),
    );
    expect(factsFn).toContain('destinations.has(t.destination)');
    expect(factsFn).toContain('destination: t.destination,');
    // Both attribution paths feed it into the SAME atomic obligation write.
    // Exactly twice: the definition, and the ONE in-transaction derivation.
    // Callers hand over raw legs, so none of them can supply a stale set.
    expect((verifyService.match(/rotatedDestinationObligations\(/g) ?? []).length).toBe(2);
  });

  it('writes the rotated-destination obligation atomically with the terminalize', () => {
    // `skipped` money is still owed, and refundable selection requires
    // refund_state='none', so a separate write that failed lost the debt with
    // nothing able to retry it.
    const finish = verifyService.slice(
      verifyService.indexOf('async finishRefund({'),
      verifyService.indexOf('async releaseRefundClaim('),
    );
    expect(finish).toContain('db.transaction');
    expect(finish).toContain('INSERT INTO land_hold_wallet_refund_obligations');
    const rotated = verifyService.slice(
      verifyService.indexOf('const rotatedObligation: RefundObligationInput'),
    );
    expect(rotated).toContain('obligations: [rotatedObligation]');
  });

  it('never lets the scan terminalize a challenge that is still open (round 4)', () => {
    expect(verifyService).toContain('const UNCLAIMED_CLOSED_MARGIN_MS');
    // Enforced in SQL under the per-user lock, not merely in the batch query.
    const attribute = verifyService.slice(
      verifyService.indexOf('async attributeInbound({'),
      verifyService.indexOf('async grantVerification('),
    );
    expect(attribute).toContain('pg_advisory_xact_lock');
    expect(attribute).toContain('AND expires_at <= now() - (${onlyIfClosedForMs}');
    // ...and the batch query agrees.
    const list = verifyService.slice(
      verifyService.indexOf('async listScannableChallenges('),
      verifyService.indexOf('async listGrantableChallenges('),
    );
    expect(list).toContain('AND expires_at <= now() - (${closedForMs}');
  });

  it('derives the orphan threshold from the TTL, never a standalone constant', () => {
    expect(verifyService).toContain('export function landHoldVerifyOrphanThresholdMs()');
    expect(verifyService).toContain(
      'return landHoldVerifyTtlMs() + LATE_ARRIVAL_GRACE_MS + UNCLAIMED_CLOSED_MARGIN_MS;',
    );
    expect(verifyService).toContain('const cutoffMs = now - landHoldVerifyOrphanThresholdMs();');
  });

  it('documents the best-effort orphan-discovery limitation with a FEATURE_GATE', () => {
    expect(verifyService).toContain('FEATURE_GATE: land_hold_verify_orphan_discovery');
    expect(verifyService).toContain('Review deadline: 2026-10-01');
    expect(verifyService).toContain('BEST-EFFORT');
    expect(verifyService).toContain('durable scan cursor');
    expect(verifyService).toContain('distributed sweeper lease');
    expect(verifyService).toContain('PROCESS-LOCAL (`sweepInFlight`)');
    expect(verifyService).toContain('WRITTEN but never READ');
    // The same limitation is stated in the canonical doc, not only in code.
    const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    expect(architecture).toContain('land_hold_verify_orphan_discovery');
    expect(architecture).toContain('durable scan cursor');
  });

  it('does not claim recoverability we cannot guarantee (round 5)', () => {
    // "recoverable manually at any time" is only true while we still hold the
    // key of the destination that was paid. This diff implements no archival or
    // rotation policy, so the claim is stated as an OPERATIONAL obligation.
    const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    for (const text of [verifyService, architecture]) {
      expect(text).not.toContain('recoverable manually at any time');
      expect(text).not.toContain('NO FUNDS ARE EVER LOST');
      expect(text).toContain('OPERATIONAL OBLIGATION');
      expect(text).toContain("private key");
    }
    // ROUND 7: the schema now SUPPORTS the obligation instead of forbidding it.
    // An unscoped singleton allowed at most one such row ever, so an operator
    // told to keep the previous one literally could not comply.
    expect(verifyService).toContain('never deleted,');
    expect(verifyService).toContain('`treasury_wallets.retired_at`');
    expect(singletonMigration).toContain("retired_at IS NULL");
    const treasurySchema = readFileSync(
      join(ROOT, 'packages', 'database', 'src', 'schema', 'treasury.ts'),
      'utf8',
    );
    expect(treasurySchema).toContain("retiredAt: timestamp('retired_at'");
    expect(treasurySchema).toContain("purpose = 'land-hold-verify' AND retired_at IS NULL");
  });

  it('never promises a guaranteed refund on the three knowledge surfaces (round 5)', () => {
    // The gate says discovery is best-effort. A human- or agent-facing surface
    // must not promise the opposite.
    /** The land-verify section of a shared document, not the whole file. */
    const section = (text: string, from: string, to: string): string => {
      const start = text.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      const end = text.indexOf(to, start + from.length);
      return text.slice(start, end > start ? end : undefined);
    };

    const surfaces: Array<[string, string]> = [
      [
        'GameFeatures.md',
        section(
          readFileSync(join(ROOT, 'GameFeatures.md'), 'utf8'),
          'Land tenure',
          '**Prior Last Audited:',
        ),
      ],
      [
        'skill-protocol.ts',
        section(protocol, '### Verify the hold wallet before claiming', 'Release requires a fresh'),
      ],
      [
        'town-guide.ts',
        section(
          readFileSync(
            join(ROOT, 'packages', 'agent-templates', 'src', 'locations', 'town-guide.ts'),
            'utf8',
          ),
          'Land in ClawVille uses two doors',
          'Once you hold or rent a parcel',
        ),
      ],
      // ROUND 7: the UI is a user-facing surface too, and was previously only
      // spot-checked for the word "support".
      [
        'tenure-office-panels.tsx',
        section(
          readFileSync(
            join(
              ROOT,
              'apps',
              'web',
              'src',
              'components',
              'game',
              'land',
              'tenure-office-panels.tsx',
            ),
            'utf8',
          ),
          'const TRANSFER_STATE_COPY',
          'function WalletDeclaration',
        ),
      ],
    ];
    // The CLASS of unconditional promise, not one string. A caveat three
    // paragraphs later does not undo a flat promise in a headline, so every one
    // of these shapes is banned outright wherever a user or agent can read it.
    const UNCONDITIONAL_PROMISES: Array<[string, RegExp]> = [
      ['guaranteed discovery', /we still find it and send it back/i],
      ['guaranteed sweep refund', /still finds the money and REFUNDS it/i],
      ['unconditional auto-refund', /refunded automatically/i],
      ['unconditional return', /sen[dt] (?:it |the amount )?straight back/i],
      ['unconditional settle-refund', /automatically once it settles/i],
      ['guarantee verb', /guarantees both the verification/i],
      ['open-ended support promise', /whenever you ask/i],
      ['always/never absolutes', /\b(?:always|never) (?:refund|return)(?:ed|s)?\b/i],
    ];

    for (const [name, text] of surfaces) {
      const lower = text.toLowerCase();
      for (const [label, pattern] of UNCONDITIONAL_PROMISES) {
        expect({ [`${name}: ${label}`]: pattern.test(text) }).toEqual({
          [`${name}: ${label}`]: false,
        });
      }
      // ...and each surface now names the reliable path, the best-effort caveat,
      // and the fallback.
      expect({ [name]: lower.includes('reliable path') }).toEqual({ [name]: true });
      expect({
        [name]: lower.includes('best effort') || lower.includes('best-effort'),
      }).toEqual({ [name]: true });
      expect({ [name]: lower.includes('support') }).toEqual({ [name]: true });
      // ROUND 6: recovery is qualified on us holding the destination's key, the
      // same qualification the internal docs carry. No unconditional promise.
      expect({ [name]: lower.includes('whenever you ask') }).toEqual({ [name]: false });
      expect({ [name]: lower.includes('keep the keys') }).toEqual({ [name]: true });
      // ROUND 7: the refund can legitimately defer under the fee cap or be held
      // at `reconcile`, so no surface may call it guaranteed.
      expect({ [name]: lower.includes('guarantees both the verification') }).toEqual({
        [name]: false,
      });
      expect({
        [name]: lower.includes('usually automatic') || lower.includes('once in a while'),
      }).toEqual({ [name]: true });
    }
  });

  it('never records TRUNCATED scan facts (round 3)', () => {
    // Truncating dropped a qualifying 33rd leg, falsely rejected a correct memo
    // after 8 earlier ones, and under-refunded past 32 same-sender legs.
    const facts = verifyService.slice(
      verifyService.indexOf('export function scanFactsOf('),
      verifyService.indexOf('/** Re-inflate stored facts'),
    );
    expect(facts).toContain('): ScanFacts | null {');
    expect(facts).toContain('return null;');
    expect(facts).not.toContain('.slice(0, SCAN_FACT_MAX');
    expect(verifyService).toContain('too large to record whole');
  });

  it('never CASCADES a user delete over the live money ledger (H9)', () => {
    // Cascading an account deletion mid-processing would strand inbound SOL at
    // the verify address AND destroy the audit trail proving we owe it back.
    const table = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS "land_hold_wallet_transfer_challenges"'),
      migration.indexOf('CREATE UNIQUE INDEX'),
    );
    expect(table).toContain('REFERENCES "users"("id") ON DELETE RESTRICT');
    expect(table).not.toContain('ON DELETE CASCADE');
    expect(challengeSchema).toContain("onDelete: 'restrict'");
    expect(challengeSchema).not.toContain("onDelete: 'cascade'");
  });

  it('makes refund signatures unique and records the received total (B4 + B5)', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "land_hold_wallet_transfer_challenges_refund_signature_unique"',
    );
    expect(migration).toContain('"inbound_lamports" bigint');
    expect(migration).toContain(
      'CHECK ("inbound_lamports" IS NULL OR "inbound_lamports" > 0)',
    );
    expect(challengeSchema).toContain(
      'land_hold_wallet_transfer_challenges_refund_signature_unique',
    );
    expect(challengeSchema).toContain("bigint('inbound_lamports'");
  });

  it('stamps an immutable refund authorization window + cap policy (B2)', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "land_hold_verify_cap_policies"');
    expect(migration).toContain('"cap_day" date PRIMARY KEY');
    expect(migration).toContain('"refund_cap_day" date');
    expect(migration).toContain('"refund_cap_lamports" bigint');
    expect(migration).toContain('"refund_authorized_at" timestamptz');
    // All-or-nothing, like the users verification tuple.
    expect(migration).toContain(
      'CONSTRAINT "land_hold_wallet_transfer_challenges_refund_cap_stamp"',
    );
    expect(challengeSchema).toContain('landHoldVerifyCapPolicies');
    // Spend is summed over the authorization stamp, never over row creation.
    expect(verifyService).toContain('WHERE refund_cap_day = ${capDay}::date');
    expect(verifyService).not.toContain("WHERE created_at > now() - interval '24 hours'");
  });

  it('keeps a durable scan ledger with parsed FACTS, not a bare seen flag (B3)', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "land_hold_wallet_verify_scans"');
    expect(migration).toContain('"facts" jsonb NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "land_hold_wallet_verify_scans_destination_block_time_idx"',
    );
    expect(challengeSchema).toContain('landHoldWalletVerifyScans');
    // Cursor pagination, not a single newest page.
    expect(verifyService).toContain('before ? { limit: SCAN_SIGNATURE_LIMIT, before }');
    expect(verifyService).toContain('SCAN_MAX_PAGES');
  });

  it('binds every terminal refund transition to its owner (H8)', () => {
    const finish = verifyService.slice(
      verifyService.indexOf('async finishRefund('),
      verifyService.indexOf('async releaseRefundClaim('),
    );
    expect(finish).toContain('refund_signature = ${signature}');
    expect(finish).toContain('refund_claim_id = ${claimId}::uuid');
    expect(finish).toContain('requires either a claimId or the captured signature');
  });

  it('requires a confirmed commitment before a refund is called paid (H7)', () => {
    expect(verifyService).toContain('function isTerminallyConfirmed(');
    expect(verifyService).toContain(
      "confirmationStatus === 'confirmed' || confirmationStatus === 'finalized'",
    );
  });

  it('proves the verify signer can sign AND pay before opening the door (H6)', () => {
    expect(verifyService).toContain('async function verifySignerReadiness(');
    expect(verifyService).toContain('VERIFY_WALLET_MIN_FLOAT_LAMPORTS');
    expect(verifyService).toContain("reason: 'pubkey_mismatch'");
    expect(verifyService).toContain("reason: 'insufficient_float'");
  });

  it('accepts ONLY a top-level memo and a top-level paying leg as proof (B1)', () => {
    const memoPredicate = verifyService.slice(
      verifyService.indexOf('export function transactionCarriesChallengeMemo('),
      verifyService.indexOf('export function transactionSettlesChallenge('),
    );
    expect(memoPredicate).toContain('memo.topLevel &&');
    expect(verifyService).toContain('export function transactionHasTopLevelTransferLeg(');
    const settles = verifyService.slice(
      verifyService.indexOf('export function transactionSettlesChallenge('),
    );
    expect(settles).toContain('transactionHasTopLevelTransferLeg(probe, params)');
  });

  it('reserves an amount while a lapsed row is still being scanned for it', () => {
    // Expiring a lapsed row frees its amount for the partial unique index while
    // the sweeper keeps watching for a late arrival. Re-issuing that amount
    // would let the OLDER row win the single-signature binding and leave the
    // NEWER user refunded but unverified.
    expect(verifyService).toContain('WHERE NOT EXISTS (');
    expect(verifyService).toContain("AND status IN ('pending', 'expired')");
    expect(verifyService).toContain('AND inbound_signature IS NULL');
  });

  it('keeps the treasury enum value ALONE in its own file and the index after it', () => {
    // migrate-ci: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
    expect(enumMigration).toContain(
      "ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'land-hold-verify';",
    );
    expect(enumMigration.match(/;/g) ?? []).toHaveLength(1);
    // 0060 must carry no ENUM statement and must not USE the new value (only its
    // comments may mention it) — the value is unusable until 0060a commits.
    expect(statementsOf(migration)).not.toContain('ALTER TYPE');
    expect(statementsOf(migration)).not.toContain('land-hold-verify');
    expect(singletonMigration).toContain('treasury_wallets_land_hold_verify_singleton');
    expect('0060_land_hold_wallet_proof.sql' < '0060a_land_hold_verify_purpose.sql').toBe(true);
    expect('0060a_land_hold_verify_purpose.sql' < '0060b_land_hold_verify_wallet_singleton.sql')
      .toBe(true);
  });

  it('is idempotent DDL throughout', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "land_hold_wallet_transfer_challenges"');
    expect(migration.includes('DROP TABLE')).toBe(false);
    expect(migration.includes('DROP COLUMN')).toBe(false);
  });
});

describe('trap T11 — E5 parity on every verify route', () => {
  const VERIFY_ROUTES = [
    "'/hold-wallet/verify/challenge'",
    "'/hold-wallet/verify/signature'",
    "'/hold-wallet/verify/custodial'",
    "'/hold-wallet/verify/transfer/challenge'",
    "'/hold-wallet/verify/transfer/:challengeId/submit'",
    "'/hold-wallet/verify/transfer/:challengeId'",
  ];

  it('registers all six routes, including signature submission', () => {
    for (const route of VERIFY_ROUTES) expect(routes).toContain(route);
  });

  it('runs the identical identity chain the declaration routes use', () => {
    for (const route of VERIFY_ROUTES) {
      const start = routes.indexOf(route);
      expect(start).toBeGreaterThan(-1);
      const handler = routes.slice(start, start + 400);
      expect(handler).toContain('requireAuthOrAgentSession');
      expect(handler).toContain('requireLedgerCapableIdentity');
      expect(handler).toContain('requireNonGuestIdentity');
    }
  });

  it('resolves the acting account from the middleware identity, never from the body', () => {
    for (const route of VERIFY_ROUTES) {
      const start = routes.indexOf(route);
      const handler = routes.slice(start, start + 900);
      expect(handler).toContain("c.get('identity')");
    }
  });
});

describe('verify-route input hardening', () => {
  it('uses a strict body schema that never carries a wallet pubkey', () => {
    expect(routes).toContain('const holdWalletVerifySignatureBodySchema = z');
    const schema = routes.slice(
      routes.indexOf('const holdWalletVerifySignatureBodySchema = z'),
      routes.indexOf('const challengeIdSchema'),
    );
    expect(schema).toContain('.strict()');
    expect(schema).toContain('nonce:');
    expect(schema).toContain('signature:');
    expect(schema).not.toContain('walletAddress');
    expect(schema).not.toContain('walletPubkey');
  });

  it('length-checks the bs58 pubkey and signature BEFORE nacl verify (T13)', () => {
    const handler = routes.slice(
      routes.indexOf("'/hold-wallet/verify/signature'"),
      routes.indexOf("'/hold-wallet/verify/custodial'"),
    );
    const decodeAt = handler.indexOf('bs58.decode(parsed.data.signature)');
    const pubLenAt = handler.indexOf('pubBytes.length !== 32');
    const sigLenAt = handler.indexOf('sigBytes.length !== 64');
    // The CALL, not the comment that names it.
    const verifyAt = handler.indexOf('if (!nacl.sign.detached.verify(');
    expect(decodeAt).toBeGreaterThan(-1);
    expect(pubLenAt).toBeGreaterThan(decodeAt);
    expect(sigLenAt).toBeGreaterThan(decodeAt);
    expect(verifyAt).toBeGreaterThan(pubLenAt);
    expect(verifyAt).toBeGreaterThan(sigLenAt);
  });

  it('verifies against the SERVER-read declared wallet, not a client value', () => {
    const handler = routes.slice(
      routes.indexOf("'/hold-wallet/verify/signature'"),
      routes.indexOf("'/hold-wallet/verify/custodial'"),
    );
    expect(handler).toContain('await readHoldWalletDeclaration(identity.userId)');
    expect(handler).toContain('bs58.decode(declaredWallet)');
    expect(handler).toContain(
      'buildLandHoldWalletMessage(identity.userId, declaredWallet, parsed.data.nonce)',
    );
  });

  it('re-reads the CURRENT custodial wallet inside the attest transaction', () => {
    const attest = service.slice(service.indexOf('export async function attestCustodialLandHoldWallet'));
    expect(attest).toContain('pg_advisory_xact_lock');
    expect(attest).toContain('SELECT user_id, wallet_address FROM avatars');
    expect(attest).toContain('FOR SHARE');
    expect(attest).toContain("new LandTenureSettlementError('not_custodial_wallet', 409)");
    expect(attest).toContain("new LandTenureSettlementError('identity_binding_changed', 403)");
  });

  it('re-checks the declaration under FOR UPDATE before persisting a proof', () => {
    const grant = service.slice(
      service.indexOf('export async function grantLandHoldWalletVerification'),
      service.indexOf('export async function attestCustodialLandHoldWallet'),
    );
    expect(grant).toContain('FOR UPDATE');
    expect(grant).toContain("new LandTenureSettlementError('wallet_declaration_changed', 409)");
    expect(grant).not.toContain('land_hold_wallet_grandfathered_pubkey =');
  });
});

describe('GET /hold-wallet verification block', () => {
  it('serves the server-derived state and never derives it in the route', () => {
    const handler = routes.slice(
      routes.indexOf("landRoutes.get('/hold-wallet'"),
      routes.indexOf("'/hold-wallet/verify/challenge'"),
    );
    expect(handler).toContain('await readHoldWalletDeclaration(identity.userId)');
    expect(handler).toContain('verification: {');
    expect(handler).toContain('state: declaration.state');
    expect(handler).toContain('method: declaration.method');
    expect(handler).toContain('verifiedAt: declaration.verifiedAt');
    expect(handler).toContain('transferDoorAvailable');
    expect(handler).not.toContain('holdWalletVerificationState(');
  });

  it('derives door-2 availability from provisioning, not from a dark flag', () => {
    const handler = routes.slice(
      routes.indexOf("landRoutes.get('/hold-wallet'"),
      routes.indexOf("'/hold-wallet/verify/challenge'"),
    );
    expect(handler).toContain('await getTransferDoorAvailability()');
    // A failed availability probe must not fail the read.
    expect(handler).toContain('available: false');
  });

  it('suppresses a stale method/timestamp when the proof no longer matches', () => {
    const view = service.slice(service.indexOf('export async function readHoldWalletDeclaration'));
    expect(view).toContain("state === 'verified'");
  });
});

describe('trap T12 — grandfathered holders keep what they have, and nothing more', () => {
  const G = 'GwalletGwalletGwalletGwalletGwalletGwallet';

  it('leaves the rent sweeper free of any verification gate', () => {
    // This is the whole no-eviction guarantee: existing holds are swept on rent
    // and tenure alone, so a wallet that never verifies is never evicted.
    expect(sweeper).not.toContain('land_hold_wallet_verified');
    expect(sweeper).not.toContain('wallet_not_verified');
    expect(sweeper).not.toContain('holdWalletProofAccepted');
    expect(sweeper).not.toContain('grandfathered_pubkey');
  });

  it('refuses a NEW hold claim on a grandfathered declaration (adversarial review)', () => {
    // The frozen spec §4 let the migration stamp open the hold door, which
    // meant the pre-existing squatter this slice targets could keep claiming
    // MORE land on a wallet they do not control, forever. Grandfathering is
    // "we do not evict you", not "keep buying".
    expect(
      holdWalletVerificationState({
        declaredWallet: G,
        verifiedPubkey: null,
        verifiedMethod: null,
        grandfatheredPubkey: G,
      }),
    ).toBe('grandfathered');
    expect(
      holdWalletProofAccepted({
        declaredWallet: G,
        verifiedPubkey: null,
        verifiedMethod: null,
        grandfatheredPubkey: G,
      }),
    ).toBe(false);
  });

  it('opens the door the moment that same wallet is actually proven', () => {
    expect(
      holdWalletProofAccepted({
        declaredWallet: G,
        verifiedPubkey: G,
        verifiedMethod: 'signature',
        grandfatheredPubkey: G,
      }),
    ).toBe(true);
  });

  it('still REPORTS grandfathered on the GET surface, so the UI keeps prompting', () => {
    const view = service.slice(
      service.indexOf('export async function readHoldWalletDeclaration'),
      service.indexOf('export type HoldWalletVerificationGrant'),
    );
    expect(view).toContain('holdWalletVerificationState(proof)');
    expect(view).not.toContain('holdWalletProofAccepted');
  });

  it('names the state in the refusal so the UI can say which case it is', () => {
    expect(service).toContain('verificationState: proofState');
  });
});

describe('round 3 — verification is signature-SUBMITTED, not scan-discovered', () => {
  it('exposes a submit route with a strict, length-bounded body', () => {
    expect(routes).toContain("'/hold-wallet/verify/transfer/:challengeId/submit'");
    const schema = routes.slice(
      routes.indexOf('const holdWalletSubmitTransferBodySchema = z'),
      routes.indexOf('// placement: server validates'),
    );
    expect(schema).toContain('.strict()');
    expect(schema).toContain('signature:');
    expect(schema).not.toContain('walletAddress');
  });

  it('runs the SAME proof predicates on the submitted transaction', () => {
    const submit = verifyService.slice(
      verifyService.indexOf('export async function submitTransferSignature('),
    );
    expect(submit).toContain('transactionMatchesTransferLeg(probe, leg)');
    expect(submit).toContain('transactionSignedBySource(probe, row.walletPubkey)');
    expect(submit).toContain('transactionCarriesChallengeMemo(probe, row.id)');
    expect(submit).toContain('transactionHasTopLevelTransferLeg(probe, leg)');
    expect(submit).toContain('receivedLamportsFrom(probe, leg)');
    // Fetched by signature at FINALIZED — no cursor, no page cap, no window.
    expect(submit).toContain("commitment: 'finalized'");
  });

  it('DEMOTES the background scan: it can never grant verification', () => {
    // The scan attributes as `unclaimed` (refund owed, never verified), so its
    // bounds are a refund-latency concern rather than a correctness hole.
    const attribute = verifyService.slice(
      verifyService.indexOf('async function attributeAtDestination('),
      verifyService.indexOf('export function retainedLegObligations('),
    );
    expect(attribute).toContain("nextStatus: 'unclaimed'");
    expect(attribute).not.toContain("nextStatus = 'observed'");
    expect(attribute).not.toContain('grantObserved');
    // Only submission grants.
    const grantCallers = verifyService.split('grantObserved(').length - 1;
    expect(grantCallers).toBe(2); // the definition + the submit path
  });

  it('polling is a pure status read that never scans', () => {
    const poll = verifyService.slice(
      verifyService.indexOf('export async function pollTransferChallenge('),
      verifyService.indexOf('// ------', verifyService.indexOf('export async function pollTransferChallenge(')),
    );
    expect(poll).not.toContain('attributeChallenges');
    expect(poll).not.toContain('grantObserved');
  });

  it('closes the door on cap-policy disagreement, not just signer health', () => {
    const readiness = verifyService.slice(
      verifyService.indexOf('async function verifySignerReadiness('),
    );
    expect(readiness).toContain('readTodayCapPolicy()');
    expect(readiness).toContain("reason: 'cap_policy_mismatch'");
  });
});

describe('round 4 — refund copy never asserts a verification outcome', () => {
  const panel = readFileSync(
    join(ROOT, 'apps', 'web', 'src', 'components', 'game', 'land', 'tenure-office-panels.tsx'),
    'utf8',
  );

  it('states the refund situation without claiming verification is complete', () => {
    // `reconcile` and `skipped` also accompany rejected, expired and unclaimed
    // rows, where "your verification is complete" would be flatly untrue.
    expect(panel).toContain('function transferRefundCopy(');
    expect(panel).not.toContain('Your verification is complete either way.');
    // The reassurance is conditional on the VERIFICATION state, not the refund.
    expect(panel).toContain("const reassurance = verified ? ' Your wallet stays verified either way.' : '';");
    expect(panel).toContain("transferRefundCopy(refundState, pollState === 'verified')");
  });

  it('does not promise the UI refund unconditionally either (round 6)', () => {
    // The panel renders for rejected, expired and unclaimed checks too, so it
    // must not claim money "goes back to you" without the same key caveat.
    expect(panel).not.toContain('any amount we received goes back to you');
    expect(panel).toContain('we keep the keys to those addresses so it can come back to you');
  });

  it('still refuses to call a skipped refund "not needed"', () => {
    // `skipped` means an address we can no longer sign for, so a person has to
    // send it back by hand. Calling it unnecessary would hide money we owe.
    expect(panel).toContain('send this one back by hand');
    expect(panel).not.toContain('Refund: not needed for this check.');
  });

  it('keeps user-facing verification copy free of em dashes', () => {
    const block = panel.slice(
      panel.indexOf('const TRANSFER_STATE_COPY'),
      panel.indexOf('/** Branch on the typed WalletSignError code'),
    );
    expect(block).not.toContain('—');
    expect(block).not.toContain('–');
  });
});

describe('protocol manual parity', () => {
  it('retains the land proof bump before the subsequent Tier-1 bounty bump', () => {
    expect(protocol).toContain('export const PROTOCOL_VERSION = 53;');
    expect(protocol.match(/export const PROTOCOL_VERSION = /g) ?? []).toHaveLength(1);
  });

  it('documents the requirement, the REST signature door, custodial attest and the error', () => {
    expect(protocol).toContain('### Verify the hold wallet before claiming (REQUIRED since 2026-08-10)');
    expect(protocol).toContain('wallet_not_verified');
    expect(protocol).toContain('/api/land/hold-wallet/verify/challenge');
    expect(protocol).toContain('/api/land/hold-wallet/verify/signature');
    expect(protocol).toContain('/api/land/hold-wallet/verify/custodial');
    expect(protocol).toContain('not_custodial_wallet');
    expect(protocol).toContain('transfer_door_unavailable');
    expect(protocol).toContain('verify_attempt_cap');
  });

  it('publishes the EXACT message bytes a BYO agent must sign', () => {
    expect(protocol).toContain('ClawVille land hold wallet');
    expect(protocol).toContain('account: <your userId>');
    expect(protocol).toContain('wallet: <declared pubkey>');
    expect(protocol).toContain('nonce: <nonce>');
  });
});
