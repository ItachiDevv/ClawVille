# Phase Q3 — Coral Plot (Builder World)

**Status:** DRAFT — autonomous proposal, awaiting founder review
**Anchor:** `.claude/plans/roadmap-gamification.md` §3 (Builder World — Coral Plot)
**Brand alignment:**
- Brand Identity §3 — *agent-collaboration axis made physical*. Two agents (or two humans, or human+agent) building together in the same plot is the brand thesis rendered as a play space.
- Brand Identity §4 — Milady AI integration: agent-built plots are inherently shareable + remixable from any Milady chat surface.
- Priority #4 — gamified UI deepening the agent-collab story. Coral Plots are visible artifacts of that collab.

**Status of Q2 (predecessor):** All 12 chunks shipped. 6 merged to prod. 5 PRs open (#23, #24, #25, #26, #27) awaiting merge order decision. Q3 is independent — does not block on those PRs.

---

## TL;DR — load-bearing decisions

1. **Prop placement first; voxels deferred indefinitely.** A palette of ~50 pre-made GLBs (existing + a small CC0 expansion) on a 16×16wu grid. Voxels are months of mesh-greedy/lighting-bake work for marginal expressivity gain at this stage.
2. **Each pet gets ONE persistent plot.** No multi-plot per pet at launch — clean ownership semantics. Plot is `{petId} 1:1`. A plot is automatically created on first visit.
3. **Plots are SEPARATE scenes from the open world.** Visit via Next.js route `/plot/:petId`. Same WebGPU isolation pattern proven by Q2 activity rooms.
4. **Co-build via WebSocket op-stream (not CRDT).** Operations are coarse — `place`, `move`, `delete`, `rotate` — not character-level edits. Server-authoritative ordering, last-write-wins on conflict. ~10 ops/sec ceiling per plot. Liveblocks/Yjs added complexity not justified at op rate.
5. **Plot persistence model = JSONB column on `pets` (or new `pet_plots` table).** Use a new table — plots will grow large enough that bloating the pets row hurts.
6. **Visiting other plots is allowed; building in them is not (yet).** Co-build invitation is explicit per-session: plot owner toggles "co-build mode" + sends an invite to a specific pet. Builder gets edit rights for that session only.
7. **Voting + featured rotation = social proof loop.** Visitors press 👍 once per plot per week. Top-voted plots get spotlit in a town-square gallery (new Town Hub object) that rotates weekly.
8. **No commerce.** Free brand tier (Brand Identity §3 + Priority #3). Plots are not buyable, sellable, or rentable. Cosmetics earned via play (Q2 token economy) can be placed in plots.
9. **Performance budget per plot scene:** ≤80 draw calls, ≤300k tris (higher than Bumper because plots are stationary — no per-frame physics), ≤1 ghost (visiting agent's avatar), 1 shadow map at 1024² (plots are visited deliberately, not chaotic combat — can afford slightly more shadow detail).
10. **Voxel evolution:** explicitly OUT of Q3 scope. Re-evaluate only if prop-placement shipping data shows expressivity is the bottleneck for retention.

---

## Scope

### In scope for Q3
- **Plot scene** — separate Next.js route, isolated WebGPU context, fixed 64×64wu plot bounded by sea-floor + invisible barrier
- **Prop palette** — 50 pre-made GLBs (start with existing decorations: corals, kelp, ruins, signs, lights; expand with CC0 batch)
- **Edit mode** — drag from palette → drop on grid → rotate (Y-only, 4 cardinal) → delete via right-click. Undo/redo (10-deep history, per-session only)
- **View mode** — visitors see plot in read-only camera orbit
- **Persistence** — `pet_plots` table, JSONB array of `{propId, x, y, z, rotY}` tuples
- **Visit flow** — sidebar button "Visit a Plot" → search by pet name → navigate to `/plot/:petId`. Also: every pet's chat panel surfaces a "Visit my plot" button
- **Co-build invitations** — owner toggles co-build mode, sends invite to specific pet via existing chat or new "Invite to co-build" button on visitor's view
- **Co-build WebSocket** — bidirectional op-stream, server-authoritative ordering
- **Voting** — 👍 button on visitor view, rate-limited to 1 per pet per week per plot
- **Featured Builds gallery** — new Town Hub 3D object (small podium with 3 spotlit plot thumbnails). Refreshed weekly via cron. Click → navigate to `/plot/:petId`
- **Plot guestbook** — visitors leave 1-line message; owner sees newest 20
- **Tutorial integration** — new tutorial quest `coral-decorator` ("Place 5 props in your plot") + `plot-explorer` ("Visit 3 other plots") per Q1's tutorial pattern (now-shipped Q2 chunk #9 framework)
- **Doc updates same-diff:** `GameFeatures.md` §20 Coral Plot, `3dStructure.md` §13 Plot Scene, `ARCHITECTURE.md` plot routes + tables + service catalog

### Out of scope (Q4+ or never)
- Voxels (chunk volumes, greedy meshing, lighting bake) — re-evaluate after retention data
- Buying/selling/renting plots — brand guardrail (no peer commerce)
- Plot-vs-plot competitive modes (e.g. raid each other's plots) — out of brand scope
- Plot-as-game-mode (e.g. play minigames inside a plot) — too generic, dilutes the activity-portal product
- Real-money cosmetic packs — brand guardrail
- Multi-plot per pet — clean ownership wins for now
- Cross-pet build attribution (e.g. "co-built with @agent-X") on featured plots — defer to social-stamp pass after voting data
- Plot avatars (visitors as characters) for first-pass — visitors render as a single floating cursor + name label; full 3D pet visiting is Q3.5 polish

---

## System overview

```
 Open world (/game)
     │
     │ click "Visit a Plot" (sidebar) OR "My Coral Plot" (own pet menu)
     ▼
 (route swap → /plot/:petId)
     │
     │ load plot state via REST + open WS subscription
     ▼
 PlotScene (3D, route-isolated)
     │
     │ if owner OR co-build invitee:
     │   show palette, edit gizmo, op-stream to server
     │ else:
     │   read-only orbit cam + 👍 + guestbook + "Request co-build" button
     │
     ▼
 (WS ops: place/move/delete/rotate)
     │
     ▼
 Server validates + broadcasts to all subscribers (incl. owner offline → no-op,
 viewers see edits live)
     │
     ▼
 On ws disconnect or "save" event → final state flushed to DB
```

## Component ownership map

| Layer | Owner | Deliverables |
|---|---|---|
| 3D scene + prop catalog GLBs | 3da | `apps/web/src/lib/three/plot/*` + asset checklist |
| Backend services + schema + WS | backend (general-purpose) | `apps/api/src/services/plot/*`, `apps/api/src/routes/plots.ts`, schema |
| Client UI (editor, palette, visit, guestbook) | frontend (general-purpose) | `apps/web/src/components/game/plot/*`, route page, store |
| Cron (featured-builds rotation) | backend | new `apps/api/src/services/featured-plots-rotator.ts` |
| Doc updates | each chunk same-diff | per CLAUDE.md mandate |

---

## Database schema (additive, non-destructive `bun run db:push`)

### `pet_plots`
One row per pet (1:1 enforced by unique constraint on `pet_id`). Auto-created on first visit.

```ts
id            uuid PK
pet_id        uuid NOT NULL UNIQUE REFERENCES pets(id) ON DELETE CASCADE
state         jsonb NOT NULL DEFAULT '[]'   -- [{propId, x, y, z, rotY}]
display_name  text   -- optional plot title set by owner
description   text   -- optional plot description set by owner
last_edited_at timestamptz NOT NULL DEFAULT now()
created_at    timestamptz NOT NULL DEFAULT now()

INDEX (pet_id)
INDEX (last_edited_at DESC)
```

### `pet_plot_visits`
One row per (visitor, plot) per visit. Used for "you've visited" tracking + plot-explorer quest.

```ts
id           uuid PK
plot_id      uuid NOT NULL REFERENCES pet_plots(id) ON DELETE CASCADE
visitor_pet_id uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE
visited_at   timestamptz NOT NULL DEFAULT now()

INDEX (plot_id, visited_at DESC)
INDEX (visitor_pet_id, visited_at DESC)
```

### `pet_plot_votes`
Rate-limited 👍 per (visitor, plot, week).

```ts
id           uuid PK
plot_id      uuid NOT NULL REFERENCES pet_plots(id) ON DELETE CASCADE
voter_pet_id uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE
week_iso     text NOT NULL    -- e.g. '2026-W17' — primary uniqueness key
voted_at     timestamptz NOT NULL DEFAULT now()

UNIQUE (plot_id, voter_pet_id, week_iso)
INDEX (plot_id, week_iso)
```

### `pet_plot_guestbook`
Newest 20 visible to owner. No pagination — older entries hard-deleted on insert when count > 200 (FIFO trim).

```ts
id          uuid PK
plot_id     uuid NOT NULL REFERENCES pet_plots(id) ON DELETE CASCADE
author_pet_id uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE
message     text NOT NULL CHECK (length(message) <= 200)
created_at  timestamptz NOT NULL DEFAULT now()

INDEX (plot_id, created_at DESC)
```

### `pet_plot_co_build_invites`
Owner invites a specific pet to co-build for ONE session. Auto-expires.

```ts
id          uuid PK
plot_id     uuid NOT NULL REFERENCES pet_plots(id) ON DELETE CASCADE
inviter_pet_id uuid NOT NULL REFERENCES pets(id)
invitee_pet_id uuid NOT NULL REFERENCES pets(id)
invite_token text NOT NULL UNIQUE
expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
accepted_at timestamptz
created_at  timestamptz NOT NULL DEFAULT now()

INDEX (invitee_pet_id, expires_at) WHERE accepted_at IS NULL
```

### `featured_plots_snapshots`
Weekly snapshot — top 3 plots by votes, rotated by cron.

```ts
id             uuid PK
week_iso       text NOT NULL UNIQUE
plot_ids       uuid[] NOT NULL  -- ordered by rank: [first, second, third]
generated_at   timestamptz NOT NULL DEFAULT now()
```

Migration via `bun run db:push` — fully additive, no constraint changes. Pattern matches Q2 chunk #1.

---

## API routes (new — under `apps/api/src/routes/plots.ts`)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/plots/:petId` | Plot state + meta (read-only for non-owners) | none |
| GET | `/api/plots/me` | Own plot (auto-creates if missing) | Lucia |
| PATCH | `/api/plots/me/meta` | Update display_name + description | Lucia owner |
| WS | `/api/plots/:petId/ws` | Bidirectional op-stream + viewer presence | Lucia OR viewer |
| GET | `/api/plots/:petId/guestbook?limit=20` | Guestbook entries (newest first) | none |
| POST | `/api/plots/:petId/guestbook` | Add guestbook entry | Lucia |
| POST | `/api/plots/:petId/vote` | 👍 (idempotent per week) | Lucia |
| POST | `/api/plots/me/co-build/invite` | Owner invites specific pet | Lucia owner |
| POST | `/api/plots/co-build/accept/:token` | Invitee accepts (returns plot_id) | Lucia |
| GET | `/api/plots/featured?week=current` | Featured Builds gallery | none |
| GET | `/api/plots/me/visits` | My recent visits to other plots (for plot-explorer quest) | Lucia |
| GET | `/api/plots/search?q=` | Search by pet name | none (rate-limited) |

Rate limits: GET endpoints 60/min/IP. POST endpoints 30/min per Lucia user. WS upgrade 5/min per IP.

### WebSocket protocol

All messages JSON over binary WS. Same Bun-native upgrade pattern as Q2 activity rooms.

**Client → Server:**
```ts
type ClientPlotFrame =
  | { type: 'auth'; sessionToken: string }
  | { type: 'op'; seq: number; op: PlotOp }
  | { type: 'cursor'; x: number; z: number }   // 5Hz max — viewer cursor for presence
  | { type: 'leave' };

type PlotOp =
  | { kind: 'place'; propId: string; x: number; y: number; z: number; rotY: number; instanceId: string }
  | { kind: 'move'; instanceId: string; x: number; y: number; z: number }
  | { kind: 'rotate'; instanceId: string; rotY: number }
  | { kind: 'delete'; instanceId: string };
```

**Server → Client:**
```ts
type ServerPlotFrame =
  | { type: 'snapshot'; state: PlotProp[]; viewers: PlotViewer[]; isOwnerPresent: boolean }
  | { type: 'op_applied'; seq: number; op: PlotOp; bySubject: 'owner' | 'co-builder' | 'viewer' }
  | { type: 'op_rejected'; seq: number; reason: string }
  | { type: 'viewer_joined' | 'viewer_left'; viewer: PlotViewer }
  | { type: 'cursor'; petId: string; x: number; z: number }
  | { type: 'co_build_started'; coBuilderPetId: string }
  | { type: 'co_build_ended'; reason: 'invite-expired' | 'co-builder-left' | 'owner-revoked' };
```

Op validation server-side:
- `place`: propId in palette catalog, x/z within plot bounds, max 200 props per plot
- `move`: instanceId exists, new position within bounds
- `rotate`: rotY in {0, π/2, π, 3π/2}
- `delete`: instanceId exists
- All ops: caller is owner OR active co-builder (verify via session + co-build invite acceptance)

Snapshot delta NOT used — plot state is small enough (200 props × ~40 bytes = 8 KB) to send full snapshot on join. Op broadcasts are small (~80 bytes each).

Persistence: every op buffered server-side; flushed to `pet_plots.state` every 30s OR on WS disconnect.

---

## Frontend component tree

### New top-level components
| Component | Path | Purpose |
|---|---|---|
| `PlotPage` | `apps/web/src/app/plot/[petId]/page.tsx` | Next.js route, mounts scene + UI |
| `PlotEditorPanel` | `apps/web/src/components/game/plot/plot-editor-panel.tsx` | Owner/co-builder palette + tools |
| `PlotPropPalette` | `apps/web/src/components/game/plot/plot-prop-palette.tsx` | Drag-source palette of 50 props (categorized) |
| `PlotToolbar` | `apps/web/src/components/game/plot/plot-toolbar.tsx` | Move / Rotate / Delete tool selector + Undo/Redo |
| `PlotVisitorOverlay` | `apps/web/src/components/game/plot/plot-visitor-overlay.tsx` | Read-only viewer UI (👍 + guestbook + co-build request) |
| `PlotGuestbook` | `apps/web/src/components/game/plot/plot-guestbook.tsx` | View/post guestbook entries |
| `PlotMetaPanel` | `apps/web/src/components/game/plot/plot-meta-panel.tsx` | Display name, description, plot stats |
| `FeaturedBuildsGallery` | `apps/web/src/components/game/plot/featured-builds-gallery.tsx` | Town-square 3D-anchored gallery DOM overlay |
| `PlotSearchModal` | `apps/web/src/components/game/plot/plot-search-modal.tsx` | "Visit a Plot" search by pet name |
| `CoBuildInvitePopover` | `apps/web/src/components/game/plot/co-build-invite-popover.tsx` | Owner sends invite to specific pet |

### New zustand store
`apps/web/src/stores/plot.ts` — separate from `game.ts` so plot WS updates don't thrash main store. Mirrors the Q2 `activity.ts` pattern.

State:
- `plotId, petId, displayName, description`
- `props: Map<instanceId, PlotProp>`
- `mode: 'view' | 'edit'`
- `selectedTool: 'place' | 'move' | 'rotate' | 'delete'`
- `selectedPropId: string | null` (for placement)
- `selectedInstanceId: string | null` (for move/rotate/delete)
- `viewers: PlotViewer[]` (presence)
- `coBuilderPetId: string | null` (active co-build session)
- `connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'closed'`
- `undoStack: PlotOp[]` (10-deep)
- `redoStack: PlotOp[]`

Actions:
- `applyServerFrame(frame)` (handles all ServerPlotFrame types)
- `placeProp(propId, x, y, z, rotY)`
- `moveProp(instanceId, x, y, z)`
- `rotateProp(instanceId, rotY)`
- `deleteProp(instanceId)`
- `undo()`, `redo()`
- `setMode(mode)`, `selectTool(tool)`, `selectProp(id)`, `selectInstance(id)`
- `vote()`, `postGuestbook(message)`, `requestCoBuild()`

### Existing components touched
| File | Change |
|---|---|
| `apps/web/src/components/game/sidebar-menu.tsx` | "🌊 Visit a Plot" + "🏝️ My Plot" buttons |
| `apps/web/src/components/game/quest-tracker.tsx` | Render `coral-decorator` + `plot-explorer` quests |
| `packages/agent-templates/src/locations/town-guide.ts` | Nori knowledge[] gets Coral Plot mention (CLAUDE.md mandate) |

---

## 3D rendering architecture

### Plot scene (`apps/web/src/lib/three/plot/`)
| File | Purpose |
|---|---|
| `PlotScene.tsx` | Root R3F Canvas + scene + `<PreCompilePipelines>` + camera (orbit for viewers, drag-orbit for editors) |
| `PlotGround.tsx` | 64×64wu sandy floor + plot boundary band (visual edge) |
| `PlotBoundary.tsx` | Invisible AABB walls preventing prop placement outside bounds |
| `PlotProps.tsx` | Renders all placed props from store; each prop is a clone of the catalog GLB with `frustumCulled=false` traverse + `matrixAutoUpdate=false` |
| `PlotEditGizmo.tsx` | Renders selection highlight on the active instance + drag handles for move/rotate |
| `PlotViewerCursors.tsx` | Renders other viewers' cursors as floating colored disks on the ground |
| `PlotPalette.tsx` | DOM palette anchored to canvas (overlay) — drag preview lives in 3D temp mesh |
| `plot-config.ts` | All constants: PLOT_SIZE=64wu, GRID_CELL=2wu, MAX_PROPS=200, CAMERA_*, etc. |
| `plot-types.ts` | TS interfaces |

### Camera modes
- **View mode (default for visitors):** R3F `OrbitControls` anchored at plot center. Distance 40–80wu. Polar angle 30–80°. Damping enabled.
- **Edit mode (owner / co-builder):** Same OrbitControls + a "construction camera" that snaps to top-down + isometric on tool toggle. Drag-to-place uses raycast from cursor to ground plane.

### Performance
- Per 3d-spec convention, ≤80 draw calls / ≤300k tris / 1 shadow map at 1024². Plots are stationary (no per-frame physics) so the budget is loose.
- Prop catalog GLBs preloaded on plot scene mount via `useGLTF.preload(...)` at module scope.
- All static props: `matrixAutoUpdate=false` after place. The gizmo-highlighted instance gets `true` until deselected.

### Iris Xe gotchas (3da memory)
- No `<Text>` / `<Billboard>` — viewer cursor labels via `<Html>` instead
- No InstancedMesh + ShaderMaterial — palette previews use MeshStandardMaterial
- Module-scope scratch vectors in any per-frame code (gizmo drag, cursor tracking)
- Single shadow map; no post-processing

### Update `3dStructure.md` §13 (new section)
Same-diff per CLAUDE.md mandate.

---

## Featured Builds rotator

`apps/api/src/services/featured-plots-rotator.ts`:
- Cron every Sunday 00:00 UTC
- Query: top 3 plots by `pet_plot_votes.count` for the previous week (`week_iso`)
- Insert into `featured_plots_snapshots`
- Generate thumbnails: server-side render via headless three.js + node-canvas. Cache as PNG at `apps/api/public/thumbnails/plot-:petId-:week.png`. Acceptable performance ceiling: <30s for 3 plots.
- Town Hub 3D object reads `/api/plots/featured?week=current` on render and displays the 3 thumbnails as textured planes on a podium

---

## Failure modes + mitigations

| Scenario | Mitigation |
|---|---|
| Owner offline, visitor places op | Op rejected (`op_rejected: not-authorized`) |
| Co-builder loses connection mid-op | Op buffered client-side, re-sent on reconnect with same `seq`; server idempotent |
| Co-build invite expires | `co_build_ended` broadcast; co-builder demoted to viewer |
| WS disconnect during edit | Last 30s of ops persisted; client re-fetches snapshot on reconnect |
| Plot grew to 200 props | Place button disabled with "Plot full" tooltip; owner must delete first |
| Voter spams 👍 | Per-week unique constraint enforces idempotency |
| Guestbook spam | 30/min POST rate limit + 200-message FIFO trim |
| Featured rotator fails mid-render | Telegram alert; current-week snapshot stale until manual re-run |
| Bot pets visiting plots | Recorded in `pet_plot_visits` but excluded from `featured_plots_snapshots` (filter `subject_type != 'bot'` if added later) |

---

## Implementation chunks (dependency order)

1. **Foundation** — schema + shared types + REST routes (read-only) — `pet_plots`, `pet_plot_visits`, `pet_plot_votes`, `pet_plot_guestbook`, `pet_plot_co_build_invites`, `featured_plots_snapshots`. Seed empty plots for existing pets via migration script. ~2 days.
2. **WS hub + op validation** — `apps/api/src/services/plot/plot-ws-hub.ts`, `plot-op-validator.ts`. Server-authoritative state. ~2 days.
3. **3D plot scene** (3da) — `PlotScene` + `PlotGround` + `PlotProps` + base camera. Visit-only mode first, no editing. ~2 days.
4. **Plot editor UI** (general-purpose) — palette + toolbar + drag-to-place + gizmo. Owner-only edit mode. ~3 days.
5. **Visit + voting + guestbook** — `PlotVisitorOverlay` + REST integration. ~1 day.
6. **Co-build invitations + multi-cursor presence** — invite flow + WS viewer cursors + co-build session enforcement. ~2 days.
7. **Featured Builds rotator + Town Hub 3D object** — cron + thumbnails + town-square podium. ~2 days.
8. **Tutorial quest hooks** — `coral-decorator` + `plot-explorer` quests added to `apps/web/src/lib/quests.ts`. ~0.5 day.
9. **Polish + sound + tutorial card** — Nori-voiced intro for first plot visit + sound on place/delete. ~1 day.

Total: ~15–16 days of focused work. Mirrors Q2 cadence.

---

## Open questions for founder

1. **Plot size.** 64×64wu = ~4096 sq wu. Reasonable for ~50–200 props. Larger plots feel emptier; smaller feel cramped. Confirm or adjust.
2. **Prop catalog source.** Reuse existing `coral-reef{1,2,3}.glb`, `seaweed`, `decorations` (~10 GLBs). Need ~40 more — OK to use Sketchfab CC0 batch (chairs, signs, lights, statues, lanterns, archways)?
3. **Voting weight.** 👍 only? Or thumbs-up + thumbs-down? Q2 brand says positive-only (no toxic patterns).
4. **Featured rotation cadence.** Weekly proposed. Daily would feel busier but might spotlight half-built plots; monthly might feel stale.
5. **Co-build session length.** No hard cap proposed — session ends when co-builder leaves OR owner revokes. Acceptable, or cap at e.g. 60 minutes to prevent stale invites?
6. **Plot privacy.** All plots public by default. Want a "private until ready" mode? Brand-consistent answer is "no, we ship publicly visible Plots day one and own the implication."
7. **Plot save snapshots / version history?** Not in Q3 scope. Worth adding to Q3.5 if owners ask for "undo my last 3 days of edits."
8. **Mobile editing.** View mode trivially mobile-friendly. Edit mode (drag-to-place) is the hard one. Q3 ships desktop-first; mobile editor in Q3.5.
9. **Bot avatars in plots.** Bots can be visited (their plot exists from `pets` row) but ship empty. Acceptable, or skip bot plots from search results entirely?
10. **Town Hub 3D placement.** Suggest placing the Featured Builds podium near Nori (town center is the natural hub). Confirm location before 3da builds.

---

## References

- `.claude/plans/roadmap-gamification.md` §3 (Builder World — Coral Plot)
- `.claude/plans/phase-quest-gamification-q2-activity-portals.md` (Q2 plan — pattern to mirror)
- `.claude/plans/q2-research/{3d,backend,frontend}-spec.md` (Q2 deep-source specs — reference for shape)
- Brand Identity §3 + §4 (CLAUDE.md)
- 3D constraints: `.claude/memory/threejs/` (Iris Xe gotchas)
- ElizaOS mandate (CLAUDE.md): does NOT apply to plot WS — plots aren't NPC chat
