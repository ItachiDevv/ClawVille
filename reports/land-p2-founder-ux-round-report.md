# Land P2 founder-UX round — 2026-08-08

Branch: `feat/land-p2-tenure`  
Worktree: `C:\Users\itachi\Documents\Crypto\cv-land-p1`  
Commit: none (requested uncommitted handoff)

## 1. Land Office modal

- Deep-link behavior changed from **always preselect For Sale + clear the focus after the first scroll** to **resolve the focused code against the viewer's owned rows, preselect My Land when owned / For Sale otherwise, and retain focus until modal close**. The owned-card scroll/focus is at `apps/web/src/components/game/land/land-office-modal.tsx:229-242`; the owned/available tab resolution is at `:1476-1483`; the focused header is at `:1538-1550`; the focused parcel is passed to both tab panels at `:1577` and `:1599`.
- Available-card focus changed from a transient wrapper ring to a persistent programmatic focus, centered scroll, highlight ring, and desktop `col-span-full` expansion at `apps/web/src/components/game/land/tenure-office-panels.tsx:299-322` and `:345-351`.
- Hold/rent copy changed from a generic door explanation to hold-first explicit pricing. Each claimable card now leads with `Hold <threshold> $CLAWVILLE — rent-free`, followed by `or rent <weekly> vCLAW/week` at `apps/web/src/components/game/land/tenure-office-panels.tsx:228-238`; the intro uses the same order and exact Starter/C prices at `:332`.
- Body padding changed from **0 px** (the shared `RpgModal` body default) to **mobile 12 px horizontal / 16 px vertical** and **desktop 20 px left / 16 px right / 20 px vertical**, with stable scrollbar gutters at `apps/web/src/components/game/land/land-office-modal.tsx:1553-1555`. Cards changed to **12 px mobile / 16 px desktop** at `apps/web/src/components/game/land/tenure-office-panels.tsx:219` and `land-office-modal.tsx:340`; nested scroll gutters are 8 px + stable gutter at `tenure-office-panels.tsx:334` and `land-office-modal.tsx:329`. The existing game-modal header convention remains **16 px top / 22 px horizontal / 14 px bottom** at `apps/web/src/components/rpg/glow.css:606-611`.
- The proximity pill's available action and the Decorate-adjacent owned `Manage` action both keep calling `openLandOffice(nearParcelCode)` at `apps/web/src/components/game/land-options-pill.tsx:132`, so both enter the same focused flow.

## 2. Parcel display names

- Added the pure deterministic `parcelDisplayName(parcelCode, tier)` helper at `packages/shared/src/constants/land-tiers.ts:35-53`. Examples are pinned at `packages/shared/src/constants/land-tiers.test.ts:4-10`: `parcel-starter-24` → `Starter Cove #24`, `parcel-c-07` → `Outer Ward #07`, and `parcel-founder-03` → `Founders' Row #03`.
- Human UI changed from raw-code-primary labels to friendly-name-primary labels in the proximity pill (`apps/web/src/components/game/land-options-pill.tsx:39,109`), Land Office cards/header/build/toasts (`apps/web/src/components/game/land/land-office-modal.tsx:298,345,506,565,1538`; `tenure-office-panels.tsx:204-238,401-460`), yard editor (`apps/web/src/components/game/land/yard-editor-overlay.tsx:306-307,392`), guest sandbox (`apps/web/src/components/game/land/guest-land-sandbox.tsx:305`), and wallet hold-risk list (`apps/web/src/components/game/wallet/wallet-panel.tsx:913-918`). Technical `parcelCode` remains the wire/render key and appears only as secondary technical context where useful.
- Added `displayName` without removing or retyping existing fields on land read DTOs (`apps/api/src/routes/land.ts:975`; web mirror `apps/web/src/components/game/land/types.ts:25`), autonomous land-target DTOs (`apps/api/src/services/autonomous-land-targets.ts:16,25,76,95`), hosted cognition text (`apps/api/src/services/agent-autonomy-driver.ts:1482,1488`), and the bounded agent status DTO (`apps/api/src/services/agent-owner-binding.ts:191`; mapper `apps/api/src/routes/agent-gateway.ts:3904`). Structural guards are at `apps/api/src/routes/__tests__/land-tenure-p2-structural.test.ts:64,278`.
- Protocol manual status text changed additively at `apps/api/src/services/skill-protocol.ts:1449`; action examples remain technical parcel codes. `PROTOCOL_VERSION` remains **46 → 46**. For `https://clawville.world`, the derived manual content hash changed **`sha256:3be8e92eedb83d7c4ed46d73e3c9909d5e33389051ba3cf6bc801c64eea5b73c` → `sha256:9ec195b8a58ff62a9d7e296b955f3ad2b3ba10425b99958675ef1f9f56639b68`**.

## 3. Run speed

- The single shared run multiplier changed **1.5 → 2.025** (+35%) at `apps/web/src/lib/three/player/player-input.ts:46`.
- The unified capability controller's click-path override changed from duplicated literals (`0.7`, `1.5`) to `RUN_JOYSTICK_THRESHOLD` and `RUN_SPEED_MULT` at `apps/web/src/lib/three/player/player-capability-controller.tsx:242,254`. Direct keyboard/touch/joystick intent already consumes the same constant.
- World base walk remains **550 wu/s**; run changes **825 → 1,113.75 wu/s**. Kelp's area adapter remains **430 wu/s**, but its current capability mask has sprint disabled; no per-area speed was edited. Cove's legacy local `COVE_PLAYER_SPEED = 450` remains unchanged. Capability masks are boolean-only (`apps/web/src/lib/three/player/player-capability-mask.ts:1-31`) and hardcode no speed.
- NPC simulation walk speed remains **220 wu/s** (`apps/api/src/services/npc-simulation.ts:319`, derived from 44 wu/tick at `:3565`). Camera follow constants remain unchanged after audit: kelp exponential follow rate `7` at `apps/web/src/lib/three/kelp-realm-player.tsx:360`, cove rate `8` at `apps/web/src/lib/three/cove-interior.tsx:1364,1563`; neither derives from or duplicates the player run multiplier.
- Regression coverage proving navigation override and direct input share `2.025` is at `apps/web/src/lib/three/player/player-frame-contract.test.ts:279-288`; direct/joystick intent pin is at `apps/web/src/lib/three/player/player-intent.test.ts:315`.

## Frozen/locked scope

- Migrations `0051` and `0052`: untouched.
- No land settlement or route decision logic was changed for this round. API edits are additive read/status display fields only.
- No commit was created.

## Gates

- PASS — `bun run --filter @clawville/web typecheck`
- PASS — `bunx tsc --noEmit -p apps/api`
- PASS — `bun run build`: **9 successful / 9 total**
- PASS — land/tenure/guard/protocol batch: **280 passed / 0 failed / 38 explicitly environment-gated skips**. The dedicated P2 staging-DB contract ran, not skipped: **4 passed / 0 failed**.
- PASS — shared name + unified player controller tests: **49 passed / 0 failed**.
- PASS — autonomous land-target prompt suite: **15 passed / 0 failed**.
- PASS — final P2 structural rerun after display-name guards: **18 passed / 0 failed**.
- PASS — `git diff --check` (line-ending notices only; no whitespace errors).

Repository refresh note: `git pull --ff-only` could not run because this local-only branch has no upstream; it made no changes. `git fetch origin --prune` completed successfully before implementation.
