/**
 * Executed spend-rules contract against DATABASE_URL (migration 0089): the
 * CHECK constraints, the upsert under concurrent writes, a missing row read as
 * unset, and the new `sessions.created_via` column.
 *
 * Skips cleanly when DATABASE_URL is absent OR migration 0089 is not applied to
 * the target database (the CI route lane migrates its test database first).
 * Fixtures are tagged and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as dbMod from '@clawville/database';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { applySpendPolicyChange, readSpendPolicy, writeSpendPolicy } from '../../services/spend-policy';
import { issueSpendProofChallenge } from '../../services/spend-policy-proof';

const { db, sql } = dbMod;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('spend-policy DB fixture query returned no row');
  return row;
}

async function failureCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (err) {
    const failure = err as { code?: string; cause?: { code?: string } };
    return failure.code ?? failure.cause?.code;
  }
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const tables = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'user_spend_policies'`,
    );
    const cols = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'created_via'`,
    );
    schemaReady = Number(first(tables).n) === 1 && Number(first(cols).n) === 1;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) console.warn('[spend-policy-db] SKIPPING: migration 0089 is not applied to this DATABASE_URL yet.');
}

const describeIfSchema = schemaReady ? describe : describe.skip;

describeIfSchema('spend rules: executed DB contract', () => {
  const tag = `sp${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Spend Policy DB Test')
          RETURNING id`,
    );
    userId = first(users).id;
    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
             ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
             ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb,
             0, 0, 0, 0, true, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`).catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('reads a missing row as unset caps', async () => {
    expect(await readSpendPolicy(avatarId)).toMatchObject({
      dailyCapUsdCents: null,
      perCallCapUsdCents: null,
      allowedVendors: [],
      configured: false,
    });
  });

  it('upserts one row per avatar, also under concurrent writes', async () => {
    const writes = await Promise.all(
      [100, 200, 300, 400].map((cents) =>
        writeSpendPolicy(avatarId, userId, {
          dailyCapUsdCents: cents,
          perCallCapUsdCents: 10,
          allowedVendors: ['studios'],
        })),
    );
    expect(writes.every((view) => view.configured)).toBe(true);
    const rows = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM user_spend_policies WHERE avatar_id = ${avatarId}`,
    );
    expect(Number(first(rows).n)).toBe(1);
    const view = await readSpendPolicy(avatarId);
    expect([100, 200, 300, 400]).toContain(view.dailyCapUsdCents ?? -1);
    expect(view).toMatchObject({ perCallCapUsdCents: 10, allowedVendors: ['studios'], configured: true });
  });

  it('can clear a cap back to unset', async () => {
    const view = await writeSpendPolicy(avatarId, userId, {
      dailyCapUsdCents: null,
      perCallCapUsdCents: 10,
      allowedVendors: [],
    });
    expect(view).toMatchObject({ dailyCapUsdCents: null, configured: false });
  });

  it('enforces the CHECK constraints in the database itself', async () => {
    const bad = [
      sql`UPDATE user_spend_policies SET daily_cap_usd_cents = 10, per_call_cap_usd_cents = 11 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET daily_cap_usd_cents = -1 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET per_call_cap_usd_cents = 100001 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET studios_key_images_per_day = 1001 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET studios_key_images_per_day = -1 WHERE avatar_id = ${avatarId}`,
    ];
    for (const statement of bad) {
      expect(await failureCode(() => db.execute(statement))).toBe('23514');
    }
  });

  it('needs a linked wallet and its signature to raise, never to lower', async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`UPDATE users SET linked_wallet_pubkey = NULL WHERE id = ${userId}`);
    const raise = { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: ['studios' as const], studiosKeyImagesPerDay: 10, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: false };

    expect(await applySpendPolicyChange(avatarId, userId, raise, null)).toEqual({ kind: 'needs_wallet_link' });

    const wallet = nacl.sign.keyPair();
    const walletPubkey = bs58.encode(wallet.publicKey);
    await db.execute(sql`UPDATE users SET linked_wallet_pubkey = ${walletPubkey} WHERE id = ${userId}`);
    expect(await applySpendPolicyChange(avatarId, userId, raise, null)).toEqual({ kind: 'needs_wallet_proof' });

    const challenge = issueSpendProofChallenge(userId, raise);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), wallet.secretKey));
    const saved = await applySpendPolicyChange(avatarId, userId, raise, { nonce: challenge.nonce, signature });
    expect(saved.kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ dailyCapUsdCents: 500, perCallCapUsdCents: 50, configured: true });

    // The same proof cannot be replayed.
    const replay = await applySpendPolicyChange(avatarId, userId, { ...raise, dailyCapUsdCents: 900 }, { nonce: challenge.nonce, signature });
    expect(replay).toEqual({ kind: 'invalid_proof', reason: 'invalid_challenge' });

    // Lower and equal changes save without a proof.
    expect((await applySpendPolicyChange(avatarId, userId, { ...raise, dailyCapUsdCents: 100 }, null)).kind).toBe('saved');
    expect((await applySpendPolicyChange(avatarId, userId, { ...raise, dailyCapUsdCents: 100 }, null)).kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ dailyCapUsdCents: 100 });
  });

  it('treats more own-key images as a raise, fewer as a lower change, and keeps the count when left out', async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`);
    const wallet = nacl.sign.keyPair();
    await db.execute(sql`UPDATE users SET linked_wallet_pubkey = ${bs58.encode(wallet.publicKey)} WHERE id = ${userId}`);
    const unset = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] as 'studios'[], requireApproval: false };
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosKeyImagesPerDay: 10 });

    // Lower than the default: no signature. Left out later: the saved 4 stays.
    expect((await applySpendPolicyChange(avatarId, userId, { ...unset, studiosKeyImagesPerDay: 4 }, null)).kind).toBe('saved');
    expect((await applySpendPolicyChange(avatarId, userId, unset, null)).kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosKeyImagesPerDay: 4 });

    // Back up to 30: a raise, so it needs the linked wallet's signature over 30.
    const more = { ...unset, studiosKeyImagesPerDay: 30 };
    expect(await applySpendPolicyChange(avatarId, userId, more, null)).toEqual({ kind: 'needs_wallet_proof' });
    const classes = { studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1 };
    const lowProof = issueSpendProofChallenge(userId, { ...unset, ...classes, studiosKeyImagesPerDay: 4 });
    const lowSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(lowProof.messageToSign), wallet.secretKey));
    expect(await applySpendPolicyChange(avatarId, userId, more, { nonce: lowProof.nonce, signature: lowSig }))
      .toEqual({ kind: 'invalid_proof', reason: 'invalid_challenge' });
    const challenge = issueSpendProofChallenge(userId, { ...more, ...classes });
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), wallet.secretKey));
    expect((await applySpendPolicyChange(avatarId, userId, more, { nonce: challenge.nonce, signature })).kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosKeyImagesPerDay: 30 });
  });

  it('per-class Studios counts (migration 0095): defaults, 0 turns a class off without a signature, a raise needs one', async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`);
    const wallet = nacl.sign.keyPair();
    await db.execute(sql`UPDATE users SET linked_wallet_pubkey = ${bs58.encode(wallet.publicKey)} WHERE id = ${userId}`);
    const unset = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] as 'studios'[], requireApproval: false };
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1 });
    expect((await applySpendPolicyChange(avatarId, userId, { ...unset, studiosVideosPerDay: 0, studiosRecastsPerDay: 0 }, null)).kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosVideosPerDay: 0, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 0 });
    const raise = { ...unset, studiosVideosPerDay: 3 };
    expect(await applySpendPolicyChange(avatarId, userId, raise, null)).toEqual({ kind: 'needs_wallet_proof' });
    const values = { ...unset, studiosKeyImagesPerDay: 10, studiosVideosPerDay: 3, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 0 };
    const challenge = issueSpendProofChallenge(userId, values);
    expect(challenge.messageToSign).toContain('Studios videos per day: 3\nStudios character shots per day: 5\nStudios recasts per day: 0\n');
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), wallet.secretKey));
    expect((await applySpendPolicyChange(avatarId, userId, raise, { nonce: challenge.nonce, signature })).kind).toBe('saved');
    expect(await readSpendPolicy(avatarId)).toMatchObject({ studiosVideosPerDay: 3, studiosRecastsPerDay: 0 });
    // The typo guard is the CHECK in 0095 too.
    let refused = false;
    try {
      await db.execute(sql`UPDATE user_spend_policies SET studios_recasts_per_day = 1001 WHERE avatar_id = ${avatarId}`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('never lets an unchecked write become a raise under a concurrent lower change', async () => {
    for (let round = 0; round < 8; round += 1) {
      await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: [] });
      const [same, lower] = await Promise.all([
        applySpendPolicyChange(avatarId, userId, { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: [] }, null),
        applySpendPolicyChange(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 50, allowedVendors: [] }, null),
      ]);
      expect(lower.kind).toBe('saved');
      const view = await readSpendPolicy(avatarId);
      // Either the equal write ran first (then the lower one wins), or it ran
      // second and was refused as a raise. The cap is never back at 500.
      expect(view.dailyCapUsdCents).toBe(100);
      expect(['saved', 'needs_wallet_proof', 'needs_wallet_link']).toContain(same.kind);
    }
  });

  it('refuses a proof from a wallet that a concurrent change replaces', async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`);
    const walletA = nacl.sign.keyPair();
    const pubA = bs58.encode(walletA.publicKey);
    const pubB = bs58.encode(nacl.sign.keyPair().publicKey);
    await db.execute(sql`UPDATE users SET linked_wallet_pubkey = ${pubA} WHERE id = ${userId}`);
    const raise = { dailyCapUsdCents: 700, perCallCapUsdCents: 70, allowedVendors: ['studios' as const], studiosKeyImagesPerDay: 10, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: false };
    const challenge = issueSpendProofChallenge(userId, raise);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), walletA.secretKey));

    // A wallet change holds the row lock (as POST /api/wallet/link does) ...
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const change = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT linked_wallet_pubkey FROM users WHERE id = ${userId} FOR UPDATE`);
      markLocked();
      await gate;
      await tx.execute(sql`UPDATE users SET linked_wallet_pubkey = ${pubB} WHERE id = ${userId}`);
    });
    await locked;
    // ... while the raise signed by wallet A starts. It must wait, then see B.
    const raised = applySpendPolicyChange(avatarId, userId, raise, { nonce: challenge.nonce, signature });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await change;
    expect(await raised).toEqual({ kind: 'invalid_proof', reason: 'invalid_signature' });
    expect(await readSpendPolicy(avatarId)).toMatchObject({ dailyCapUsdCents: null, configured: false });
  });

  it('stores the session origin label', async () => {
    const id = `${tag}-session`;
    await db.execute(
      sql`INSERT INTO sessions (id, user_id, expires_at, created_via)
          VALUES (${id}, ${userId}, now() + interval '1 hour', 'agent_exchange')`,
    );
    const rows = await db.execute<{ created_via: string | null }>(
      sql`SELECT created_via FROM sessions WHERE id = ${id}`,
    );
    expect(first(rows).created_via).toBe('agent_exchange');
  });
});
