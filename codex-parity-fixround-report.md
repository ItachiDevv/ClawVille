# W-E3 PASS 1 parity harness fix-round report

Branch: `feat/cove-3d-holdem`
Starting HEAD: `deb4d042dd7a4f364557dcf101c4264cf37d7162`

## Implemented scope

### FIX-1a — row exit and PASS-protected evidence

- `--live --scenario <id>` still prints the matrix but now exits 0 only when
  that selected row's status is `PASS`.
- `--emit-matrix` retains its frozen global-gate exit semantics.
- A non-PASS attempt cannot replace an existing canonical PASS. It is written
  as `<id>.attempt-<timestamp>.json`; PASS always replaces `<id>.json`.
- Attempt artifacts are excluded from matrix discovery, and a protected
  attempt leaves the canonical PASS in `matrix.md` while the current command
  still exits nonzero.

### FIX-5 — current-checkpoint wire attribution

- Repeated Baccarat settlement checkpoints reject a republished prior coup and
  wait, bounded by `maxDurationMs`, for a root with the current coup
  correlation.
- Baccarat response-body `coupId` wins over a stale capture summary.
- Visible-surface and money probes use the exact wire sequence certified by the
  checkpoint assertion.
- The visible stake parser now reads the amount adjacent to `vCLAW`, not the
  odds preceding it; the active bet-zone probe compares the semantic
  Player/Banker/Tie label without the odds suffix.
- Regression coverage includes two consecutive coups and all three Baccarat
  odds labels.

### FIX-1b / FIX-3a / FIX-3b / FIX-4-preflight / FIX-6 — versioned pack ops

- Added the Git Bash pack loop at `scripts/parity/run-full-pack.sh`; scenario
  IDs come directly from `SCENARIO_CATALOG` (58 rows).
- Preserved canonical PASS resume-skip, no more than three attempts, exit-0
  retry break, per-attempt guest-shoe reset, daemon health checks, and the
  stable `RUNS COMPLETE:` / `MATRIX-EXIT=` lines.
- Ported `reset-guest-shoes.ts` byte-for-byte, including its exact staging DB
  guard. The pack supplies its workspace-local `postgres` dependency through a
  command-local Windows `NODE_PATH` and aborts before a row if reset fails.
- Added pack-start auth verification. Saved guest/live state is loaded once on
  a same-origin static `/sw.js` document, then page-context auth probes run
  without replaying `--state`. An expired guest is re-minted anonymously via
  `/game`; live state is verify-only and refuses if stale or guest.
- Added the 500 vCLAW floor and a live avatar balance read.
- Added fresh private cash-table creation with the exact frozen body. Both HTTP
  and thrown creation failures use a sanitized, loud
  `CV_PARITY_CASH_TABLE_ID` fallback.
- Added fail-closed agent-browser runtime PID baselining and between-row cleanup
  of only nonbaseline runtimes (or explicitly attributed Chrome processes)
  older than three minutes. The keepalive baseline is never swept.
- Added `scripts/parity/README-pack.md`.

No game, publisher, mirror, API, migration, or deployment files were changed.

## Gate evidence

### 1. Harness unit tests

Command: `bun test scripts/parity`

Verbatim tail:

```text
 43 pass
 0 fail
 133 expect() calls
Ran 43 tests across 12 files. [1243.00ms]
```

The frozen baseline was 41 tests. The consecutive-coup test is the requested
42nd test; the 43rd is justified regression coverage for the independently
found odds-versus-stake parsing defect.

### 2. Harness self-test

Command: `bun scripts/parity/run-parity.ts --self-test`

Verbatim output:

```text
SELF-TEST correct recorded payload: PASS
SELF-TEST injected wrong card: FAIL (expected; lie detected)
SELF-TEST overall: PASS
```

### 3. TypeScript gates

Web command: `cd apps/web && bunx tsc --noEmit`

The command retains exactly the 12-error pre-existing baseline. No parity file
appears in the error list.

Verbatim tail/count:

```text
src/lib/three/arena-location-npcs.tsx(822,24): error TS2339: Property 'setTimeout' does not exist on type 'never'.
src/lib/three/player-avatar.tsx(714,9): error TS2322: Type 'VRM' is not assignable to type '{ humanoid?: { getRawBoneNode?: ((name: string) => Object3D<Object3DEventMap> | null) | undefined; } | null | undefined; scene: Object3D<Object3DEventMap>; }'.
  The types of 'humanoid.getRawBoneNode' are incompatible between these types.
    Type '(name: VRMHumanBoneName) => Object3D<Object3DEventMap> | null' is not assignable to type '(name: string) => Object3D<Object3DEventMap> | null'.
      Types of parameters 'name' and 'name' are incompatible.
        Type 'string' is not assignable to type 'VRMHumanBoneName'.
WEB-TSC-ERROR-COUNT=12
WEB-TSC-FILES=codex-hipcheck-roster.ts,src/app/create-agent/page.tsx,src/app/preview/cosmetics/CosmeticsPreviewScene.tsx,src/components/game/avatar-chat-bar.tsx,src/components/game/edit-appearance-section.tsx,src/components/landing/qwerti-buy-widget.tsx,src/lib/three/agent-model-registry.parity.test.ts,src/lib/three/arena-location-npcs.tsx,src/lib/three/player-avatar.tsx
```

API command: `cd apps/api && bunx tsc --noEmit`

```text
<no output; exit 0>
```

### Pack static checks

```text
GIT-BASH-SYNTAX: PASS
RESET-HELPER-VERBATIM: PASS
CATALOG-ROWS=58
```

### 4. Final pack preflight

Verbatim output:

```text
PREFLIGHT guest auth: PASS (existing guest state)
PREFLIGHT live auth: PASS (authenticated non-guest)
PREFLIGHT live balance: 995893 vCLAW (floor 500 vCLAW)
PREFLIGHT cash table: created fresh private table 98715175-7f1f-473c-b794-3bea8003ab9b
PACK_CASH_TABLE_ID=98715175-7f1f-473c-b794-3bea8003ab9b
PACK-PREFLIGHT-PASS
```

### 5. b1 live row proof

Before the successful attempt, the staging-guarded reset reported:

```text
GUEST-SHOES-RESET blackjack=0 baccarat=0
```

Verbatim row step log:

```text
[row b1.blackjack.guest.blackjack-3d] opening https://itachi222.tail06a01b.ts.net:9443/cove
[row b1.blackjack.guest.blackjack-3d] page open, viewport set
[row b1.blackjack.guest.blackjack-3d] preflight clean, navigating /cove/blackjack
[row b1.blackjack.guest.blackjack-3d] awaiting checkpoint hole-1 on blackjack-3d (after r0)
[row b1.blackjack.guest.blackjack-3d] checkpoint hole-1 r1 pass=true
EXITCODE 0
```

Result JSON status:

```text
scenario        : b1.blackjack.guest.blackjack-3d
status          : PASS
pass            : True
reached         : True
checkpoint      : hole-1
revision        : 1
resolvedWireSeq : 25
```

The first b1 attempt ended `EXITCODE 1` on a transient agent-browser daemon
configuration restart race. The existing canonical PASS was not overwritten,
which incidentally exercised the new protection path. After the daemon's
requested retry and a guarded shoe reset, the row above exited 0 and overwrote
the canonical result with fresh PASS evidence.

## Spec deviations and residual risks

- No FIX-2 work or live-row diagnosis from later FIX-3/FIX-4 passes was
  attempted.
- Test count is 43 rather than 42 because the odds-versus-stake probe defect
  required a second focused regression test to keep c6 honest.
- The shared `AgentBrowserDriver` still replays `--state` on every command.
  Pack preflight uses a local one-shot state-load workaround; diagnosing the
  live-row driver path remains serialized later work.
- c6 now has targeted correlation and visible-probe coverage but was not rerun
  live after the final patch. This pass's explicit live gate was b1, which is
  green.
- FIX-6 cleanup was syntax/process-reviewed and preserves the observed
  keepalive PID baseline, but the full multi-hour pack was intentionally not
  launched in this pass.
- Preflight diagnostics created staging private tables while isolating the
  saved-state redirect/reset behavior. The final exported table is the fresh
  ID shown above; later creation failures fall back loudly as specified.

Final independent adversarial review: **APPROVED — no blocking issues remain.**
