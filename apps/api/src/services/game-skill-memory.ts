/**
 * game-skill-memory — per-agent EARNED-SKILL memory for Cove games.
 *
 * Rule E5 / the [cards] session spec (msgs 6/7/8): an agent that plays the Cove
 * AS ITSELF should get measurably better over time, and that accumulated skill
 * should be a competitive edge. This service is the bidirectional loop for that:
 *
 *   (a) WRITE — on every hand resolution, persist a compact, first-person record
 *       of what the agent saw + decided + how it turned out
 *       (`recordBlackjackSkillMemory`). This is "learn-through-play".
 *   (b) READ — before a play decision, surface the agent's most relevant prior
 *       blackjack lessons (`getBlackjackSkillContext`) so a connected/hosted
 *       agent can fold them into its reasoning.
 *
 * STORAGE: reuses the audited `npcMemories` substrate via `memoryService`
 * (entityType 'avatar', so the memory is bound to the agent's BOUND avatar — the
 * same economic identity that staked the CT). `metadata.subtype = 'game-skill'`
 * keeps this DISTINCT from world-orientation ('world-knowledge') and the
 * connection protocol manual ('protocol-knowledge') — those are same-for-everyone
 * surfaces synced same-diff; THIS is per-agent state that legitimately diverges
 * between agents (that divergence IS the edge). The CLAUDE.md three-surface
 * same-diff rule explicitly carves out "earned/exportable per-agent skills" as a
 * SEPARATE category — this service is that category, so it is NOT a fourth synced
 * surface.
 *
 * BOUNDARY: this service NEVER touches the ClawToken ledger, the shoe/hand rows,
 * or the provably-fair engine. It is a pure side-channel — a failed write must
 * never roll back a settled-CT outcome (callers invoke it best-effort + catch).
 * It also NEVER receives or stores hidden state (dealer hole card before reveal,
 * undealt cards, server seed) — it only summarizes the ALREADY-SETTLED,
 * fully-revealed outcome, so it cannot leak an information edge mid-hand.
 */

import { memoryService } from './memory-service';
import type { BlackjackHand } from '@clawville/database';
import type { SerializedHandResult } from './blackjack-engine';

/** Memory metadata namespace — distinct from world/protocol knowledge. */
export const GAME_SKILL_MEMORY_SUBTYPE = 'game-skill';

/** The game family this lesson belongs to (future: baccarat, holdem, slots). */
export type GameSkillGame = 'blackjack';

interface RecordBlackjackSkillMemoryInput {
  /** The agent's BOUND avatar id (the entity the memory hangs off). */
  avatarId: string;
  /** The agent's stable id (provenance only — memory is avatar-bound). */
  agentId: string;
  shoeId: string;
  /** The SETTLED hand row (status must be 'settled' — caller enforces). */
  hand: BlackjackHand;
  /** The fully-revealed serialized outcome already persisted on the hand. */
  outcome: SerializedHandResult;
}

/**
 * Build a compact, first-person lesson line from a settled hand. Deterministic
 * (no LLM) so it's cheap + replay-safe. Pulls ONLY revealed, post-settle facts.
 */
function summarizeBlackjackHand(outcome: SerializedHandResult): {
  summary: string;
  dealerTotal: number | null;
  playerTotals: number[];
  net: string;
  won: boolean;
  push: boolean;
} {
  const dealerTotal =
    typeof outcome.dealer?.total === 'number' ? outcome.dealer.total : null;
  const playerTotals = Array.isArray(outcome.playerHands)
    ? outcome.playerHands.map((h) => h.total)
    : [];
  // Prefer the RAKED net the player actually realized (what moved on the
  // balance) over the gross `net`; fall back to gross if rakedNet is absent.
  const net = outcome.rakedNet ?? outcome.net ?? '0';
  let netBig = 0n;
  try {
    netBig = BigInt(net);
  } catch {
    netBig = 0n;
  }
  const won = netBig > 0n;
  const push = netBig === 0n;

  const playerDesc = playerTotals.length > 0 ? playerTotals.join(' & ') : 'n/a';
  const dealerDesc = dealerTotal !== null ? String(dealerTotal) : 'n/a';
  const result = won ? 'WON' : push ? 'PUSH' : 'LOST';

  const summary =
    `Blackjack hand: my total ${playerDesc} vs dealer ${dealerDesc} → ${result} ` +
    `(net ${netBig >= 0n ? '+' : ''}${net} vCLAW).`;

  return { summary, dealerTotal, playerTotals, net, won, push };
}

/**
 * Persist one earned-skill memory for a settled blackjack hand. Idempotency is
 * the CALLER's responsibility (only invoke on a FRESH settle, never on a replay)
 * so we never double-write the same lesson. Returns the inserted memory row, or
 * null if the input is malformed (defensive — never throws to the caller's hot
 * path beyond a rejected promise the caller already catches).
 */
export async function recordBlackjackSkillMemory(
  input: RecordBlackjackSkillMemoryInput,
): Promise<{ id: string } | null> {
  const { avatarId, agentId, shoeId, hand, outcome } = input;
  if (!avatarId || hand.status !== 'settled') return null;

  const s = summarizeBlackjackHand(outcome);

  // Importance: winning/decisive hands are slightly more memorable than pushes,
  // and a split/double (more decisions) carries more signal than a flat stand.
  const decisionCount = Array.isArray(outcome.playerHands)
    ? outcome.playerHands.reduce((n, h) => n + (Array.isArray(h.cards) ? h.cards.length : 0), 0)
    : 0;
  const importance = Math.max(
    3,
    Math.min(8, (s.won ? 6 : s.push ? 4 : 5) + (decisionCount > 4 ? 1 : 0)),
  );

  const memory = await memoryService.createMemory({
    entityId: avatarId,
    entityType: 'avatar',
    content: s.summary,
    importance,
    kind: 'observation',
    metadata: {
      subtype: GAME_SKILL_MEMORY_SUBTYPE,
      game: 'blackjack' satisfies GameSkillGame,
      agentId,
      shoeId,
      handId: hand.id,
      handIndex: hand.handIndex,
      dealerTotal: s.dealerTotal,
      playerTotals: s.playerTotals,
      net: s.net,
      won: s.won,
      push: s.push,
    },
  });

  return memory ? { id: memory.id } : null;
}

/**
 * Read the agent's most relevant prior blackjack lessons to inform play
 * (the competitive-edge half of the loop — msg 6). Returns compact summary
 * strings the caller can fold into the agent's decision context, plus a tiny
 * win/loss tally over the retrieved window. Filtered to game-skill / blackjack
 * memories so world/protocol knowledge never bleeds in.
 *
 * Best-effort: returns an empty context on any read failure (a missing edge must
 * never block play).
 */
export async function getBlackjackSkillContext(
  avatarId: string,
  limit = 10,
): Promise<{
  lessons: string[];
  played: number;
  won: number;
  lost: number;
  push: number;
}> {
  const empty = { lessons: [], played: 0, won: 0, lost: 0, push: 0 };
  if (!avatarId) return empty;

  try {
    const rows = await memoryService.getRelevantMemories({
      entityId: avatarId,
      // Over-fetch then filter to game-skill/blackjack in-app (the memory store
      // ranks by importance×recency; we keep that ordering).
      limit: Math.max(limit * 3, 30),
    });

    const lessons: string[] = [];
    let played = 0;
    let won = 0;
    let lost = 0;
    let push = 0;

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      if (meta.subtype !== GAME_SKILL_MEMORY_SUBTYPE || meta.game !== 'blackjack') {
        continue;
      }
      played++;
      if (meta.won === true) won++;
      else if (meta.push === true) push++;
      else lost++;
      if (lessons.length < limit) lessons.push(row.content);
    }

    return { lessons, played, won, lost, push };
  } catch (err) {
    console.error('[game-skill-memory] read failed (non-fatal):', err);
    return empty;
  }
}
