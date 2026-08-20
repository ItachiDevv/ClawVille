/**
 * boot-stream-cohort.ts — slice-D stream cohort tracker (spec §4a, FROZEN
 * rev 5). Answers ONE question with fail-closed discipline: when did every
 * boot-deferred streaming unit reach a terminal state?
 *
 * Design (Codex rounds [F13][R2-F8]):
 *  - The cohort is SEEDED with the exact static member IDs at module load —
 *    registration closure is the SEED, never a timer. A member that never
 *    mounts stays nonterminal and `streamSettledAt` NEVER stamps (a
 *    `showNpcs=false` boot surfaces as an invalid measurement run, not a
 *    silent lighter-workload pass).
 *  - State transitions are reported from COMMIT effects (never render-time —
 *    React may abandon renders).
 *  - `ready-failopen` and `failed` are distinct terminals: product keeps
 *    fail-open, measurement validity requires zero of both [R2-F11][F11].
 *  - The land trio is NOT in this cohort — it has its own hydration-
 *    generation tracker (§4b, land components own it).
 */

export type CohortTerminal = 'ready-warmed' | 'ready-failopen' | 'failed';
export type CohortState =
  | 'seeded'
  | 'mounted'
  | 'loading'
  | 'warm-pending'
  | CohortTerminal;

/** The exact 16 slice-D DWA-carrying stream units (11 buildings + 3 town
 * props + 2 town NPCs). Building ids mirror `buildingZones` zone ids. */
export const BOOT_STREAM_COHORT_IDS = [
  // The 11 GLB buildings (buildingZones ids; 'messaging-channels' = the
  // procedural treedome, deliberately absent — it never streams).
  'building:visual-creation',
  'building:code-development',
  'building:mcp-tool-use',
  'building:api-integrations',
  'building:app-publishing',
  'building:cron-automation',
  'building:deployment-ops',
  'building:claw-arcade',
  'building:cove',
  'building:agent-security',
  'building:memory-rag',
  'prop:bazaar-stall',
  'prop:marketplace-stall',
  'prop:quest-bounty-pavilion',
  'npc:town-guide',
  'npc:quest-npc',
] as const;

export type CohortId = (typeof BOOT_STREAM_COHORT_IDS)[number];

/** BGR (buildings-gated reveal, 2026-08-20): the 11 building members form a
 * tracked SUBSET with their own settle stamp — the loading overlay's
 * buildings leg keys on presentation (decorative-release ack protocol), but
 * this data-settled stamp is the sticky MEASUREMENT record. `failed` and
 * `ready-failopen` count (a 404'd building must never hold the overlay). */
const BUILDING_COHORT_IDS: readonly string[] = BOOT_STREAM_COHORT_IDS.filter(
  (id) => id.startsWith('building:'),
);

const states = new Map<string, CohortState>();
let settledAtMs: number | null = null;
let buildingsSettledAtMs: number | null = null;

function seed(): void {
  for (const id of BOOT_STREAM_COHORT_IDS) states.set(id, 'seeded');
}
seed();

function stamp(): void {
  try {
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    const counts = getCohortCounts();
    (window as any).__W3D_PHASES.streamCohort = counts;
    if (settledAtMs !== null) {
      (window as any).__W3D_PHASES.streamSettledAt = settledAtMs;
    }
  } catch {
    /* telemetry never throws */
  }
}

function isTerminal(state: CohortState): boolean {
  return (
    state === 'ready-warmed' ||
    state === 'ready-failopen' ||
    state === 'failed'
  );
}

function checkSettled(): void {
  // BGR buildings-subset stamp — once, monotonic, sticky.
  if (buildingsSettledAtMs === null) {
    let allBuildingsTerminal = true;
    for (const id of BUILDING_COHORT_IDS) {
      const state = states.get(id);
      if (!state || !isTerminal(state)) {
        allBuildingsTerminal = false;
        break;
      }
    }
    if (allBuildingsTerminal) {
      buildingsSettledAtMs =
        typeof performance !== 'undefined'
          ? Math.round(performance.now())
          : Date.now();
      try {
        const phases = ((window as any).__W3D_PHASES =
          (window as any).__W3D_PHASES ?? {});
        phases.bootBuildingsSettledAt = buildingsSettledAtMs;
        // Provenance copy-stamps [impl-B8] — read from the phases object the
        // declaring/observing modules already write (no import cycle with
        // decorative-release): the mode and renderer generation IN EFFECT
        // when the buildings data-settled.
        phases.bootBuildingsSettledMode = phases.bootBuildingsMode ?? null;
        phases.bootBuildingsSettledGen = phases.bootRendererGeneration ?? 1;
      } catch {
        /* telemetry never throws */
      }
    }
  }
  if (settledAtMs !== null) return;
  for (const id of BOOT_STREAM_COHORT_IDS) {
    const state = states.get(id);
    if (!state || !isTerminal(state)) return;
  }
  settledAtMs =
    typeof performance !== 'undefined'
      ? Math.round(performance.now())
      : Date.now();
  stamp();
}

/** Report a state transition for a cohort member (commit effects only).
 * Unknown ids are ignored loudly — the cohort is a closed set. */
export function reportCohortState(id: string, state: CohortState): void {
  if (!states.has(id)) {
    console.warn(`[boot-stream-cohort] unknown member '${id}' ignored`);
    return;
  }
  const prior = states.get(id)!;
  // Terminal states are sticky — a remount after failure must not resurrect.
  if (isTerminal(prior)) return;
  states.set(id, state);
  stamp();
  if (isTerminal(state)) checkSettled();
}

export function getCohortCounts(): {
  total: number;
  terminal: number;
  warmed: number;
  failopen: number;
  failed: number;
  nonterminal: string[];
} {
  let terminal = 0;
  let warmed = 0;
  let failopen = 0;
  let failed = 0;
  const nonterminal: string[] = [];
  for (const id of BOOT_STREAM_COHORT_IDS) {
    const state = states.get(id) ?? 'seeded';
    if (isTerminal(state)) {
      terminal += 1;
      if (state === 'ready-warmed') warmed += 1;
      else if (state === 'ready-failopen') failopen += 1;
      else failed += 1;
    } else {
      nonterminal.push(id);
    }
  }
  return {
    total: BOOT_STREAM_COHORT_IDS.length,
    terminal,
    warmed,
    failopen,
    failed,
    nonterminal,
  };
}

export function getStreamSettledAt(): number | null {
  return settledAtMs;
}

/** BGR: all 11 building members terminal (data-settled; sticky). */
export function areBootBuildingsSettled(): boolean {
  return buildingsSettledAtMs !== null;
}

export function getBootBuildingsSettledAt(): number | null {
  return buildingsSettledAtMs;
}

/** TEST-ONLY. */
export function __resetBootStreamCohortForTests(): void {
  states.clear();
  seed();
  settledAtMs = null;
  buildingsSettledAtMs = null;
}
