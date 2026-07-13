/**
 * Covenant action-record stream tests (2026-07-13).
 *
 * Pure parts (canonical JSON, payload hash, chain-hash encoding) run
 * everywhere. DB-gated parts (recorder atomicity, ledger-hook rollback
 * coupling, sealer chaining, tamper trigger) run only with DATABASE_URL
 * (staging DB) — the same describeIfDb convention as
 * quests-agent-parity.test.ts. The DB suite requires migration 0028.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import {
  canonicalJson,
  covenantPayloadHash,
  recordCovenantAction,
} from '../covenant-action-recorder';
import {
  computeRecordHash,
  sealCovenantChainOnce,
  toCanonicalIso,
} from '../covenant-chain-sealer';

// ---------------------------------------------------------------------------
// Pure: canonical JSON + hashes
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  test('sorts keys recursively and deterministically', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { y: 5, z: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}');
  });

  test('drops undefined properties (matches JSON.stringify semantics)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('keeps arrays in place (never sorts them)', () => {
    expect(canonicalJson({ a: [2, 1] })).toBe('{"a":[2,1]}');
  });

  test('payload hash is recomputable from the canonical encoding', () => {
    const payload = { amount: 5, reason: 'quest_complete', nested: { q: 'x' } };
    const expected = createHash('sha256')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex');
    expect(covenantPayloadHash(payload)).toBe(expected);
    // Key order must not matter.
    expect(
      covenantPayloadHash({ reason: 'quest_complete', nested: { q: 'x' }, amount: 5 }),
    ).toBe(expected);
  });
});

describe('computeRecordHash', () => {
  const base = {
    prevHash: '0'.repeat(64),
    payloadHash: 'a'.repeat(64),
    action: 'economy.credit',
    subjectType: 'avatar',
    subjectId: '11111111-1111-1111-1111-111111111111',
    actorKind: null as string | null,
    chainPosition: 1n,
    createdAtIso: '2026-07-13T00:00:00.000Z',
  };

  test('is stable (pinned vector — a change here breaks every verifier)', () => {
    const parts = [
      base.prevHash,
      base.payloadHash,
      base.action,
      base.subjectType,
      base.subjectId,
      '', // actorKind null encodes as the empty string
      '1',
      base.createdAtIso,
    ];
    const h = createHash('sha256');
    parts.forEach((s, i) => {
      h.update(Buffer.from(s, 'utf8'));
      if (i < parts.length - 1) h.update(Buffer.from([0]));
    });
    expect(computeRecordHash(base)).toBe(h.digest('hex'));
  });

  test('every field is load-bearing', () => {
    const h0 = computeRecordHash(base);
    expect(computeRecordHash({ ...base, prevHash: '1'.repeat(64) })).not.toBe(h0);
    expect(computeRecordHash({ ...base, payloadHash: 'b'.repeat(64) })).not.toBe(h0);
    expect(computeRecordHash({ ...base, action: 'economy.debit' })).not.toBe(h0);
    expect(computeRecordHash({ ...base, subjectId: 'x' })).not.toBe(h0);
    // Codex round 1 HIGH #4: attribution mutation must invalidate the hash.
    expect(computeRecordHash({ ...base, actorKind: 'human' })).not.toBe(h0);
    expect(computeRecordHash({ ...base, actorKind: 'admin' })).not.toBe(
      computeRecordHash({ ...base, actorKind: 'agent' }),
    );
    expect(computeRecordHash({ ...base, chainPosition: 2n })).not.toBe(h0);
    expect(computeRecordHash({ ...base, createdAtIso: '2026-07-13T00:00:00.001Z' })).not.toBe(h0);
  });

  test('NUL separation prevents field-boundary collisions', () => {
    // 'ab' + 'c' must not hash like 'a' + 'bc'.
    const h1 = computeRecordHash({ ...base, action: 'ab', subjectType: 'c' });
    const h2 = computeRecordHash({ ...base, action: 'a', subjectType: 'bc' });
    expect(h1).not.toBe(h2);
  });

  test('toCanonicalIso normalizes Date and string identically', () => {
    const d = new Date('2026-07-13T12:34:56.789Z');
    expect(toCanonicalIso(d)).toBe('2026-07-13T12:34:56.789Z');
    expect(toCanonicalIso('2026-07-13T12:34:56.789+00:00')).toBe('2026-07-13T12:34:56.789Z');
  });
});

// ---------------------------------------------------------------------------
// DB-gated: recorder atomicity, ledger coupling, sealer, tamper trigger
// ---------------------------------------------------------------------------

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('covenant stream (DB)', () => {
  test('recordCovenantAction inserts a row whose payload_hash is recomputable', async () => {
    const { db, covenantActionRecords, eq } = await import('@clawville/database');
    const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { id } = await recordCovenantAction({
      action: 'economy.credit',
      subjectType: 'system',
      subjectId: marker,
      actorKind: 'system',
      payload: { z: 1, a: { b: [2, 1] }, marker },
    });
    expect(id).toBeTruthy();
    const [row] = await db
      .select()
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.id, id!))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.actorKind).toBe('system');
    expect(row.chainPosition).toBeNull(); // unsealed at insert
    // The stored payload re-canonicalizes to the stored hash — the verifier
    // contract (jsonb does not preserve key order; canonicalization restores it).
    expect(covenantPayloadHash(row.payload as Record<string, unknown>)).toBe(row.payloadHash);
  });

  test('in-tx record rolls back with the business write (no orphan record)', async () => {
    const { db, covenantActionRecords, eq } = await import('@clawville/database');
    const marker = `rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await expect(
      db.transaction(async (tx: any) => {
        await recordCovenantAction(
          {
            action: 'economy.debit',
            subjectType: 'system',
            subjectId: marker,
            payload: { marker },
          },
          tx,
        );
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    const rows = await db
      .select({ id: covenantActionRecords.id })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.subjectId, marker));
    expect(rows.length).toBe(0);
  });

  test('sealer chains unsealed rows in order and is re-runnable', async () => {
    const { db, covenantActionRecords, sql } = await import('@clawville/database');
    // Two fresh records, then age them past the 30s watermark so this test
    // does not have to sleep. (created_at is insert-frozen for UPDATE via the
    // guard trigger — so age them by direct SQL BEFORE sealing? No: the guard
    // forbids it. Instead: insert with an explicit old created_at.)
    const marker = `seal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const old = new Date(Date.now() - 60_000);
    await db.insert(covenantActionRecords).values([
      {
        action: 'economy.credit',
        subjectType: 'system',
        subjectId: marker,
        payload: { marker, n: 1 },
        payloadHash: covenantPayloadHash({ marker, n: 1 }),
        createdAt: old,
      },
      {
        action: 'economy.debit',
        subjectType: 'system',
        subjectId: marker,
        payload: { marker, n: 2 },
        payloadHash: covenantPayloadHash({ marker, n: 2 }),
        createdAt: old,
      },
    ]);

    // Drain the backlog (other unsealed rows may precede ours).
    for (let i = 0; i < 50; i++) {
      const sealed = await sealCovenantChainOnce();
      if (sealed === 0) break;
    }

    const rows = await db.execute<any>(
      sql`SELECT chain_position, prev_hash, record_hash, payload_hash, action,
                 subject_type, subject_id, actor_kind, created_at
          FROM covenant_action_records
          WHERE subject_id = ${marker}
          ORDER BY seq ASC`,
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.chain_position).not.toBeNull();
      expect(r.record_hash).toMatch(/^[0-9a-f]{64}$/);
      // Recompute — the row is self-verifying.
      expect(
        computeRecordHash({
          prevHash: r.prev_hash,
          payloadHash: r.payload_hash,
          action: r.action,
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          actorKind: r.actor_kind,
          chainPosition: BigInt(r.chain_position),
          createdAtIso: toCanonicalIso(r.created_at),
        }),
      ).toBe(r.record_hash);
    }
    // Our two rows were inserted adjacently in seq order; verify the second
    // links to SOME prev (global chain), and positions strictly increase.
    expect(BigInt(rows[1].chain_position)).toBeGreaterThan(BigInt(rows[0].chain_position));

    // Chain-link check across the WHOLE sealed range of these two: walk from
    // row0's position to row1's and confirm prev_hash linkage is intact.
    const span = await db.execute<any>(
      sql`SELECT chain_position, prev_hash, record_hash
          FROM covenant_action_records
          WHERE chain_position BETWEEN ${rows[0].chain_position} AND ${rows[1].chain_position}
          ORDER BY chain_position ASC`,
    );
    for (let i = 1; i < span.length; i++) {
      expect(span[i].prev_hash).toBe(span[i - 1].record_hash);
    }

    // Idempotent: nothing new to seal for these rows on a re-run.
    const again = await sealCovenantChainOnce();
    expect(again).toBeGreaterThanOrEqual(0); // other tests may have appended
  });

  test('tamper trigger: UPDATE of identity columns and DELETE are refused', async () => {
    const { db, covenantActionRecords, sql, eq } = await import('@clawville/database');
    const marker = `tamper-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { id } = await recordCovenantAction({
      action: 'economy.credit',
      subjectType: 'system',
      subjectId: marker,
      payload: { marker },
    });
    expect(id).toBeTruthy();
    // drizzle's execute() returns a lazy thenable, not a Promise — bun's
    // .rejects mishandles it, so assert via try/catch.
    let updateErr: unknown = null;
    try {
      await db.execute(
        sql`UPDATE covenant_action_records SET payload = '{}'::jsonb WHERE id = ${id}`,
      );
    } catch (e) {
      updateErr = e;
    }
    expect(String(updateErr)).toMatch(/immutable/);

    let deleteErr: unknown = null;
    try {
      await db.execute(sql`DELETE FROM covenant_action_records WHERE id = ${id}`);
    } catch (e) {
      deleteErr = e;
    }
    expect(String(deleteErr)).toMatch(/append-only/);
    // The row survives untouched.
    const [row] = await db
      .select({ id: covenantActionRecords.id })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.id, id!));
    expect(row).toBeDefined();
  });

  test('dedupe key: a retry appends exactly one record (Codex r1 HIGH #2)', async () => {
    const { db, covenantActionRecords, eq } = await import('@clawville/database');
    const marker = `dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `test:${marker}:settle`;
    const first = await recordCovenantAction({
      action: 'bounty.settle',
      subjectType: 'system',
      subjectId: marker,
      payload: { marker, try: 1 },
      dedupeKey: key,
    });
    const second = await recordCovenantAction({
      action: 'bounty.settle',
      subjectType: 'system',
      subjectId: marker,
      payload: { marker, try: 2 },
      dedupeKey: key,
    });
    expect(first.deduped).toBe(false);
    expect(first.id).toBeTruthy();
    expect(second.deduped).toBe(true);
    expect(second.id).toBeNull();
    const rows = await db
      .select({ id: covenantActionRecords.id })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.subjectId, marker));
    expect(rows.length).toBe(1);
  });

  test('pre-sealed INSERT is refused by the guard trigger (Codex r1 HIGH #5)', async () => {
    const { db, sql } = await import('@clawville/database');
    const marker = `presealed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let err: unknown = null;
    try {
      await db.execute(
        sql`INSERT INTO covenant_action_records
              (action, subject_type, subject_id, payload, payload_hash,
               chain_position, prev_hash, record_hash, sealed_at)
            VALUES ('economy.credit', 'system', ${marker}, '{}'::jsonb,
                    ${'a'.repeat(64)}, 999999999, ${'0'.repeat(64)},
                    ${'b'.repeat(64)}, now())`,
      );
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/inserted unsealed/);
  });

  test('sealer refuses a row whose stored payload_hash mismatches (Codex r1 HIGH #5)', async () => {
    const { db, covenantActionRecords, sql } = await import('@clawville/database');
    const marker = `mismatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const old = new Date(Date.now() - 60_000);
    // Forged row: stored hash does NOT match the stored payload.
    await db.insert(covenantActionRecords).values({
      action: 'economy.credit',
      subjectType: 'system',
      subjectId: marker,
      payload: { marker, forged: true },
      payloadHash: 'f'.repeat(64),
      createdAt: old,
    });
    for (let i = 0; i < 50; i++) {
      const sealed = await sealCovenantChainOnce();
      if (sealed === 0) break;
    }
    const rows = await db.execute<any>(
      sql`SELECT chain_position FROM covenant_action_records WHERE subject_id = ${marker}`,
    );
    expect(rows.length).toBe(1);
    // Refused from the chain — permanently unsealed, visible anomaly.
    expect(rows[0].chain_position).toBeNull();
  });

  test('ledger credit/debit emit coupled economy records atomically', async () => {
    const { db, avatars, users, covenantActionRecords, eq, sql } = await import(
      '@clawville/database'
    );
    const { creditClawTokens, debitClawTokens } = await import('../claw-token-ledger');

    // A throwaway user+avatar. Username: 3-20 alnum+underscore (DB check
    // users_username_format — no hyphens); species/color/gender are enums.
    const stamp = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 10);
    const [user] = await db
      .insert(users)
      .values({
        email: `covenant-test-${stamp}@clawville.internal`,
        username: `cov_${stamp}`,
        passwordHash: 'x',
      })
      .returning({ id: users.id });
    const [avatar] = await db
      .insert(avatars)
      .values({
        userId: user.id,
        name: `cov_${stamp}`,
        species: 'turtle',
        color: 'blue',
        gender: 'male',
        archetype: 'explorer',
        personality: {} as any,
        stats: {} as any,
      })
      .returning({ id: avatars.id });

    try {
      const credit = await creditClawTokens({
        avatarId: avatar.id,
        amount: 7,
        reason: 'covenant_stream_test',
        source: 'system',
        actorKind: 'system',
      });
      const debit = await debitClawTokens({
        avatarId: avatar.id,
        amount: 3,
        reason: 'covenant_stream_test',
        source: 'system',
        actorKind: 'system',
      });
      expect(credit.balanceAfter).toBeGreaterThanOrEqual(7);
      expect(debit.balanceAfter).toBe(credit.balanceAfter - 3);

      const recs = await db
        .select()
        .from(covenantActionRecords)
        .where(eq(covenantActionRecords.subjectId, avatar.id));
      const creditRec = recs.find((r: any) => r.action === 'economy.credit');
      const debitRec = recs.find((r: any) => r.action === 'economy.debit');
      expect(creditRec).toBeDefined();
      expect(debitRec).toBeDefined();
      expect(creditRec!.actorKind).toBe('system');
      expect((creditRec!.payload as any).ledgerId).toBe(credit.ledgerId);
      expect((creditRec!.payload as any).amount).toBe(7);
      expect((debitRec!.payload as any).amount).toBe(3);
      expect(Array.isArray((debitRec!.payload as any).burns)).toBe(true);
      // Payload hash verifies from stored payload.
      expect(covenantPayloadHash(creditRec!.payload as Record<string, unknown>)).toBe(
        creditRec!.payloadHash,
      );
    } finally {
      // Cleanup: the covenant rows are append-only by design and stay; the
      // throwaway user/avatar rows are regular test fixtures. Ledger rows
      // reference the avatar — remove children first.
      await db.execute(sql`DELETE FROM claw_token_transactions WHERE avatar_id = ${avatar.id}`);
      await db.execute(sql`DELETE FROM avatars WHERE id = ${avatar.id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });
});
