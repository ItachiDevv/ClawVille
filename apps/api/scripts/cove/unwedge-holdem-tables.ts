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
 * ── BLAST-RADIUS SAFETY (Codex gate, 2026-07-03) ─────────────────────────────
 * `--execute` REFUSES to run unless the operator has SCOPED the run — an
 * unscoped mutate would void EVERY open+in_progress hand, INCLUDING a player
 * who is mid-`/action` right now (terminal losing action appended, `settleHand`
 * not yet reached) — voiding their hand and refunding their full stack (a
 * live-play money bug). So `--execute` requires EITHER:
 *   --table <uuid>     (repeatable — target specific known-wedged tables), OR
 *   --stale-hours <n>  (n >= 1, no default — only hands older than n hours),
 * or both. On top of the scope, the void is re-validated UNDER the row lock
 * against the DB CLOCK: a hand must be at least `--stale-hours` old (or, in bare
 * `--table` mode, a 10-minute typo-guard floor) or it is SKIPPED. Dry-run (the
 * default) mutates nothing and may scan everything.
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
 *   - LEDGER subject (userId): `creditClawTokens()` credits the full stack back
 *     to the bound avatar — NEVER a direct `avatars.clawTokens` write.
 *   - GUEST table (guestFpHash): NO ledger write at all — the demo stack is
 *     simply discarded, no `claw_token_transactions` audit row (guest chips are
 *     demo money that never touched the ledger).
 *
 * Usage (from repo root):
 *   set -a; . "$TEMP/.cove-unwedge-env"; set +a           # exports DATABASE_URL + friends
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts                       # DRY-RUN (scans all)
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --table <uuid> --execute
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --table <a> --table <b> --execute
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --stale-hours 6 --execute
 *   cd apps/api && bun run scripts/cove/unwedge-holdem-tables.ts --stale-hours 6           # dry-run preview of that window
 *
 * Exit: 0 on success (including "nothing to do"), 1 on any FATAL error.
 */

// ---------------------------------------------------------------------------
// Crash-loud env vars MUST be present BEFORE importing any apps/api module.
// DATABASE_URL is required (this script writes real ledger/table rows, never a
// checked-in/auto-loaded env; export it explicitly per the header). Mirrors
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

import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  db,
  avatars,
  holdemTables,
  holdemHands,
  coveGameEvents,
} from '@clawville/database';
import { creditClawTokens } from '../../src/services/claw-token-ledger';

// ── Arg parsing + BLAST-RADIUS gate ──────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const DRY_RUN = !EXECUTE;

// `--table <uuid>` is REPEATABLE (target one or more specific known-wedged tables).
const TABLE_IDS: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--table') {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      console.error('FATAL: --table requires a <uuid> argument.');
      process.exit(1);
    }
    if (!UUID_RE.test(v)) {
      console.error(`FATAL: --table value is not a UUID: ${v}`);
      process.exit(1);
    }
    TABLE_IDS.push(v);
  }
}

// `--stale-hours <n>` — only void hands whose in_progress hand is older than
// <n> hours (DB clock). Floor 1, NO default. Its presence (or --table) is what
// unlocks --execute.
let STALE_HOURS: number | null = null;
const staleIdx = argv.indexOf('--stale-hours');
if (staleIdx >= 0) {
  const raw = argv[staleIdx + 1];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    console.error(
      `FATAL: --stale-hours requires an integer >= 1 (got ${raw ?? '<missing>'}).`,
    );
    process.exit(1);
  }
  STALE_HOURS = n;
}

// --execute BLAST-RADIUS GATE: refuse to mutate unless the operator has SCOPED
// the run. Without this, --execute would void EVERY open+in_progress hand,
// including a player mid-/action — voiding their hand + refunding their full
// stack (a live-play money bug). Dry-run may still scan everything (it mutates
// nothing).
if (EXECUTE && TABLE_IDS.length === 0 && STALE_HOURS === null) {
  console.error(
    'FATAL: --execute requires an explicit scope — refusing to void EVERY open\n' +
      '       in_progress hand (a player mid-action would be voided + refunded).\n' +
      '       Pass --table <uuid> (repeatable) and/or --stale-hours <n> (n>=1).\n' +
      '       Run WITHOUT --execute first to preview (dry-run scans everything).',
  );
  process.exit(1);
}

// The minimum age (minutes, DB CLOCK) a hand must have to be voided. In
// --stale-hours mode this is the operator's window; in bare --table mode it is
// a 10-minute typo-guard so an operator can't void a hand dealt seconds ago.
const REQUIRED_AGE_MINUTES = STALE_HOURS !== null ? STALE_HOURS * 60 : 10;

interface WedgedRow {
  tableId: string;
  userId: string | null;
  guestFpHash: string | null;
  playerStack: string;
  handId: string;
  handCreatedAt: Date;
  lastHandAt: Date | null;
}

async function findWedgedTables(): Promise<WedgedRow[]> {
  const conds = [
    eq(holdemTables.status, 'open'),
    eq(holdemHands.status, 'in_progress'),
  ];
  if (TABLE_IDS.length > 0) {
    conds.push(inArray(holdemTables.id, TABLE_IDS));
  }
  // In --stale-hours mode, pre-filter the SCAN to the DB-clock window so the
  // dry-run preview matches the execute set. (The under-lock re-check below is
  // the authoritative gate regardless.)
  if (STALE_HOURS !== null) {
    conds.push(
      sql`${holdemHands.createdAt} < now() - make_interval(mins => ${REQUIRED_AGE_MINUTES}::int)`,
    );
  }

  const rows = await db
    .select({
      tableId: holdemTables.id,
      userId: holdemTables.userId,
      guestFpHash: holdemTables.guestFpHash,
      playerStack: holdemTables.playerStack,
      handId: holdemHands.id,
      handCreatedAt: holdemHands.createdAt,
      lastHandAt: holdemTables.lastHandAt,
    })
    .from(holdemTables)
    .innerJoin(holdemHands, eq(holdemHands.tableId, holdemTables.id))
    .where(and(...conds));

  return rows;
}

async function loadAvatarForUser(userId: string) {
  return db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true, clawTokens: true },
  });
}

/** Approximate age for the dry-run PREVIEW (client clock). The EXECUTE path
 * re-checks against the DB clock under the row lock — this is display only. */
function approxAgeMinutes(created: Date): number {
  return Math.floor((Date.now() - created.getTime()) / 60_000);
}

async function planTable(w: WedgedRow): Promise<void> {
  const ageMin = approxAgeMinutes(w.handCreatedAt);
  const qualifies = ageMin >= REQUIRED_AGE_MINUTES;
  console.log(
    `\n[unwedge-holdem] table=${w.tableId} hand=${w.handId} handAge≈${ageMin}min ` +
      `(min ${REQUIRED_AGE_MINUTES}min → ${qualifies ? 'QUALIFIES' : 'TOO YOUNG — would SKIP under lock'})`,
  );
  if (w.userId) {
    const avatar = await loadAvatarForUser(w.userId);
    if (!avatar) {
      console.log(
        `  WARN: no active avatar for user ${w.userId} — cannot cash out. Would SKIP.`,
      );
      return;
    }
    console.log(
      `  pre: subject=user:${w.userId} avatar=${avatar.id} balance=${avatar.clawTokens} playerStack=${w.playerStack}`,
    );
    console.log(
      `  PLAN: void hand ${w.handId}; close table; credit ${w.playerStack} CT to avatar ${avatar.id} via creditClawTokens(reason='cove_holdem_unwedge_cashout') → expected balance ${avatar.clawTokens + Number(BigInt(w.playerStack))}`,
    );
  } else {
    console.log(
      `  pre: subject=guest:${w.guestFpHash} playerStack=${w.playerStack} (demo — NO ledger write)`,
    );
    console.log(
      `  PLAN: void hand ${w.handId}; close table; NO ledger write, NO claw_token_transactions audit row (guest demo stack discarded)`,
    );
  }
}

async function executeTable(w: WedgedRow): Promise<void> {
  let avatarBefore: { id: string; clawTokens: number } | undefined;
  if (w.userId) {
    avatarBefore = await loadAvatarForUser(w.userId);
    if (!avatarBefore) {
      console.log(
        `  SKIP table=${w.tableId}: no active avatar for user ${w.userId} — cannot cash out safely.`,
      );
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

    // Re-validate wedged-ness UNDER the lock with stronger evidence than status
    // alone (Codex gate): the hand must still be in_progress AND at least
    // REQUIRED_AGE_MINUTES old against the DB CLOCK. This is what stops a
    // live/just-dealt hand from being voided even if it slipped into the scan
    // set (or an operator --table typo targets a fresh hand).
    const handLockRows = await tx.execute<{
      id: string;
      status: string;
      meets_age: boolean;
    }>(
      sql`SELECT id, status,
                 (created_at < now() - make_interval(mins => ${REQUIRED_AGE_MINUTES}::int)) AS meets_age
          FROM holdem_hands WHERE id = ${w.handId} FOR UPDATE`,
    );
    const handLock = handLockRows[0];
    if (!handLock || handLock.status !== 'in_progress') {
      console.log(
        `  SKIP hand=${w.handId}: no longer 'in_progress' (resolved externally since scan).`,
      );
      return;
    }
    if (!handLock.meets_age) {
      console.log(
        `  SKIP hand=${w.handId}: younger than the required ${REQUIRED_AGE_MINUTES}min floor (DB clock) — refusing to void a possibly-live hand.`,
      );
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
    // Guest tables: NO ledger write — the demo stack is simply discarded (no
    // claw_token_transactions audit row). Guest chips are demo money that never
    // touched the ledger; /session/close is unreachable for guests anyway, so
    // this script closes on their behalf purely to stop the demo table wedging.

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
        `  DONE table=${w.tableId}: voided hand ${w.handId}; closed; guest demo — NO ledger write, NO audit row (cashOut recorded=${cashOut.toString()})`,
      );
    }
  });
}

async function main() {
  console.log(
    `[unwedge-holdem] mode=${DRY_RUN ? 'DRY-RUN (default — pass --execute to mutate)' : 'EXECUTE'}` +
      (TABLE_IDS.length ? ` tables=[${TABLE_IDS.join(', ')}]` : '') +
      (STALE_HOURS !== null ? ` stale-hours=${STALE_HOURS}` : '') +
      (DRY_RUN && TABLE_IDS.length === 0 && STALE_HOURS === null
        ? ' (scanning ALL open tables with an in_progress hand)'
        : '') +
      ` minAge=${REQUIRED_AGE_MINUTES}min`,
  );

  const wedged = await findWedgedTables();
  if (wedged.length === 0) {
    console.log('[unwedge-holdem] no wedged tables found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[unwedge-holdem] found ${wedged.length} candidate table(s).`);

  for (const w of wedged) {
    if (DRY_RUN) {
      await planTable(w);
    } else {
      await executeTable(w);
    }
  }

  console.log(
    `\n[unwedge-holdem] done. candidates=${wedged.length} mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[unwedge-holdem] FATAL:', err);
    process.exit(1);
  });
