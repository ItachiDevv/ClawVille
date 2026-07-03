/**
 * Cove Hold'em UNWEDGE — void a stuck in_progress hand + close its table +
 * cash the player's held stack out via the real ledger path.
 *
 * WHY THIS EXISTS: Increment 1b (`cove-holdem.ts`) closed the deal/action/close
 * idempotency gaps (deal-replay, terminal-replay-window, close-replay), but any
 * table that got WEDGED before this fix landed has an `in_progress` hand with
 * no legal way forward on the OLD code: every `POST /hand/deal` 409'd
 * `hand_in_progress`, and a duplicate TERMINAL `/action` 409'd `not_human_turn`
 * with the settled outcome never surfaced (see memory
 * `holdem-nonterminal-action-not-idempotent`). This script surgically frees
 * those tables so the player gets their stack back and can open a fresh table.
 *
 * KNOWN PROD WEDGED TABLES (sanity-check targets — the script finds wedged
 * tables GENERICALLY, these are NOT hardcoded into the query):
 *   - 0fd33f30-fd8b-4727-9126-aa9d335d059f (user 1285c7a0-cc39-4e96-9208-a08ff20011c5)
 *   - b3879a67-aabf-45d2-9877-248f4d167dab (user 46c1c96f-f016-464f-8e1d-23d5dc5febb6)
 *
 * VOID SEMANTICS (verified against `cove-holdem.ts`): `playerStack` is NOT
 * decremented mid-hand — chips only move within `playerStack` at SETTLE, and
 * only cross the ledger at buy-in (open) / cash-out (close). So during an
 * `in_progress` hand the table's `playerStack` still holds the player's FULL
 * pre-hand stack. VOID = mark the wedged hand `status='voided'`
 * (free-text column, no enum) WITHOUT touching `playerStack` — the player
 * keeps their whole stack, pays no rake, loses nothing. Bots are house seats
 * with no persistent bankroll, so voiding breaks no conservation invariant.
 *
 * Then the table is closed via the SAME ledger path as `POST /session/close`:
 * `creditClawTokens()` for a ledger subject (userId) — NEVER a direct
 * `avatars.clawTokens` write — or a zero-ledger-write demo close for a guest
 * (guestFpHash) table.
 *
 * Usage (from repo root):
 *   set -a; . "$TEMP/.cove-unwedge-env"; set +a     # exports DATABASE_URL + friends
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts               # DRY-RUN (default)
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --execute     # mutates
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --table <uuid> [--execute]
 *
 * Exit: 0 on success (including "nothing to do"), 1 on any FATAL error.
 */

// ---------------------------------------------------------------------------
// Crash-loud env vars MUST be present BEFORE importing any apps/api module.
// DATABASE_URL is required (this script writes real ledger/table rows, never a
// checked-in/auto-loaded env — export it explicitly per the header). Mirrors
// blackjack-hiddenstate-smoke.ts's convention.
// ---------------------------------------------------------------------------
function ensureEnv(k: string, v: string) {
  if (!process.env[k] || process.env[k]!.length === 0) process.env[k] = v;
}
const HEX32 = '0'.repeat(64);
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
if (!process.env.DATABASE_URL) {
  console.error(
    'FATAL: DATABASE_URL not set. Export the target DB explicitly first, e.g.:\n' +
      '  set -a; . "$TEMP/.cove-unwedge-env"; set +a\n' +
      '(NEVER rely on an auto-loaded .env.local — it could silently be prod.)',
  );
  process.exit(1);
}
// Same session-pooler adjustment as blackjack-hiddenstate-smoke.ts — a
// short-lived multi-statement script against the Supabase TRANSACTION-mode
// pooler (6543) can hit read-your-writes gaps across pooled connections; the
// SESSION-mode pooler (5432) gives one stable connection. Zero effect on the
// route/engine code under exercise here — same SQL, same primary DB.
if (process.env.DATABASE_URL.includes(':6543')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(':6543', ':5432');
}

import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  db,
  avatars,
  holdemTables,
  holdemHands,
  coveGameEvents,
} from '@clawville/database';
import { creditClawTokens } from '../../src/services/claw-token-ledger';

const DRY_RUN = !process.argv.includes('--execute');
const tableArgIdx = process.argv.indexOf('--table');
const ONLY_TABLE_ID = tableArgIdx >= 0 ? (process.argv[tableArgIdx + 1] ?? null) : null;

interface WedgedRow {
  tableId: string;
  userId: string | null;
  guestFpHash: string | null;
  playerStack: string;
  handId: string;
}

async function findWedgedTables(): Promise<WedgedRow[]> {
  const whereClause = ONLY_TABLE_ID
    ? and(
        eq(holdemTables.status, 'open'),
        eq(holdemHands.status, 'in_progress'),
        eq(holdemTables.id, ONLY_TABLE_ID),
      )
    : and(eq(holdemTables.status, 'open'), eq(holdemHands.status, 'in_progress'));

  const rows = await db
    .select({
      tableId: holdemTables.id,
      userId: holdemTables.userId,
      guestFpHash: holdemTables.guestFpHash,
      playerStack: holdemTables.playerStack,
      handId: holdemHands.id,
    })
    .from(holdemTables)
    .innerJoin(holdemHands, eq(holdemHands.tableId, holdemTables.id))
    .where(whereClause);

  return rows;
}

async function loadAvatarForUser(userId: string) {
  return db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true, clawTokens: true },
  });
}

async function planTable(w: WedgedRow): Promise<void> {
  console.log(`\n[unwedge-holdem] table=${w.tableId} hand=${w.handId}`);
  if (w.userId) {
    const avatar = await loadAvatarForUser(w.userId);
    if (!avatar) {
      console.log(`  WARN: no active avatar for user ${w.userId} — cannot cash out. SKIPPING (execute would abort this table).`);
      return;
    }
    console.log(`  pre: subject=user:${w.userId} avatar=${avatar.id} balance=${avatar.clawTokens} playerStack=${w.playerStack}`);
    console.log(
      `  PLAN: void hand ${w.handId}; close table; credit ${w.playerStack} CT to avatar ${avatar.id} via creditClawTokens(reason='cove_holdem_unwedge_cashout') → expected balance ${avatar.clawTokens + Number(BigInt(w.playerStack))}`,
    );
  } else {
    console.log(`  pre: subject=guest:${w.guestFpHash} playerStack=${w.playerStack} (demo — no ledger writes)`);
    console.log(`  PLAN: void hand ${w.handId}; close table; NO ledger write (guest demo stack discarded)`);
  }
}

async function executeTable(w: WedgedRow): Promise<void> {
  let avatarBefore: { id: string; clawTokens: number } | undefined;
  if (w.userId) {
    avatarBefore = await loadAvatarForUser(w.userId);
    if (!avatarBefore) {
      console.log(`  SKIP table=${w.tableId}: no active avatar for user ${w.userId} — cannot cash out safely.`);
      return;
    }
  }

  await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{
      id: string;
      status: string;
      player_stack: string;
      user_id: string | null;
      guest_fp_hash: string | null;
    }>(
      sql`SELECT id, status, player_stack, user_id, guest_fp_hash
          FROM holdem_tables WHERE id = ${w.tableId} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock || lock.status !== 'open') {
      console.log(`  SKIP table=${w.tableId}: no longer 'open' (state changed since scan).`);
      return;
    }

    const handLockRows = await tx.execute<{ id: string; status: string }>(
      sql`SELECT id, status FROM holdem_hands WHERE id = ${w.handId} FOR UPDATE`,
    );
    const handLock = handLockRows[0];
    if (!handLock || handLock.status !== 'in_progress') {
      console.log(`  SKIP hand=${w.handId}: no longer 'in_progress' (resolved externally since scan).`);
      return;
    }

    // VOID the wedged hand — NO playerStack write (see file header).
    await tx
      .update(holdemHands)
      .set({
        status: 'voided',
        outcomeJson: null,
        betAmount: '0',
        payout: '0',
        net: '0',
        settledAt: new Date(),
      })
      .where(and(eq(holdemHands.id, w.handId), eq(holdemHands.status, 'in_progress')));

    const cashOut = BigInt(lock.player_stack);
    let cashOutBalance: number | null = null;

    if (lock.user_id) {
      const avatar = avatarBefore!;
      if (cashOut > 0n) {
        if (cashOut > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`cashout_exceeds_supported_range: table=${w.tableId} amount=${cashOut}`);
        }
        const credit = await creditClawTokens(
          {
            avatarId: avatar.id,
            amount: Number(cashOut),
            reason: 'cove_holdem_unwedge_cashout',
            source: 'api',
            metadata: { tableId: w.tableId, kind: 'unwedge-cashout' },
          },
          tx,
        );
        cashOutBalance = credit.balanceAfter;
      } else {
        cashOutBalance = avatar.clawTokens;
      }
    }
    // Guest tables: NO ledger write — demo stack is simply discarded (mirrors
    // /session/close's guest posture, which is unreachable for guests anyway,
    // but this script closes on their behalf so the demo table stops wedging).

    const [closedTable] = await tx
      .update(holdemTables)
      .set({
        status: 'closed',
        playerStack: '0',
        cashOut: cashOut.toString(),
        closedAt: new Date(),
      })
      .where(eq(holdemTables.id, w.tableId))
      .returning();
    if (!closedTable) throw new Error(`table_close_failed: ${w.tableId}`);

    await tx
      .update(coveGameEvents)
      .set({ revealedServerSeed: closedTable.serverSeed })
      .where(and(eq(coveGameEvents.sessionId, w.tableId), eq(coveGameEvents.gameType, 'holdem')));

    if (lock.user_id) {
      console.log(
        `  DONE table=${w.tableId}: voided hand ${w.handId}; closed; cashOut=${cashOut.toString()}; avatar ${avatarBefore!.id} balance ${avatarBefore!.clawTokens} -> ${cashOutBalance}`,
      );
    } else {
      console.log(
        `  DONE table=${w.tableId}: voided hand ${w.handId}; closed; guest demo, no ledger write (cashOut recorded=${cashOut.toString()})`,
      );
    }
  });
}

async function main() {
  console.log(
    `[unwedge-holdem] mode=${DRY_RUN ? 'DRY-RUN (default — pass --execute to mutate)' : 'EXECUTE'}` +
      (ONLY_TABLE_ID ? ` table=${ONLY_TABLE_ID}` : ' (scanning ALL open tables with an in_progress hand)'),
  );

  const wedged = await findWedgedTables();
  if (wedged.length === 0) {
    console.log('[unwedge-holdem] no wedged tables found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[unwedge-holdem] found ${wedged.length} wedged table(s).`);

  for (const w of wedged) {
    if (DRY_RUN) {
      await planTable(w);
    } else {
      await executeTable(w);
    }
  }

  console.log(`\n[unwedge-holdem] done. tables=${wedged.length} mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[unwedge-holdem] FATAL:', err);
    process.exit(1);
  });
