import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { api } from '@/lib/api';
import {
  type QuestId,
  type QuestStatus,
  type CounterKey,
  type DistinctSetKey,
  type QuestCondition,
  type QuestDefinition,
  QUEST_DEFINITIONS,
} from '@/lib/quests';

export interface QuestProgress {
  status: QuestStatus;
  completedAt?: number;
}

interface QuestCounters {
  systemAgentMessagesSent: number;
  avatarMessagesSent: number;
  characterMessagesSent: number;
  booksBought: number;
  itemsBought: number;
  knowledgeLearned: number;
  cosmeticsEquipped: number;
  activityMatchesPlayed: number;
  activityMatchesWon: number;
}

type DistinctSets = Record<DistinctSetKey, Record<string, true>>;

interface QuestStoreState {
  progress: Record<QuestId, QuestProgress>;
  counters: QuestCounters;
  distinct: DistinctSets;
  serverClaimed: Partial<Record<QuestId, boolean>>;
  /**
   * Which ACCOUNT (non-guest userId) this persisted progress belongs to,
   * or null for anonymous/guest-era progress that is still claimable by
   * whichever account it upgrades into. IdentityTransitionWatcher
   * reconciles this on every auth resolution: a resolved account that
   * doesn't match a non-null owner gets a fresh store (Codex review
   * BLOCKING 5 — an expired user's localStorage progress must not ride an
   * "anonymous→account" upgrade into someone else's account).
   */
  ownerUserId: string | null;

  incrementCounter: (key: CounterKey, amount?: number) => void;
  recordDistinct: (setKey: DistinctSetKey, value: string) => void;
  checkAndCompleteQuests: () => QuestId[];
  markServerClaimed: (id: QuestId) => void;
  getActiveQuests: () => QuestId[];
  isCompleted: (id: QuestId) => boolean;
  getStatus: (id: QuestId) => QuestStatus;
  getProgress: (id: QuestId) => number;

  /**
   * Full reset to defaults. Called by the auth-transition sweep
   * (`clearIdentityState`) on logout/account-switch/expiry ONLY — never on
   * guest→signup/login, where local progress must survive so the new account
   * can claim tutorial rewards it earned as a guest ("Sign up to claim").
   * The persist middleware writes the fresh state through to localStorage,
   * so the next identity doesn't inherit this one's progress.
   */
  resetQuestStore: () => void;

  /** Stamp the account that owns the current progress (watcher reconcile). */
  setQuestOwner: (userId: string) => void;

  /**
   * Quest-board restore (2026-07-29): re-mark quests the SERVER knows this
   * account claimed (tutorial_quest_claims) as completed + serverClaimed,
   * then unlock any quest whose prerequisite chain is now fully completed.
   * Never downgrades local state; unknown/superseded quest ids are ignored.
   * Counters have no server record and are NOT restored.
   */
  applyServerClaims: (
    claims: Array<{ questId: string; claimedAt: string }>,
  ) => void;
}

function getDefaultProgress(): Record<QuestId, QuestProgress> {
  const progress: Record<string, QuestProgress> = {};
  for (const q of QUEST_DEFINITIONS) {
    progress[q.id] = {
      status: q.prerequisites.length === 0 ? 'active' : 'locked',
    };
  }
  return progress as Record<QuestId, QuestProgress>;
}

const DEFAULT_COUNTERS: QuestCounters = {
  systemAgentMessagesSent: 0,
  avatarMessagesSent: 0,
  characterMessagesSent: 0,
  booksBought: 0,
  itemsBought: 0,
  knowledgeLearned: 0,
  cosmeticsEquipped: 0,
  activityMatchesPlayed: 0,
  activityMatchesWon: 0,
};

const DEFAULT_DISTINCT: DistinctSets = {
  distinctTeachersChatted: {},
  distinctActivityTypes: {},
  distinctBookBuildings: {},
};

interface CondEvalContext {
  counters: QuestCounters;
  distinct: DistinctSets;
  visitedBuildingsSize: number;
  hasAgentBot: boolean;
}

function evalCondition(
  cond: QuestCondition,
  ctx: CondEvalContext,
): { met: boolean; ratio: number } {
  switch (cond.type) {
    case 'counter': {
      const v = ctx.counters[cond.counterKey] ?? 0;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'visitedBuildings': {
      const v = ctx.visitedBuildingsSize;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'distinctSet': {
      const v = Object.keys(ctx.distinct[cond.setKey] ?? {}).length;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'openClaw':
      return { met: ctx.hasAgentBot, ratio: ctx.hasAgentBot ? 1 : 0 };
    case 'compound': {
      const sub = cond.predicates.map((p) => evalCondition(p, ctx));
      const met = sub.every((s) => s.met);
      const ratio = sub.reduce((s, r) => s + r.ratio, 0) / Math.max(1, sub.length);
      return { met, ratio };
    }
    case 'pending':
    case 'serverOnly':
      return { met: false, ratio: 0 };
  }
}

function buildEvalContext(state: QuestStoreState): CondEvalContext {
  return {
    counters: state.counters,
    distinct: state.distinct,
    visitedBuildingsSize: useGameStore.getState().visitedBuildings.size,
    hasAgentBot: useNpcStore.getState().npcs.some((npc) => npc.isOpenClaw),
  };
}

/**
 * Per-page-load dedup for the server-claims restore fetch: one successful
 * sync per account. Cleared by resetQuestStore so a wipe (expiry/switch)
 * followed by a re-login of the same account re-syncs, and cleared on fetch
 * failure so the next invocation retries.
 */
let lastClaimsSyncAccount: string | null = null;

export const useQuestStore = create<QuestStoreState>()(
  persist(
    (set, get) => ({
      progress: getDefaultProgress(),
      counters: { ...DEFAULT_COUNTERS },
      distinct: { ...DEFAULT_DISTINCT },
      serverClaimed: {},
      ownerUserId: null,

      markServerClaimed: (id) =>
        set((s) => ({ serverClaimed: { ...s.serverClaimed, [id]: true } })),

      resetQuestStore: () => {
        // A wipe means whatever account resolves next must re-pull its
        // server-side claims — drop the sync dedup marker with the state.
        lastClaimsSyncAccount = null;
        set({
          progress: getDefaultProgress(),
          counters: { ...DEFAULT_COUNTERS },
          distinct: { ...DEFAULT_DISTINCT },
          serverClaimed: {},
          ownerUserId: null,
        });
      },

      setQuestOwner: (userId) => set({ ownerUserId: userId }),

      applyServerClaims: (claims) => {
        const state = get();
        const progress = { ...state.progress };
        const serverClaimed = { ...state.serverClaimed };
        let changed = false;

        for (const claim of claims) {
          const def = QUEST_DEFINITIONS.find((q) => q.id === claim.questId);
          if (!def) continue; // superseded id from an older quest ladder
          const qid = def.id;
          if (!serverClaimed[qid]) {
            serverClaimed[qid] = true;
            changed = true;
          }
          if (progress[qid]?.status !== 'completed') {
            const at = Date.parse(claim.claimedAt);
            progress[qid] = {
              status: 'completed',
              completedAt: Number.isFinite(at) ? at : Date.now(),
            };
            changed = true;
          }
        }
        if (!changed) return;

        // Unlock pass — single sweep suffices: every server-known completion
        // was applied above, so a locked quest whose full prerequisite chain
        // is claimed has all prereqs already marked completed.
        for (const quest of QUEST_DEFINITIONS) {
          if (progress[quest.id]?.status !== 'locked') continue;
          const allPrereqsMet = quest.prerequisites.every(
            (pid) => progress[pid]?.status === 'completed',
          );
          if (allPrereqsMet) progress[quest.id] = { status: 'active' };
        }

        set({ progress, serverClaimed });
      },

      incrementCounter: (key, amount = 1) => {
        set((s) => ({
          counters: { ...s.counters, [key]: (s.counters[key] ?? 0) + amount },
        }));
      },

      recordDistinct: (setKey, value) => {
        set((s) => {
          const existing = s.distinct[setKey] ?? {};
          if (existing[value]) return s;
          return {
            distinct: {
              ...s.distinct,
              [setKey]: { ...existing, [value]: true as const },
            },
          };
        });
      },

      checkAndCompleteQuests: () => {
        const state = get();
        const ctx = buildEvalContext(state);
        const completed: QuestId[] = [];
        const updatedProgress = { ...state.progress };
        let changed = false;

        for (const quest of QUEST_DEFINITIONS) {
          const current = updatedProgress[quest.id];
          if (!current || current.status === 'completed') continue;

          if (current.status === 'locked') {
            const allPrereqsMet = quest.prerequisites.every(
              (pid) => updatedProgress[pid]?.status === 'completed'
            );
            if (allPrereqsMet) {
              updatedProgress[quest.id] = { status: 'active' };
              changed = true;
            } else {
              continue;
            }
          }

          const { met } = evalCondition(quest.condition, ctx);
          if (met) {
            updatedProgress[quest.id] = {
              status: 'completed',
              completedAt: Date.now(),
            };
            completed.push(quest.id);
            changed = true;
          }
        }

        if (completed.length > 0) {
          for (const quest of QUEST_DEFINITIONS) {
            if (updatedProgress[quest.id]?.status !== 'locked') continue;
            const allPrereqsMet = quest.prerequisites.every(
              (pid) => updatedProgress[pid]?.status === 'completed'
            );
            if (allPrereqsMet) {
              updatedProgress[quest.id] = { status: 'active' };
              changed = true;
            }
          }
        }

        if (changed) set({ progress: updatedProgress });
        return completed;
      },

      getActiveQuests: () => {
        const { progress } = get();
        return QUEST_DEFINITIONS.filter((q) => progress[q.id]?.status === 'active').map(
          (q) => q.id
        );
      },

      isCompleted: (id) => get().progress[id]?.status === 'completed',

      getStatus: (id) => get().progress[id]?.status ?? 'locked',

      getProgress: (id) => {
        const state = get();
        const quest = QUEST_DEFINITIONS.find((q) => q.id === id);
        if (!quest) return 0;
        if (state.progress[id]?.status === 'completed') return 1;
        if (state.progress[id]?.status === 'locked') return 0;
        const ctx = buildEvalContext(state);
        return evalCondition(quest.condition, ctx).ratio;
      },
    }),
    {
      name: 'clawville-quest-progress',
      // Bumped to v3 for the 30-quest redesign (new counter keys, new
      // distinct sets, new quest IDs).
      version: 3,
      // skipHydration: true defers the localStorage read until a top-level
      // component explicitly calls useQuestStore.persist.rehydrate() inside
      // a useEffect. Without this, persist reads localStorage during the
      // first client render — server-rendered HTML (initial state) does not
      // match the now-hydrated client HTML → React #418 hydration mismatch
      // fires every page load. See game/page.tsx for the rehydrate trigger.
      skipHydration: true,
      partialize: (state) => ({
        progress: state.progress,
        counters: state.counters,
        distinct: state.distinct,
        serverClaimed: state.serverClaimed,
        ownerUserId: state.ownerUserId,
      }),
      merge: (persisted, current) => {
        const safe = persisted as Partial<{
          progress: Record<QuestId, QuestProgress>;
          counters: Partial<QuestCounters>;
          distinct: Partial<DistinctSets>;
          serverClaimed: Partial<Record<QuestId, boolean>>;
          ownerUserId: string | null;
        }> | undefined;
        return {
          ...current,
          progress: { ...current.progress, ...(safe?.progress ?? {}) },
          counters: { ...current.counters, ...(safe?.counters ?? {}) },
          distinct: {
            distinctTeachersChatted: { ...current.distinct.distinctTeachersChatted, ...(safe?.distinct?.distinctTeachersChatted ?? {}) },
            distinctActivityTypes: { ...current.distinct.distinctActivityTypes, ...(safe?.distinct?.distinctActivityTypes ?? {}) },
            distinctBookBuildings: { ...current.distinct.distinctBookBuildings, ...(safe?.distinct?.distinctBookBuildings ?? {}) },
          },
          serverClaimed: { ...current.serverClaimed, ...(safe?.serverClaimed ?? {}) },
          // Pre-owner-marker persisted blobs (v3 before 2026-07-12) have no
          // ownerUserId → null = guest-era/unowned, the safe default.
          ownerUserId: safe?.ownerUserId ?? null,
        };
      },
    }
  )
);

type TutorialClaimResult = 'claimed' | 'terminal' | 'unauthenticated' | 'retryable-failed';

// One initial attempt + two short retries. 4xx responses never enter this
// retry path; only a transient 5xx or network failure consumes the backoff.
const TUTORIAL_CLAIM_RETRY_DELAYS_MS = [250, 750] as const;
let retryUnclaimedRewardsInFlight: Promise<void> | null = null;

function waitForClaimRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimTutorialQuestReward(
  def: QuestDefinition,
  opts?: { silent?: boolean },
): Promise<TutorialClaimResult> {
  let lastRetryableError: unknown;

  for (let attempt = 0; attempt <= TUTORIAL_CLAIM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await api.claimTutorialQuest(def.id);
      if (res.ok) {
        useQuestStore.getState().markServerClaimed(def.id);
        if (!opts?.silent) {
          useGameStore
            .getState()
            .addToast('💰', `+${res.credited} vCLAW (balance: ${res.balance})`, 3500);
        }
        return 'claimed';
      }
      if (res.error === 'already_claimed') {
        useQuestStore.getState().markServerClaimed(def.id);
        return 'claimed';
      }
      if (res.error === 'guest_not_eligible' && !opts?.silent) {
        useGameStore
          .getState()
          .addToast('🔒', 'Sign up to claim tutorial rewards', 4000);
      }
      console.warn('[quest] tutorial claim rejected permanently for', def.id, res.reason ?? res.error);
      return 'terminal';
    } catch (err) {
      // honoRequest throws for every non-2xx response, so HTTP status — not
      // response-body string matching — owns retryability here.
      const status = (err as { status?: number })?.status;
      if (status === 401) return 'unauthenticated';
      if (status === 409) {
        // This endpoint's sole 409 contract is idempotent already_claimed.
        useQuestStore.getState().markServerClaimed(def.id);
        return 'claimed';
      }
      if (status !== undefined && status >= 400 && status < 500) {
        if (status === 403 && String((err as Error)?.message ?? '').includes('guest_not_eligible')) {
          if (!opts?.silent) {
            useGameStore
              .getState()
              .addToast('🔒', 'Sign up to claim tutorial rewards', 4000);
          }
        }
        // Do NOT persist serverClaimed for generic 4xx. In particular, a 400
        // engagement_required may become claimable after a later portal/event.
        console.warn('[quest] tutorial claim rejected permanently for', def.id, `HTTP ${status}`, err);
        return 'terminal';
      }

      lastRetryableError = err;
      const retryDelay = TUTORIAL_CLAIM_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await waitForClaimRetry(retryDelay);
    }
  }

  console.warn('[quest] claim network failure after bounded retries for', def.id, lastRetryableError);
  return 'retryable-failed';
}

/**
 * Retry server-side claims for any tutorial quests that the local store
 * marks completed but `serverClaimed` doesn't acknowledge. Also probes
 * `serverOnly` quests whose prerequisites are met — the server validator
 * is the only authority for those, so we ask periodically.
 */
async function runUnclaimedRewardSweep(): Promise<void> {
  const state = useQuestStore.getState();
  const claimed = state.serverClaimed;
  for (const def of QUEST_DEFINITIONS) {
    if (claimed[def.id]) continue;
    if (state.progress[def.id]?.status === 'completed') {
      const result = await claimTutorialQuestReward(def, { silent: true });
      if (result === 'unauthenticated') return; // logged out — every claim would 401
      if (result === 'retryable-failed') return; // outage — do not multiply it across the quest list
      continue;
    }
    if (def.condition.type === 'serverOnly') {
      const allPrereqsMet = def.prerequisites.every(
        (pid) => state.progress[pid]?.status === 'completed'
      );
      if (allPrereqsMet) {
        const result = await claimTutorialQuestReward(def, { silent: true });
        if (result === 'unauthenticated') return;
        if (result === 'retryable-failed') return;
      }
    }
  }
}

export function retryUnclaimedRewards(): Promise<void> {
  // /game has two potential QuestTracker mount sites and StrictMode replays
  // mount effects in development. Coalesce the whole sweep so they cannot all
  // snapshot the same unclaimed state and POST the same rewards concurrently.
  if (retryUnclaimedRewardsInFlight) return retryUnclaimedRewardsInFlight;
  const sweep = runUnclaimedRewardSweep().finally(() => {
    if (retryUnclaimedRewardsInFlight === sweep) retryUnclaimedRewardsInFlight = null;
  });
  retryUnclaimedRewardsInFlight = sweep;
  return sweep;
}

/**
 * Quest-board restore (2026-07-29): pull the signed-in account's claimed
 * tutorial quests from the server and re-mark them completed locally. The
 * identity sweep deliberately wipes localStorage quest progress on session
 * expiry / account switch (shared-machine leak guard) — but every claim has
 * a durable tutorial_quest_claims row server-side, so the SAME account
 * logging back in can always recover its completion display.
 *
 * Hydration-aware: the store uses skipHydration, and the persist merge
 * spreads the localStorage blob over in-memory state — applying only before
 * /game calls persist.rehydrate() would be overwritten. A pre-hydration call
 * therefore applies now (harmless on defaults) AND re-applies after
 * hydration. Cross-account guard: apply only while the store's stamped owner
 * still matches the account this sync was started for, so a fast account
 * switch can never graft one account's completions onto another's board.
 */
export async function syncTutorialClaimsFromServer(
  accountUserId: string,
): Promise<void> {
  if (lastClaimsSyncAccount === accountUserId) return;
  lastClaimsSyncAccount = accountUserId;
  try {
    const res = await api.getTutorialQuestClaims();
    if (!res?.ok || !Array.isArray(res.claims)) return;
    const claims = res.claims;
    const apply = () => {
      const s = useQuestStore.getState();
      if (s.ownerUserId !== accountUserId) return; // owner moved on — stale sync
      s.applyServerClaims(claims);
    };
    if (useQuestStore.persist.hasHydrated()) {
      apply();
    } else {
      apply(); // pre-hydration defaults — harmless, mirrors the watcher's reconcile
      const unsub = useQuestStore.persist.onFinishHydration(() => {
        unsub();
        apply();
      });
    }
  } catch (err) {
    // Transient failure (network / API blip): allow the next auth resolution
    // or QuestTracker mount to retry. A 401 lands here too — harmless, the
    // watcher won't re-invoke until an account actually resolves.
    lastClaimsSyncAccount = null;
    console.warn('[quest] server-claims restore fetch failed', err);
  }
}

/**
 * Belt for QuestTracker mount: re-run the server-claims restore for the
 * currently stamped owner (no-op when unstamped or already synced). Covers
 * a transient fetch failure whose retry window the watcher already passed.
 */
export function retryServerClaimsRestore(): void {
  const owner = useQuestStore.getState().ownerUserId;
  if (owner) void syncTutorialClaimsFromServer(owner);
}

export function triggerQuestCheck() {
  const completed = useQuestStore.getState().checkAndCompleteQuests();
  for (const questId of completed) {
    const def = QUEST_DEFINITIONS.find((q) => q.id === questId);
    if (def) {
      useGameStore.getState().addToast(def.icon, `Quest complete: ${def.title}!`, 4000);
      void claimTutorialQuestReward(def);
    }
  }
}
