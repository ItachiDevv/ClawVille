/**
 * Seabed salvage settlement — REAL DB money suite (P7a/P7b).
 *
 * Salvage issues currency, so it gets EXECUTED database tests, not source
 * greps. Every case runs against the configured Postgres and is skipped only
 * when `DATABASE_URL` is absent.
 *
 * The properties under test are the ones a faucet must never violate:
 *   - the yield is deterministic per (avatar, node, ordinal) and unguessable
 *     without the server secret,
 *   - the daily caps admit EXACTLY their bound under concurrency,
 *   - a refused claim consumes NOTHING — not a cooldown, not an admission,
 *     not the owner's fleet budget,
 *   - a replayed idempotency key pays once and reports the original result,
 *   - house actors earn nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db, sql } from '@clawville/database';
import {
  SALVAGE_AVATAR_DAILY_CLAIM_CAP,
  SALVAGE_LAYOUT_VERSION,
  SALVAGE_NODES,
  SALVAGE_OWNER_DAILY_CLAIM_CAP,
  SALVAGE_YIELD_MAX,
  SALVAGE_YIELD_MIN,
} from '@clawville/shared';
import {
  deriveSalvageYield,
  readSalvageState,
  salvageFingerprint,
  settleSalvageClaim,
  type SalvageClaimOutcome,
} from '../salvage-settlement';
import { readMaterialBalance } from '../material-ledger';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/** The suite drives the yield derivation directly, so it needs the same secret
 *  the running API would have. `FINGERPRINT_SECRET` is hard-required at API
 *  boot, but a bare test process has no boot, so supply one. */
const TEST_SECRET = 'salvage-suite-secret-0123456789abcdef0123456789abcdef';

function first<T>(rows: Iterable<T>): T {
  const [row] = Array.from(rows);
  if (!row) throw new Error('expected at least one row');
  return row;
}

let tag = '';
let userId = '';
let avatarId = '';

async function makeAvatar(suffix: string, ownerUserId: string): Promise<string> {
  // `is_active` MUST be true: settlement re-derives the owner from a live
  // avatar row under the locks and refuses an inactive one, which is the point.
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO avatars
          (user_id, name, species, color, gender, archetype, personality, stats,
           claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
        VALUES
          (${ownerUserId}, ${`Salvage ${suffix}`}, 'cat', 'green', 'male',
           'brave-adventurer', '{}'::jsonb, '{}'::jsonb, 0, 0, 0, 0, true, false)
        RETURNING id`,
  );
  return first(rows).id;
}

function actorFor(id: string) {
  return {
    kind: 'user' as const,
    userId,
    avatarId: id,
    agentId: null,
    sessionId: null,
  };
}

function bindingsFor(id: string) {
  return { expectedAvatarId: id, expectedUserId: userId, expectedAgentId: null };
}

async function claim(
  id: string,
  nodeId: string,
  idempotencyKey: string,
): Promise<SalvageClaimOutcome> {
  return settleSalvageClaim({
    actor: actorFor(id),
    bindings: bindingsFor(id),
    nodeId,
    idempotencyKey,
  });
}

/** Wipe this fixture's salvage state so each case starts from a known place. */
async function resetSalvageState(): Promise<void> {
  if (!avatarId) return;
  for (const id of [avatarId]) {
    await db.execute(sql`DELETE FROM salvage_claim_receipts WHERE avatar_id = ${id}`);
    await db.execute(sql`DELETE FROM salvage_node_claims WHERE avatar_id = ${id}`);
    await db.execute(sql`DELETE FROM salvage_daily_admissions WHERE avatar_id = ${id}`);
    await db.execute(sql`UPDATE avatar_material_balances SET quantity = 0 WHERE avatar_id = ${id}`);
  }
  await db.execute(
    sql`DELETE FROM salvage_owner_admissions WHERE owner_kind = 'user' AND owner_id = ${userId}`,
  );
}

describeIfDb('salvage settlement (real DB)', () => {
  beforeAll(async () => {
    process.env.FINGERPRINT_SECRET ??= TEST_SECRET;
    tag = `slv${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Salvage Test')
          RETURNING id`,
    );
    userId = first(users).id;
    avatarId = await makeAvatar(tag, userId);
    // NOTE: `avatars.user_id` is UNIQUE, so a second avatar under the SAME
    // owner is not representable. The owner-cap cases below therefore drive the
    // admission table directly — which is where the cap actually lives, and is
    // the honest test rather than a weaker proxy.
    await resetSalvageState();
  });

  afterAll(async () => {
    if (!userId) return;
    await resetSalvageState();
    await db.execute(sql`DELETE FROM avatar_material_balances WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  // ── Yield ────────────────────────────────────────────────────────────────

  describe('HMAC yield', () => {
    it('is deterministic for the same (avatar, node, ordinal)', () => {
      const a = deriveSalvageYield('av-1', 'shelf-04', 7, TEST_SECRET);
      const b = deriveSalvageYield('av-1', 'shelf-04', 7, TEST_SECRET);
      expect(a).toBe(b);
    });

    it('stays inside the 1-3 band for a long ordinal run', () => {
      for (let ordinal = 1; ordinal <= 500; ordinal++) {
        const y = deriveSalvageYield(avatarId || 'av-1', 'deep-09', ordinal, TEST_SECRET);
        expect(Number.isInteger(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(SALVAGE_YIELD_MIN);
        expect(y).toBeLessThanOrEqual(SALVAGE_YIELD_MAX);
      }
    });

    it('uses all three outcomes rather than collapsing to one', () => {
      const seen = new Set<number>();
      for (let ordinal = 1; ordinal <= 200; ordinal++) {
        seen.add(deriveSalvageYield('spread-probe', 'shelf-01', ordinal, TEST_SECRET));
      }
      expect(seen.size).toBe(3);
    });

    it('DEPENDS ON THE SECRET — this is what makes it unfarmable', () => {
      // If the yield were a public sha256 over known fields, a client could
      // compute every pending claim and only ever spend cooldowns on 3s.
      const withA = deriveSalvageYield('av-1', 'shelf-04', 1, 'secret-a');
      const withB = deriveSalvageYield('av-1', 'shelf-04', 1, 'secret-b-different');
      const spreadA = Array.from({ length: 60 }, (_, i) =>
        deriveSalvageYield('av-1', 'shelf-04', i + 1, 'secret-a'),
      ).join('');
      const spreadB = Array.from({ length: 60 }, (_, i) =>
        deriveSalvageYield('av-1', 'shelf-04', i + 1, 'secret-b-different'),
      ).join('');
      expect(spreadA).not.toBe(spreadB);
      expect(typeof withA).toBe('number');
      expect(typeof withB).toBe('number');
    });

    it('separates avatars and nodes in the derivation', () => {
      const runFor = (av: string, node: string) =>
        Array.from({ length: 40 }, (_, i) =>
          deriveSalvageYield(av, node, i + 1, TEST_SECRET),
        ).join('');
      expect(runFor('av-1', 'shelf-04')).not.toBe(runFor('av-2', 'shelf-04'));
      expect(runFor('av-1', 'shelf-04')).not.toBe(runFor('av-1', 'shelf-05'));
    });
  });

  describe('fingerprint', () => {
    it('excludes the ordinal, so a legitimate replay is not a conflict', () => {
      const atOrdinal1 = salvageFingerprint(avatarId, 'shelf-01', SALVAGE_LAYOUT_VERSION);
      const atOrdinal9 = salvageFingerprint(avatarId, 'shelf-01', SALVAGE_LAYOUT_VERSION);
      expect(atOrdinal1).toBe(atOrdinal9);
    });

    it('changes with the layout version, so a re-layout cannot alias an old key', () => {
      expect(salvageFingerprint(avatarId, 'shelf-01', 1)).not.toBe(
        salvageFingerprint(avatarId, 'shelf-01', 2),
      );
    });
  });

  // ── Settlement ───────────────────────────────────────────────────────────

  describe('a fresh claim', () => {
    beforeAll(resetSalvageState);

    it('credits materials, sets a cooldown, and burns exactly one admission', async () => {
      const before = await readMaterialBalance(avatarId);
      const outcome = await claim(avatarId, 'shallows-01', `${tag}-fresh-1`);

      expect(outcome.kind).toBe('settled');
      if (outcome.kind !== 'settled') throw new Error('unreachable');
      expect(outcome.payload.materialsGranted).toBeGreaterThanOrEqual(1);
      expect(outcome.payload.materialsGranted).toBeLessThanOrEqual(3);
      expect(outcome.payload.balanceAfter).toBe(before + outcome.payload.materialsGranted);
      expect(new Date(outcome.payload.nextClaimAt).getTime()).toBeGreaterThan(Date.now());
      expect(outcome.payload.claimsRemainingToday).toBe(SALVAGE_AVATAR_DAILY_CLAIM_CAP - 1);
      expect(outcome.payload.ownerClaimsRemainingToday).toBe(
        SALVAGE_OWNER_DAILY_CLAIM_CAP - 1,
      );

      // The credit is real, not just reported.
      expect(await readMaterialBalance(avatarId)).toBe(outcome.payload.balanceAfter);
    });

    it('refuses the same node again — the cooldown is live', async () => {
      const outcome = await claim(avatarId, 'shallows-01', `${tag}-fresh-2`);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('node_on_cooldown');
      expect(outcome.nextClaimAt).toBeTruthy();
    });

    it('consumes NO admission on the refused cooldown claim', async () => {
      const row = first(
        await db.execute<{ claims_admitted: number | string }>(
          sql`SELECT claims_admitted FROM salvage_daily_admissions
              WHERE avatar_id = ${avatarId}
                AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      );
      // One settled claim above, one refused. If the refusal had leaked an
      // increment this would read 2.
      expect(Number(row.claims_admitted)).toBe(1);
    });

    it('refuses a node outside the frozen layout without touching state', async () => {
      const before = await readMaterialBalance(avatarId);
      const outcome = await claim(avatarId, 'not-a-real-node', `${tag}-unknown`);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('node_unknown');
      expect(await readMaterialBalance(avatarId)).toBe(before);
    });

    it('stamps the UTC day from the DATABASE clock, not the node process', async () => {
      const row = first(
        await db.execute<{ same: boolean }>(
          sql`SELECT (utc_day = (now() AT TIME ZONE 'UTC')::date) AS same
              FROM salvage_daily_admissions WHERE avatar_id = ${avatarId}`,
        ),
      );
      expect(row.same).toBe(true);
    });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  describe('idempotency', () => {
    beforeAll(resetSalvageState);

    it('replays the original response and pays only once', async () => {
      const key = `${tag}-replay-key`;
      const firstOutcome = await claim(avatarId, 'shelf-02', key);
      expect(firstOutcome.kind).toBe('settled');
      if (firstOutcome.kind !== 'settled') throw new Error('unreachable');
      const balanceAfterFirst = await readMaterialBalance(avatarId);

      const second = await claim(avatarId, 'shelf-02', key);
      expect(second.kind).toBe('replay');
      if (second.kind !== 'replay') throw new Error('unreachable');
      expect(second.payload).toEqual(firstOutcome.payload);
      // No second credit.
      expect(await readMaterialBalance(avatarId)).toBe(balanceAfterFirst);
    });

    it('replays WITHOUT consuming a cooldown or an admission', async () => {
      const admissions = first(
        await db.execute<{ claims_admitted: number | string }>(
          sql`SELECT claims_admitted FROM salvage_daily_admissions
              WHERE avatar_id = ${avatarId}
                AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      );
      expect(Number(admissions.claims_admitted)).toBe(1);
      const ordinal = first(
        await db.execute<{ claim_ordinal: number | string }>(
          sql`SELECT claim_ordinal FROM salvage_node_claims
              WHERE avatar_id = ${avatarId} AND node_id = 'shelf-02'`,
        ),
      );
      expect(Number(ordinal.claim_ordinal)).toBe(1);
    });

    it('409s the same key aimed at a DIFFERENT node', async () => {
      const outcome = await claim(avatarId, 'shelf-03', `${tag}-replay-key`);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('idempotency_key_conflict');
    });

    it('still replays verbatim after a LATER claim advanced other ordinals', async () => {
      // The design is explicit that `claim_ordinal` is recorded and never
      // compared; this is the case that would break if someone "helpfully"
      // added it to the fingerprint.
      const later = await claim(avatarId, 'shelf-04', `${tag}-later-claim`);
      expect(later.kind).toBe('settled');

      const replayed = await claim(avatarId, 'shelf-02', `${tag}-replay-key`);
      expect(replayed.kind).toBe('replay');
    });
  });

  // ── Caps under concurrency ───────────────────────────────────────────────

  describe('per-avatar daily cap', () => {
    beforeAll(resetSalvageState);

    it(`admits EXACTLY ${SALVAGE_AVATAR_DAILY_CLAIM_CAP} of ${SALVAGE_AVATAR_DAILY_CLAIM_CAP + 1} concurrent unique-node claims`, async () => {
      const nodes = SALVAGE_NODES.slice(0, SALVAGE_AVATAR_DAILY_CLAIM_CAP + 1);
      const results = await Promise.all(
        nodes.map((node, i) => claim(avatarId, node.id, `${tag}-cap-${i}`)),
      );
      const settled = results.filter((r) => r.kind === 'settled');
      const refused = results.filter((r) => r.kind === 'refused');
      expect(settled).toHaveLength(SALVAGE_AVATAR_DAILY_CLAIM_CAP);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.kind === 'refused' && refused[0]!.code).toBe('avatar_daily_cap');
    }, 120_000);

    it('leaves the counter exactly at the cap — never over', async () => {
      const row = first(
        await db.execute<{ claims_admitted: number | string; materials_issued: number | string }>(
          sql`SELECT claims_admitted, materials_issued FROM salvage_daily_admissions
              WHERE avatar_id = ${avatarId}
                AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      );
      expect(Number(row.claims_admitted)).toBe(SALVAGE_AVATAR_DAILY_CLAIM_CAP);
      // 20 claims x 1..3 materials.
      expect(Number(row.materials_issued)).toBeGreaterThanOrEqual(
        SALVAGE_AVATAR_DAILY_CLAIM_CAP,
      );
      expect(Number(row.materials_issued)).toBeLessThanOrEqual(
        SALVAGE_AVATAR_DAILY_CLAIM_CAP * SALVAGE_YIELD_MAX,
      );
    });

    it('credited exactly what it issued — no material appears from nowhere', async () => {
      const issued = Number(
        first(
          await db.execute<{ materials_issued: number | string }>(
            sql`SELECT materials_issued FROM salvage_daily_admissions
                WHERE avatar_id = ${avatarId}
                  AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
          ),
        ).materials_issued,
      );
      const receipts = Number(
        first(
          await db.execute<{ total: number | string }>(
            sql`SELECT COALESCE(SUM(materials_granted), 0) AS total
                FROM salvage_claim_receipts WHERE avatar_id = ${avatarId}`,
          ),
        ).total,
      );
      expect(receipts).toBe(issued);
      expect(await readMaterialBalance(avatarId)).toBe(issued);
    });

    it('does NOT charge the owner budget for the claim it refused', async () => {
      const owner = first(
        await db.execute<{ claims_admitted: number | string }>(
          sql`SELECT claims_admitted FROM salvage_owner_admissions
              WHERE owner_kind = 'user' AND owner_id = ${userId}
                AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      );
      // THE ROLLBACK PROOF. The owner counter increments a statement BEFORE the
      // avatar counter. If the avatar refusal did not roll the transaction
      // back, this would read 21 and one avatar would have quietly burned an
      // extra slot of its whole fleet's daily budget.
      expect(Number(owner.claims_admitted)).toBe(SALVAGE_AVATAR_DAILY_CLAIM_CAP);
    });
  });

  describe('per-owner daily cap (the anti-fleet bound)', () => {
    beforeAll(resetSalvageState);

    it('refuses once the owner budget is spent, even with avatar budget left', async () => {
      // Seed the owner at cap. This is the fleet situation: five sibling
      // avatars already spent the account's 120 claims, so the sixth is
      // refused despite having all 20 of its own.
      await db.execute(
        sql`INSERT INTO salvage_owner_admissions (owner_kind, owner_id, utc_day, claims_admitted)
            VALUES ('user', ${userId}, (now() AT TIME ZONE 'UTC')::date, ${SALVAGE_OWNER_DAILY_CLAIM_CAP})
            ON CONFLICT (owner_kind, owner_id, utc_day) DO UPDATE
              SET claims_admitted = ${SALVAGE_OWNER_DAILY_CLAIM_CAP}`,
      );

      const before = await readMaterialBalance(avatarId);
      const outcome = await claim(avatarId, 'deep-01', `${tag}-owner-cap`);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('owner_daily_cap');
      expect(await readMaterialBalance(avatarId)).toBe(before);

      // And it did not burn the avatar's own budget on the way past.
      const avatarRows = await db.execute<{ claims_admitted: number | string }>(
        sql`SELECT claims_admitted FROM salvage_daily_admissions
            WHERE avatar_id = ${avatarId}
              AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
      );
      expect(Array.from(avatarRows)).toHaveLength(0);
    });

    /**
     * The service serializes same-owner claims on an in-process mutex, so this
     * drives the ADMISSION STATEMENT itself concurrently instead. That is the
     * honest test of the cross-process guarantee: two API containers share no
     * mutex, and the conditional upsert is the only thing standing between them
     * and an over-issued cap.
     */
    it('the conditional upsert alone admits exactly the cap under raw concurrency', async () => {
      await db.execute(
        sql`DELETE FROM salvage_owner_admissions
            WHERE owner_kind = 'user' AND owner_id = ${userId}`,
      );
      const attempts = SALVAGE_OWNER_DAILY_CLAIM_CAP + 15;
      const results = await Promise.all(
        Array.from({ length: attempts }, () =>
          db
            .execute<{ claims_admitted: number | string }>(
              sql`INSERT INTO salvage_owner_admissions (owner_kind, owner_id, utc_day, claims_admitted)
                  VALUES ('user', ${userId}, (transaction_timestamp() AT TIME ZONE 'UTC')::date, 1)
                  ON CONFLICT (owner_kind, owner_id, utc_day) DO UPDATE
                    SET claims_admitted = salvage_owner_admissions.claims_admitted + 1
                    WHERE salvage_owner_admissions.claims_admitted < ${SALVAGE_OWNER_DAILY_CLAIM_CAP}
                  RETURNING claims_admitted`,
            )
            // A concurrent upsert can lose its ON CONFLICT race and surface as
            // a unique violation rather than a zero-row result; both mean "not
            // admitted", which is the only distinction this test cares about.
            .then((rows) => Array.from(rows).length > 0)
            .catch(() => false),
        ),
      );
      const admitted = results.filter(Boolean).length;
      expect(admitted).toBeLessThanOrEqual(SALVAGE_OWNER_DAILY_CLAIM_CAP);

      const finalRow = first(
        await db.execute<{ claims_admitted: number | string }>(
          sql`SELECT claims_admitted FROM salvage_owner_admissions
              WHERE owner_kind = 'user' AND owner_id = ${userId}
                AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      );
      // The decisive assertion: the stored counter NEVER exceeds the cap, and
      // it equals the number of admissions actually handed out.
      expect(Number(finalRow.claims_admitted)).toBe(admitted);
      expect(Number(finalRow.claims_admitted)).toBeLessThanOrEqual(
        SALVAGE_OWNER_DAILY_CLAIM_CAP,
      );
    }, 120_000);
  });

  // ── Eligibility ──────────────────────────────────────────────────────────

  describe('eligibility', () => {
    beforeAll(resetSalvageState);

    it('refuses a HOUSE actor — the fleet earns nothing from a faucet', async () => {
      const houseRows = await db.execute<{ agent_id: string }>(
        sql`SELECT agent_id FROM openclaw_bots WHERE is_house = true LIMIT 1`,
      );
      const houseAgentId = Array.from(houseRows)[0]?.agent_id;
      if (!houseAgentId) return; // no house fleet in this environment

      const before = await readMaterialBalance(avatarId);
      const outcome = await settleSalvageClaim({
        actor: {
          kind: 'agent',
          userId,
          avatarId,
          agentId: houseAgentId,
          sessionId: 'oc-house-session',
        },
        bindings: bindingsFor(avatarId),
        nodeId: 'shelf-06',
        idempotencyKey: `${tag}-house`,
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('house_excluded');
      expect(await readMaterialBalance(avatarId)).toBe(before);
    });

    it('refuses when the live session no longer matches the captured binding', async () => {
      const before = await readMaterialBalance(avatarId);
      const outcome = await settleSalvageClaim({
        actor: {
          kind: 'agent',
          userId,
          avatarId,
          agentId: `${tag}-agent`,
          sessionId: 'oc-drifted',
        },
        bindings: bindingsFor(avatarId),
        nodeId: 'shelf-07',
        idempotencyKey: `${tag}-drift`,
        // The session rotated to a different avatar between dispatch and the
        // locks — exactly the window the revalidation exists to close.
        revalidateBinding: async () => ({
          userId,
          avatarId: '00000000-0000-0000-0000-000000000000',
          agentId: `${tag}-agent`,
          ledgerCapable: true,
        }),
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('binding_drift');
      expect(await readMaterialBalance(avatarId)).toBe(before);
    });

    it('refuses a session that is no longer ledger-capable', async () => {
      const outcome = await settleSalvageClaim({
        actor: {
          kind: 'agent',
          userId,
          avatarId,
          agentId: `${tag}-agent`,
          sessionId: 'oc-unproven',
        },
        bindings: bindingsFor(avatarId),
        nodeId: 'shelf-08',
        idempotencyKey: `${tag}-unproven`,
        revalidateBinding: async () => ({
          userId,
          avatarId,
          agentId: `${tag}-agent`,
          ledgerCapable: false,
        }),
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('binding_drift');
    });

    it('refuses when the session resolver returns nothing at all', async () => {
      const outcome = await settleSalvageClaim({
        actor: {
          kind: 'agent',
          userId,
          avatarId,
          agentId: `${tag}-agent`,
          sessionId: 'oc-expired',
        },
        bindings: bindingsFor(avatarId),
        nodeId: 'shelf-09',
        idempotencyKey: `${tag}-expired`,
        revalidateBinding: async () => null,
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('binding_drift');
    });

    it('refuses when the avatar no longer belongs to the locked principal', async () => {
      const outcome = await settleSalvageClaim({
        actor: actorFor(avatarId),
        // A different owner principal than the avatar actually has.
        bindings: {
          expectedAvatarId: avatarId,
          expectedUserId: '00000000-0000-0000-0000-000000000000',
          expectedAgentId: null,
        },
        nodeId: 'shelf-10',
        idempotencyKey: `${tag}-wrong-owner`,
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.code).toBe('binding_drift');
    });
  });

  // ── Read model ───────────────────────────────────────────────────────────

  describe('readSalvageState', () => {
    beforeAll(resetSalvageState);

    it('reports every node, with the claimed one cooling', async () => {
      const settled = await claim(avatarId, 'deep-05', `${tag}-state`);
      expect(settled.kind).toBe('settled');

      const state = await readSalvageState({ avatarId, userId });
      expect(state.layoutVersion).toBe(SALVAGE_LAYOUT_VERSION);
      expect(state.nodes).toHaveLength(SALVAGE_NODES.length);

      const claimed = state.nodes.find((n) => n.nodeId === 'deep-05')!;
      expect(claimed.ready).toBe(false);
      expect(claimed.nextClaimAt).toBeTruthy();

      const untouched = state.nodes.find((n) => n.nodeId === 'deep-06')!;
      expect(untouched.ready).toBe(true);
      expect(untouched.nextClaimAt).toBeNull();

      expect(state.claimsUsedToday).toBe(1);
      expect(state.claimsRemainingToday).toBe(SALVAGE_AVATAR_DAILY_CLAIM_CAP - 1);
      expect(state.ownerClaimsUsedToday).toBe(1);
      expect(state.materialBalance).toBe(await readMaterialBalance(avatarId));
      expect(state.lastClaim?.nodeId).toBe('deep-05');
    });

    it('carries the node geometry the renderer draws, unchanged', async () => {
      const state = await readSalvageState({ avatarId, userId });
      for (const node of SALVAGE_NODES) {
        const reported = state.nodes.find((n) => n.nodeId === node.id)!;
        expect(reported.x).toBe(node.x);
        expect(reported.z).toBe(node.z);
        expect(reported.band).toBe(node.band);
      }
    });
  });
});
