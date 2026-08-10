# WS-PARITY — Cove Card Render-State Value Parity + Visual-Gate System (frozen spec, rev 4)

Author: spec-parity (Copus-MAX). Status: **RE-FROZEN rev 4** — final mechanical-precision pass (no design changes) after the round-3 final-verify report; orchestrator verifies by inspection, then implementation starts. All `version: 2` in the DOM/type contract below is the SCHEMA version (unchanged shape); the SPEC document is rev 4.
Repo baseline: worktree `C:\Users\itachi\Documents\Crypto\cv-cove-3d`, branch `feat/cove-3d-holdem`, HEAD `b982ded3`. READ-ONLY except the files in §1.
Sibling specs: `spec-blackjack3d`, `spec-baccarat3d`. **§A is the SINGLE frozen interface they CONSUME BY REFERENCE — they must not restate the schema (fixes M-4).**

> **Verdict-naming (M-12):** the automated harness proves **render-state value parity** — the right card value in the right slot facing the right way, in the right staged order, plus the enumerated visible-surface values (banner text, pot/chip totals, split highlight, bet-zone, on-felt bounds). It does NOT prove glyph legibility, UV correctness, occlusion, z-order, or WebGPU pixels — those retain **human screenshot/playtest sign-off**. Both gates are required for "displayed properly."

---

## 0. Founder framing (the acceptance bar)

> "If an outcome, or one of the parts of the card game (the deal, the fourth card, the fifth card, whatever it is) is not displayed to the user properly, that's equal to a backend error when it comes down to wagering ... we need to test FULL VISUAL PARITY with the backend."

Ruling (orchestrator): **backend changes are ALLOWED where display parity is impossible without them** — the founder's "not displayed properly = backend error" trumps wire conservatism. Two backend additions are ratified and specced in §BA. Each is flagged founder-visible in §9/§10.

Three parts: **(A)** instrumentation contract (the single frozen seam); **(BA)** the two ratified backend additions; **(B–J)** the harness, matrix, money, smoke, limits, rollout.

---

## A. INSTRUMENTATION CONTRACT — the SINGLE frozen interface (SEAM)

> **SEAM — CONSUMED BY REFERENCE by spec-blackjack3d + spec-baccarat3d + the hold'em retrofit. This is the ONLY place the schema, slot names, encoding, lifecycle, and correlation metadata live. Sibling specs cite §A; they must NOT restate or fork it (M-4). Any drift (e.g. `bj-scene-mirror`, `bac-rendered-state`, `rank-suit` tokens) is a defect to reconcile to §A before implementation.**

### A.1 Why a DOM mirror (verified correct by critique)

The 3D felt renders cards as merged `THREE.BufferGeometry` quads — no per-card DOM, no reliable WebGPU pixel to read (`cove-table-cards.tsx:210-271`, `:521-530`, `:583-603`; confirmed by Codex "Claims verified CORRECT"). WebGPU swapchain capture is unreliable headless ([[feedback_mcp_cannot_capture_webgpu_swapchain]]). So parity is asserted on a hidden DOM **mirror** published from the SAME resolved card values the visible surface renders from — never a parallel fetch (a parallel fetch passes vacuously; the point is to catch the *renderer* lying). Screenshots are secondary, human-review-only.

### A.2 The no-leak boundary is enforced BY THE TYPE (fixes B-5)

Practice hold'em is server-authoritative, but **at settlement the client receives real hole cards for ALL seats** — `seatsForSettled` maps `seat.holeCards` for every seat including folded ones (`holdem-controller.ts:225-235`), while `seatsForLive` uses hidden placeholders pre-settlement (`:200-218`). The renderer then forces folded/non-showdown seats to card-BACKS (`cove-table-cards.tsx:439-468`). So the client holds card values it intentionally conceals. If the mirror emitted `{card:"Qh", facing:"down"}` the hidden DOM would leak a concealed card. **Leakage must be unrepresentable in the type:**

```ts
export type CardCode = string & { readonly __brand: 'CardCode' }; // exactly 2 chars, see A.3
export type CardParitySlot =
  | { slot: string; facing: 'up';    card: CardCode; status?: SlotStatus }
  | { slot: string; facing: 'down';  card: '';       status?: SlotStatus }
  | { slot: string; facing: 'empty'; card: '';       status?: SlotStatus };
```

The DOM component **independently re-blanks** any non-`up` slot (never trusts the caller) before writing `data-card`. An adversarial unit test (§F) searches the ENTIRE mirror DOM for every known folded/opponent card code of the current hand and FAILS if any appears in a non-`up` slot.

### A.3 Card code

`{RANK}{SUIT}`, exactly 2 chars. RANK ∈ `A 2 3 4 5 6 7 8 9 T J Q K` (`T` = wire rank `"10"`). SUIT ∈ `c d h s`. Encoder input is normalized from each game's render card via a single type:

```ts
// Renamed from the misleading `WireCard` (M-3): this is the CLIENT RENDER card, a
// view-model superset — NOT any one game's wire schema (holdem shared card has no
// `hidden`: cove-holdem.ts:33-37; blackjack does: cove-blackjack.ts:27-32; baccarat
// none: cove-baccarat.ts:27-31). The mirror normalizes all three to this shape.
export interface ParityRenderCard { suit: 'clubs'|'diamonds'|'hearts'|'spades'; rank: string; hidden?: boolean }
// Return type is the FACING+CARD projection of the discriminated CardParitySlot (M-3 fix —
// the earlier `CardParitySlotFacingAndCard`/`Pick<...>` were undefined/lossy). It keeps the
// up⇒code, down/empty⇒'' discrimination so a caller cannot pair a code with a non-up facing:
export type CardFacingAndCode =
  | { facing: 'up';    card: CardCode }
  | { facing: 'down';  card: '' }
  | { facing: 'empty'; card: '' };
export function encodeCardCode(card: ParityRenderCard | null | undefined): CardFacingAndCode;
// null/undefined → {facing:'empty',card:''}; hidden===true → {facing:'down',card:''};
// else → {facing:'up',card:<CardCode>}. Security-critical sanitizer; the ONLY producer of a code.
```

### A.4 DOM schema (frozen) + correlation metadata (fixes B-3, M-1)

One hidden root per active card surface. Every root carries a **monotonic render revision + correlation keys** so the harness binds a mirror snapshot to the exact authoritative object that produced it (not "latest response for URL"):

```html
<ol data-cv-parity="holdem-felt-practice"  <!-- frozen surface id (VALID variant — MINOR 1), A.5 -->
    data-cv-parity-version="2"
    data-cv-render-revision="418"        <!-- monotonic; STORE-OWNED (A.6), no caller supplies it -->
    data-cv-correlation-hand="h_8846"    <!-- handId | coupId | cash key `${tableId}:${handNumber}` (BLOCKER 7) -->
    data-cv-hand-number="8846"
    data-cv-deal-step="river"            <!-- staged reveal step, A.6 -->
    data-cv-phase="river"
    data-cv-transition="idle"            <!-- 'idle' | 'revealing' | 'muck-fading' -->
    hidden aria-hidden="true">
  <li data-slot="board-1" data-card="Ah" data-facing="up"></li>
  <li data-slot="board-5" data-card=""   data-facing="empty"></li>
  <li data-slot="opp-3-1" data-card=""   data-facing="down" data-status="active"></li>
</ol>
```

Frozen roots (surface ids — **explicit 2D/3D variant, fixes M-10/M-1**): `holdem-felt-3d`, `holdem-tray-3d`, `holdem-felt-practice`, `holdem-tray-practice`, `blackjack-2d`, `blackjack-3d` (when spec-blackjack3d ships), `baccarat-2d`, `baccarat-3d`. The harness asserts the surface id it is testing; a 2D-modal mirror can never satisfy a 3D-room checkpoint. **Never use the bare `holdem-felt` (invalid — MINOR 1); always the `-3d`/`-practice` variant.**

Frozen attributes: `data-cv-parity` (surface), `-version` (`"2"`), `-render-revision`, `-correlation-hand`, `-hand-number`, `-deal-step`, `-phase`, `-transition`; per-`<li>` `data-slot`, `data-card`, `data-facing`, `data-status`; root meta `data-*` per §A.7. **No `-wire-seq`** — correlation is application-visible only; the harness resolves the `WireRecord` itself (new-error 3).

**Per-surface `<li>` cap (MINOR 1 — the "≤17" of A.8 is a per-surface limit, not global):** `holdem-felt-*` ≤ 16 (5 board + 5 opponent seats × 2 = 15); `holdem-tray-*` ≤ 7 (2 hole + 5 board); `blackjack-*` ≤ **64** (a legal multi-hit/split hand can exceed 17; the DOM cap is set to MATCH the sibling's 64-quad mesh cap so the DOM mirror never truncates a hand the mesh can render — orchestrator addendum); `baccarat-*` ≤ 6. The DOM builder loud-fails if a surface exceeds its cap (never silently truncates).

### A.5 Slot names per game (frozen)

**Hold'em** — two roots per surface (felt + tray):
- felt: `board-1..5`; `opp-{seat}-1/2` per seated opponent (seat = server `seatIndex`). **Opponent cards are `facing:'down'` in cash always** (public snapshot never carries values — `poker-table-types.ts:104-120`, confirmed). Practice: flip to `facing:'up'` only for non-folded seats at showdown reveal (`cove-table-cards.tsx:442`). **The felt root is published by the COMPOSITE room publisher, not TableCards3D alone (fixes B-2)** — it MUST include `PeekHandCards` back-meshes (`holdem-table-room.tsx:587-609`, rendered outside TableCards3D `:973-978`, suppressed from the merged mesh `:995-1010`). Peek seats appear as `opp-{seat}-1/2 facing:'down'`; the felt root reconciles merged-mesh + peek + suppression into ONE fixed seat-slot set.
- tray: `hole-1/2` (own private); `board-1..5` (narrated board, MAY lag felt during staged reveal — §A.6).

**Staged-reveal scope (BLOCKER 5, orchestrator ruling = option (b)):** the visible FELT reads `controller.communityCards` directly and shows the full board immediately (`cove-table-cards.tsx:478`), while only the TRAY delays cards via `narratedCards` (`SeatedHoldemHud.tsx:651`). Publishing staged values on the felt would violate §A.1 (mirror must equal what the felt renders); publishing the full board on the felt while asserting a staged sequence would violate the matrix. Resolution: **ordered street-by-street replay checkpoints (hole→flop→turn→river→showdown) are asserted ONLY on `holdem-tray-practice`.** The felt (`holdem-felt-*`) is asserted only at the states it actually renders — the full authoritative board as soon as it exists, and opponent presence/reveal. The room's visible reveal behavior is NOT changed (it awaits founder verdict as-is). Whether the 3D felt SHOULD reveal street-by-street like the tray is a product question deferred to §10.

**Blackjack** (`blackjack-2d`/`-3d`): `player-{h}-card-{m}` (h∈{0,1}, split creates h=1); `dealer-card-{m}`. `dealer-card-2` (hole) is `facing:'down'` pre-settlement and the client never holds its value (`BlackjackModal.tsx:694` gives only `dealerUpcard`; the hidden placeholder is fabricated `:1338-1340`), so `data-card=""` is structural. Reveals at settle from `SerializedDealerHand.cards` (`cove-blackjack.ts:71-77`).

**Baccarat** (`baccarat-2d`/`-3d`): `player-1..3`, `banker-1..3` (3rd may be `facing:'empty'`). All dealt cards `facing:'up'` (atomic settled coup — `BaccaratModal.tsx:553-559`).

### A.6 Lifecycle — monotonic revision + staged reveal + fade completion (fixes B-3, B-4)

The B-3 race is real: `muckFadeRef.current.active` is set in the layout effect (`cove-table-cards.tsx:541-544`) but cleared imperatively in `useFrame` (`:571`) with NO React re-render; a naive `stable` boolean can publish `true` mid-fade-start or stay stuck `false` after completion. The child-to-parent resolved-slot callback can also fire before the parent publishes its root, and an old completion can clear a newer/remounted transition (BLOCKER 4). Fix — a SINGLE store-owned allocator with **atomic, instance-guarded** semantics (no per-frame React update, no allocation):

```ts
// The STORE owns the monotonic renderRevision — callers NEVER supply it (BLOCKER 4).
// State is keyed PER SURFACE (one Hold'em branch publishes felt AND tray concurrently
// under the SAME instanceId — new-error 1), each entry carrying its own owner+revision+
// cachedRoot+activeSpan. publishFeltParity returns the allocated revision.
publishFeltParity(instanceId: string, payload: CardParityPayload): number;
beginTransition(instanceId: string, surface: Surface, kind: 'revealing'|'muck-fading'): number; // returns a spanToken
completeTransition(instanceId: string, surface: Surface, spanToken: number): boolean;            // false if the span was superseded
clearFeltParity(instanceId: string): void;                                                       // clears ALL surfaces owned by instanceId
// `CardParityPayload` = `CardParityRoot` WITHOUT `instanceId`/`renderRevision` (the store stamps both).
```

Frozen store semantics:
- **Per-surface state + ownership (new-error 1):** the store holds a `Map<Surface, {instanceId, revision, cachedRoot, activeSpan}>`. A branch owns MULTIPLE surfaces at once (holdem-felt-* + holdem-tray-* both under its instanceId). `publishFeltParity` keys on `payload.surface`; a publish from a NON-owning instanceId for that surface is REJECTED (returns the current revision, no overwrite). Ownership of a surface transfers on the first publish after that surface is cleared. `clearFeltParity(instanceId)` clears **every** surface entry currently owned by `instanceId` (both felt and tray for a holdem branch) — new-error 1.
- **Semantic dedup (MAJOR 7):** each payload is reduced to a canonical semantic signature (surface + correlation + dealStep + ordered slot codes/facings + meta). If it equals that surface's cachedRoot signature, publish is a **no-op** — returns the SAME revision, does NOT bump. Prevents cash-poll object-identity churn (`page.tsx:126`) and hand-sample pose churn from minting fake revisions.
- **Transition span survives intermediate revisions (new-error 2 — separate generation token):** `beginTransition(instanceId, surface, kind)` opens a span on that surface and returns a monotonic `spanToken`; it sets the surface's `activeSpan=spanToken` and `transition=kind`. Intermediate `publishFeltParity` calls during the span bump `renderRevision` and carry `transition=kind` but do NOT change `activeSpan` — so dealer-reveal→settled (two revisions in one span) do not invalidate it. `completeTransition(instanceId, surface, spanToken)` succeeds ONLY if `activeSpan===spanToken` (and the instance still owns the surface): it sets `transition='idle'` and publishes once; a superseded/stale span token returns `false` and changes nothing. Callable safely from `useFrame` (`:571`) — allocates nothing, no-ops when stale.
- **Revision journal (MAJOR 8):** every accepted publish appends `{surface, instanceId, revision, dealStep, transition, signature, ts}` to a bounded in-page journal (ring buffer, cap ~256) the harness reads via `window.__CV_PARITY_JOURNAL(surface)`. The harness asserts the ORDERED JOURNAL, not only the latest snapshot — so a reveal step that advanced before a browser read still appears in the journal (fixes "ordered revisions not reliably observable").

- Practice staged reveal — **`holdem-tray-practice` ONLY** (BLOCKER 5; the felt shows the full board immediately and is NOT staged): tray publishes a new revision at EACH `dealStep`/street transition (`data-cv-deal-step` = `hole|flop|turn|river|showdown`) from `narratedCards` (`SeatedHoldemHud.tsx:516-542,651-654`), not final-only. The harness asserts the ordered JOURNAL: hole→flop(3)→turn(4)→river(5)→showdown, exact slot set at each, no skips, no simultaneous turn+river, correct order (fixes B-4). A stuck/jumped reveal FAILS. The `holdem-felt-*` root is asserted only at the full-board states it actually renders.
- Muck fade (felt): `const span = beginTransition(instanceId, 'holdem-felt-*', 'muck-fading')` at fade start (layout effect), `completeTransition(instanceId, 'holdem-felt-*', span)` from `useFrame` when `progress>=1` (`:571`) — publishes idle once for that span; a superseded fade's stale span token no-ops. Harness asserts BOTH muck start (folded seats down + fading) and completion via the journal.
- The harness requires an EXPECTED `renderRevision` (from the journal) + `correlation-hand` + `deal-step` + `phase` for each checkpoint — never "any snapshot whose transition says idle." **The root carries NO harness sequence (new-error 3):** it carries only application-visible immutable correlation (`correlation-hand`, `hand-number`, `dealStep`, `renderRevision`); the HARNESS resolves the matching `WireRecord` from its own capture buffer by correlation (§2 `expected-from-wire` takes the resolved `WireRecord`). There is no `data-cv-wire-seq` on the root.
- **dealStep vocabulary (frozen — resolves ambiguity #5): `hole`** is the preflop deal step (NOT `preflop`; `phase` may read `preflop` but `dealStep` is `hole`). Full holdem-tray sequence: `hole → flop → turn → river → showdown`. Blackjack: `hole → player-turn → [split → player-turn →] dealer-reveal → settled` (§7). Baccarat: `deal → player-1 → banker-1 → player-2 → banker-2 → [player-3 →] [banker-3 →] settled`.
- **Named intermediate revision steps within a span (blackjack, same one-span pattern as baccarat):** a game MAY publish a NAMED intermediate revision inside a span. Blackjack's settled span: `const span = beginTransition(instanceId, 'blackjack-2d', 'revealing')` → publish a `dealer-reveal` revision (revealed dealer hand, `dealer-card-2` up + `dealer-total`, **NO banner/outcome meta**) → publish a `settled` revision (adds banner/outcome meta) → `completeTransition(instanceId, 'blackjack-2d', span)` (→idle). BOTH intermediate publishes happen inside the ONE span (the spanToken survives them — new-error 2). The harness asserts the `dealer-reveal` revision before the `settled` revision; only the final `settled` revision requires `transition==='idle'` and carries the wagering-outcome meta. dealStep is a free string, so `dealer-reveal` is just another named step.
- **Intermediate-vs-final assertion rule (binds all three games — clarifies the single-span question):** a reveal is ONE transition span with `transition='revealing'` throughout while `dealStep` advances inside it; a per-card-step transition is NOT required. Intermediate staged steps are asserted by `(renderRevision, dealStep)` and do **NOT** require `transition==='idle'` — otherwise a single-span reveal would be unassertable mid-sequence. Only the FINAL checkpoint of a hand/coup requires `transition==='idle'` (published by `completeTransition`); that final state is the load-bearing wagering checkpoint and must equal the wire object exactly. Each staged step MUST persist as its own distinct `renderRevision` (do not collapse/skip revisions for fast steps) so the harness can sample it; a step missed between two revisions is bounded by §9 limitation #4. For games whose full result is atomic on the wire (baccarat — one `/coup` response), a missed intermediate frame does not compromise the final wagering assertion, since every card is already in the captured wire object; the staged steps verify reveal ORDER, the final `idle` checkpoint verifies VALUES.

### A.7 Root meta per game
- holdem-tray settle: `data-outcome` (`showdown`|`fold` from `settled.outcome.endedAt`, `holdem-settlement-narration.ts:37`), `data-winners` (comma seat list, `outcome.pots[].winners` ∪ `seat.isWinner`), `data-net`, `data-pot`, `data-banner-text` (verbatim narration headline — visible-surface assertion, M-12).
- blackjack: `data-player-{h}-total/-soft/-bust/-blackjack/-resolved`, `data-dealer-total` (post-reveal only), `data-outcome-{h}`, `data-insurance-offered/-taken`, `data-active-slot`, `data-banner-text`.
- baccarat: `data-player-total/-natural`, `data-banker-total/-natural`, `data-winner`, `data-bet`, `data-stake`, `data-commission`, `data-net`, `data-banner-text`, `data-betzone-selected` (visible bet-zone highlight, M-12).

### A.8 Cost, prod-safety, instance ownership (fixes N-2, O-4)

- Cheap: `<li>` count is bounded by the **per-surface caps table in §A.4** (holdem-felt ≤16, holdem-tray ≤7, blackjack ≤64, baccarat ≤6 — there is NO global ≤17; that earlier claim is deleted, item 8). Re-rendered only on card-state change (same signature gating the geometry rebuild); zero per-frame React/alloc; `hidden`+`aria-hidden`. Iris-Xe safe.
- Prod-safe always-on: exposes only player-entitled state (the A.2 type guarantees it).
- **Instance ownership (N-2/O-4):** `publishFeltParity` carries an `instanceId`; `<ParityMirror surface instanceId/>` renders nothing unless that surface's active publisher is `instanceId`; each Canvas branch calls `clearFeltParity(instanceId)` on unmount (clearing ALL surfaces it owns) so a module-store snapshot can't survive a route change. Mount adjacent to each EXCLUSIVE page-level Canvas branch (`cove/table/page.tsx` practice `:100-105`, cash `:292-315`; exclusive selection `:61-64`) — NOT solely inside a HUD that can conditionally disappear.

---

## BA. Ratified backend additions (founder-visible)

### BA-1 — Cash hold'em settled-hand snapshot (unblocks H10; fixes B-1, M-9)

**Why required:** the cash action response is only `{ok, advancedStreet, handComplete, nextToActAvatarId}` (`cove-cash-poker.ts:355-359`); the public snapshot never carries hole cards (`poker-table-types.ts:104-120`); the agent view carries only the requester's own (`:166-174`); after an action the manager can settle→advance bots→settle→begin the next hand immediately (`cash-table-manager.ts:1002-1010`); per-subject showdown cards live only in owner-scoped history events (`:1299-1325`, `cove-history.ts:314-354`). A polling client can jump river→next hand without ever receiving a terminal object. So displayed winners / shown-opponent cards / chip deltas / net cannot be asserted — **not a repeat-budget problem, a missing observable**. Repeating hands cannot fix it.

**Spec — new authoritative settled-hand snapshot, built at the simulator boundary where the award truth still exists.** The lossy conversion is the root defect: `awardPots` returns full `SeatResult[]` (won/rank/eligibility, `holdem-engine.ts:1638-1662`) but `poker-table-sim.ts:987-990` collapses pots to `PublicSidePot {amount, eligibleSeatIndices}` — DISCARDING winners + per-winner awards; `poker-table-types.ts:238` and `cash-table-manager.ts:1254` therefore cannot restore them (BLOCKER 3, verified). Fix = a terminal `SettledPotResult` captured at the sim boundary and persisted unchanged, plus a full settled-hand snapshot.

```ts
// NEW — DECLARED + EXPORTED from `packages/shared/src/types/cove-holdem.ts` (item 4 — the web cash
// builders import it from `@clawville/shared`; add the file-plan entry in §1). Captured in
// poker-table-sim.ts where awardPots' result is still whole, persisted verbatim (potResultJson below).
export interface TypedHandRank {                     // serializable form of the engine's HandRank (item 4 — was undefined)
  category: number;                                  // HandCategory 0..8 (HandResultSeat.handRankCategory, poker-table-types.ts:224)
  categoryName: string;                              // e.g. 'flush', 'two_pair' — display label
  tiebreakers: number[];                             // ranks used to break ties, high→low (serializable; from evaluateBest5)
}
export interface SettledPotResult {
  amount: string;                                   // stringified bigint
  eligibleSeatIndices: number[];
  awards: { seatIndex: number; amount: string }[];  // per-winner award incl. odd-chip remainder split
  winningRank: TypedHandRank | null;                // null on a fold-win (no showdown eval)
}
export interface CashSettledSeat {
  seatIndex: number; avatarId: string;
  startStack: string; endStack: string;             // endStack = startStack - totalCommitted + grossWon (cash-table-manager.ts:1240)
  totalCommitted: string;
  grossWon: string;                                  // = SeatResult.won, gross chips returned from all pots
  rakeAttributed: string;                            // "0" today — cash settlement takes NO rake yet (verified: chips only move between seats, cash-table-manager.ts:1241); field reserved so a future rake is attributable per seat without a wire change
  net: string;                                       // = grossWon - totalCommitted (poker-table-types.ts:221)
  stackDelta: string;                               // = endStack - startStack (== net today; distinct field so a future rake makes them diverge)
  status: 'active'|'folded'|'allin'|'busted'|'sitting_out';
  shown: [Card, Card] | null;                       // ENTITLEMENT below — folded ⇒ null for EVERYONE incl. owner
  mucked: boolean;                                   // true iff status==='folded' (no discretionary muck state exists — MAJOR 1)
}
export interface CashSettledHandSnapshot {
  handId: string; handNumber: number; tableId: string;
  board: Card[];                                     // final board (0..5; fewer on an early fold-win)
  endedAt: 'preflop'|'flop'|'turn'|'river'|'showdown';
  pots: SettledPotResult[];
  seats: CashSettledSeat[];
  settledAtMs: number;                               // server settle timestamp (absolute)
  displayExpiresAtMs: number;                        // ABSOLUTE expiry = settledAtMs + DISPLAY_WINDOW_MS; the client holds+shows the result until then
}
```

**Persistence (item 4 — freeze the shape + tests):** add a `pot_result_json JSONB` column (+ per-seat accounting) to `poker_cash_hands` — a Drizzle migration file `packages/database/migrations/NNNN_cash_settled_snapshot.sql` + schema edit in `packages/database/src/schema/*`. `potResultJson` stores `SettledPotResult[]` verbatim (bigints as strings); the per-seat block stores `CashSettledSeat[]` minus `shown` (cards are re-derived under entitlement at read time from the persisted hand, never stored pre-masked). Tests: round-trip a multi-pot hand through persist→`/last-settled`; assert `potResultJson` equals the sim's `awardPots` output byte-for-byte; assert `Σ awards.amount == Σ pots.amount` and per-pot `Σ awards == amount`.

**Ledger txn IDs (M-9 — item 4):** buy-in and cash-out already produce ledger transactions (`cash-table-manager.ts:733` buy-in debit, `:904` cash-out credit). The `sit` response carries `buyInLedgerTxnId` and the `leave`/cash-out response carries `cashOutLedgerTxnId`; the harness's wallet assertions (§8) wait on and cite those exact txn ids (buy-in debit == table stack; cash-out credit == final seat stack), not an inferred `lastKnownStack`.

**Entitlement (MAJOR 1 — codify CURRENT sim behavior, no new muck states):** `shown` = exactly `HandResultSeat.holeCards` as the sim computes it (`poker-table-sim.ts:967-977`): `endedAt==='showdown' && status!=='folded'` ⇒ the seat's two cards; otherwise `null`. So a **folded hand is `null` for EVERYONE including its owner** (the owner saw their own cards live during the hand; on a recovery GET the client renders folded seats face-down). A fold-win reveals **nobody**. There is no "own always" and no discretionary muck. Delete the earlier "own always" wording.

**Transport (MAJOR 2 — mandatory authenticated GET; no gameplay-pacing change):**
- `GET /api/cove/poker/cash/tables/:id/last-settled?afterHandNumber=N` — **authenticated, mandatory**. Returns the latest `CashSettledHandSnapshot` for the table with `handNumber > N` if the requester was a **historical participant of that hand** (authorize against the persisted hand's seat set, NOT current seating — a player who was dealt in then left must still fetch it). `200` + snapshot; `204`/`{snapshot:null}` when none newer; `403` if the requester never sat in that hand; `404` unknown table. Poll cadence: the client polls this alongside the public poll (3000ms) while `Date.now() < displayExpiresAtMs`.
- **Do NOT delay `startAndAdvance`** (no gameplay-pacing change without founder — the next hand starts immediately as today, `cash-table-manager.ts:1002-1010`); the settled-result overlay **coexists** with the next hand until `displayExpiresAtMs`. `DISPLAY_WINDOW_MS` is a server constant (proposed 8000).
- The action-response **embed is optional garnish, never load-bearing** — bot/timer completions after the action returns would miss it (`cash-table-manager.ts:994`), so the GET is the only authoritative path.
- Persist `SettledPotResult` + per-seat accounting on the `pokerCashHands` checkpoint so `/last-settled` reconstructs it after the sim is stopped.

**Enumerated tests (BLOCKER 3 + MAJOR 1):** main+side pots; tied pots (split, odd-chip remainder award order); multiple all-ins with layered side pots; fold-win (all `shown:null`, `winningRank:null`); the **four requester classes** for `/last-settled` — (a) a winner, (b) a losing showdown seat, (c) a folded requester (sees own cards `null`), (d) an unrelated/never-seated requester (`403`).

**Same-diff:** money/settlement path → backend full-team + adversarial review, PARITY note; agent-callable ⇒ three operational-knowledge surfaces. **H10 stays `BLOCKED` until this ships; a green wagering gate cannot include H10 before then.**

### BA-2 — Staging-only deterministic fixture (makes required rare scenarios provable; fixes M-11, O-1; BLOCKERS 1+2)

**Why required:** the client cannot set the seed — `/session/open` accepts only `currency` (`cove-blackjack.ts:367-371`, `cove-baccarat.ts:345-349`); baccarat client seeds are server-generated (`cove-baccarat.ts:527-541`); cash hands draw `this.seedFn()` + `DEFAULT_CLIENT_SEED` (`cash-table-manager.ts:1138-1139`); practice hold'em seeds on its own `cove-holdem.ts` session path. Required rare scenarios then rest on unbounded-variance repeat-until-seen with real fund burn, and **`UNPROVEN` on a required scenario FAILS the gate (M-11)**. So they need server-enforced determinism across ALL FOUR seed paths.

**Design (strict, auditable, all four arms):**
1. **Enabling env + crash-loud gate (copy partner-signature.ts:81 exactly):** a NAMED env `CV_TEST_FIXTURE_ENABLED` (base58-style flag). The fixture module THROWS AT MODULE LOAD if the flag is set while `CLAWVILLE_ENV!=='staging'` (crash-loud, refuses to boot — identical pattern to `ALLOW_TEST_PARTNER_PUBKEY`), and RE-CHECKS `CLAWVILLE_ENV==='staging'` at every use. Prod can never activate it.
2. **Authenticated server-issued run token + exact wire schema (item 5).** Request `POST /api/cove/test-fixture/run` (auth'd as the dedicated harness account, §4), body `{ scenarioName: string; exposureBudgetCt: number; ttlSeconds: number }`. Response `201 { runId: string; token: string; ownerAvatarId: string; scenarioName: string; expiresAtMs: number; exposureBudgetCt: number }` (`token` = opaque 32-byte base64url, stored hashed). Every fixture-armed request carries header **`X-CV-Test-Fixture: <runId>.<token>`** (NOT an opaque seed blob — the old `{seedPair|scenarioName}` string is replaced). **Persistent DB (item 5):** new table `cove_test_fixture_runs` (migration `packages/database/migrations/NNNN_test_fixture_runs.sql` + schema entry): columns `run_id PK, owner_avatar_id, scenario_name, token_hash, started_at, expires_at, exposure_budget_ct, spent_ct, status ('active'|'expired'|'closed')`. `fixtureRunId` FK columns added to `blackjack_shoes` / `baccarat_shoes` / `poker_cash_hands` / `cove_game_events` (same migration). *(Corrected 2026-07-26: an earlier revision named these `cove_blackjack_shoes` / `cove_baccarat_shoes` — tables that do not exist; the route's stale-run recovery SQL inherited the phantom names and 500'd every live/fixture row until fixed.)*
3. **Named scenario/seed catalog** — frozen `scenarioName` → seed pair OR explicit deal/action script. Rows: bj-split, bj-natural, bj-push, bj-insurance, bac-player-natural, bac-banker-natural, bac-player-third, bac-banker-third, bac-tie, **bac-shoe-near-threshold** (dealt-count just below 312 for the sibling's reshuffle/M8 smoke), **bac-shoe-exhausted** (dealt-count ≥ threshold), holdem-multiway-showdown, **holdem-fold-win** (H6 muck). (Added bac dealt-count fixtures + holdem-fold-win per item 5 / cross-spec M8.)
4. **All four seed arms wired + transactional one-shot consumption (item 5):** the fixture overrides (a) blackjack/baccarat shoe seed at `/session/open` (**refuses a stale/in-progress shoe** — `409 fixture_requires_fresh_shoe`, recovery = close-then-reopen; never silently replaces real-money state), (b) the cash `seedFn`/`clientSeed` (`cash-table-manager.ts:1138`), (c) the practice `cove-holdem.ts` session seed. **One-shot rule:** arming a fixture consumes it in the SAME DB transaction that creates the shoe/hand — a `scenarioName` marked one-shot flips a `consumed` flag atomically so a retry cannot re-arm the same outcome; `fixtureRunId` is stamped on every shoe/hand/event row it produces (the FK columns above).
5. **Server-enforced budget on EVERY wager leg** (deal, hit-double-split incremental, insurance, cash buy-in): the wager path checks `token owner == request subject`, `Date.now() < expiresAt`, and `spentCt + legStakeCt <= exposureBudgetCt`; over-budget/expired ⇒ `402 fixture_budget_exhausted`, run auto-closes. Units = atomic vCLAW.
6. **Teardown/recovery:** `DELETE /api/cove/test-fixture/run/:runId` closes the run + any open fixture shoe; on hard death the next run's preflight finds the stale `active` record by `ownerAvatarId`, force-closes it, and reconciles.

**RISK CORRECTION (was wrong in the critique's rationale):** staging does **NOT** share the production database — staging has its OWN dedicated Supabase DB (project ref `mtpixvtclsjqjguouxes`, since 2026-06-16). The strict design above stands anyway as **defense in depth** (a deterministic-outcome header is dangerous regardless of which DB it hits), but the risk is stated accurately: a fixture leak would corrupt STAGING money state, not prod.

- Does NOT solve BA-1 (cash showdown serialization is a separate observable).
- **Same-diff:** money-path → full-team + adversarial review; `CV_TEST_FIXTURE_ENABLED` + `CLAWVILLE_ENV` documented in CLAUDE.md with the crash-loud rule.

---

## 1. File-by-file change list

**Instrumentation (SEAM) — new:**
- `apps/web/src/lib/cove/card-parity-mirror.ts` — the frozen encoder (`encodeCardCode`), the branded `CardParitySlot` union (A.2), the ONE store-owned allocator + lifecycle (`publishFeltParity(instanceId,payload)`/`beginTransition`/`completeTransition`/`clearFeltParity`/`subscribeFeltParity(surface,cb)`/`getParitySnapshot(surface)`) + the bounded revision journal, and pure builders (`buildBlackjackParity`/`buildBaccaratParity`/`buildHoldemTrayParity`/`buildHoldemFeltParity`) returning `CardParityPayload`. No React/Three imports.
- `apps/web/src/components/cove/CardParityMirror.tsx` — a SEPARATE component file (NOT part of the lib; both must land together — MAJOR 5). Exports `<ParityMirror surface instanceId/>` which `useSyncExternalStore`s `subscribeFeltParity(surface)`/`getParitySnapshot(surface)` and renders the hidden `<ol>` for the current owner only (renders nothing if `snapshot.instanceId !== instanceId`). Pure DOM, `hidden`, independently re-blanks every non-`up` slot before writing `data-card` (never trusts the payload). ALL surfaces (2D modals + 3D felt/tray) use this one component + the one store — there is no separate `root`-prop path.

**Instrumentation wiring — edits (VERIFIED paths for THIS worktree — see the note below on the critique's mis-paths):**
- `apps/web/src/lib/three/holdem-table-room.tsx` — **the COMPOSITE felt publisher (B-2)**. In `HoldemTableRoomScene`, compute the full opponent-slot set from BOTH the `TableCards3D` inputs AND `inHandPeekSeats`/`PeekHandCards` (`:859-881`, `:973-978`, `:995-1010`) and call `buildHoldemFeltParity(...)` → `publishFeltParity`. TableCards3D exposes its resolved slot list via a callback prop (not its own publish) so the room composes one root. `beginTransition('muck-fading')`/`completeTransition` bridged from TableCards3D's fade (`cove-table-cards.tsx:541-544`, `:571`).
- `apps/web/src/lib/three/cove-table-cards.tsx` — EDIT: emit the resolved board/opponent slot list (the exact `card`/`holeCardCount`/`faceDown` values it built quads from, `:426-496`) to the room via callback in the same layout effect (`:394`); signal fade begin/complete. Does not publish directly.
- `apps/web/src/components/cove/holdem/SeatedHoldemHud.tsx` — EDIT: in an effect, `publishFeltParity(instanceId, buildHoldemTrayParity({kind:'practice', hole:playerHoleCards, narratedBoard:narratedCards, publicSeats, settled, dealStep, …}))` from the SAME values the tray renders (`:218`,`:651-654`,`:760-773`), publishing a revision per `dealStep` (B-4). Render `<ParityMirror surface="holdem-tray-practice" instanceId/>`. `CashTableRoomHud`: `buildHoldemTrayParity({kind:'cash', hole:freshSelf.holeCards, board:live.board, settled:ba1Snapshot, …})`.
- `apps/web/src/app/cove/table/page.tsx` — EDIT: create ONE stable `instanceId` per exclusive branch (`useRef(crypto.randomUUID())` in `PracticeDemoRoom` `:100-105` and `CashTableRoom` `:292-315`; MAJOR 5), thread it branch→`HoldemTableRoomCanvas`→`Scene`→composite publisher AND into `<ParityMirror surface=… instanceId/>`; `clearFeltParity(instanceId)` on branch unmount; consume BA-1 `last-settled` in `CashTableRoom` (`:253-267`).
- `apps/web/src/components/cove/blackjack/BlackjackModal.tsx` — EDIT: effect `publishFeltParity(instanceId, buildBlackjackParity({hand, settled, activeSlot, surface:'blackjack-2d', correlation, dealStep, …}))`; render `<ParityMirror surface="blackjack-2d" instanceId/>`.
- `apps/web/src/components/cove/baccarat/BaccaratModal.tsx` — EDIT: effect `publishFeltParity(instanceId, buildBaccaratParity({outcome, bet:betType, stake:baccaratBet, surface:'baccarat-2d', correlation, dealStep, …}))`; render `<ParityMirror surface="baccarat-2d" instanceId/>`.
- **spec-blackjack3d / spec-baccarat3d 3D rooms** consume §A by reference (composite publisher + `-3d` surface ids). Per the orchestrator, both siblings DELETE their restated schema/lifecycle text and keep ONLY controller→builder field mappings (fixes M-4/MAJOR 4).

**MAJOR 5 — instanceId plumbing (frozen):** each exclusive page branch mints ONE stable `instanceId` (`useRef(crypto.randomUUID()).current`), passed as a prop down branch→Canvas→Scene→composite publisher and into the `<ParityMirror>`. `HoldemTableRoomCanvas`/`HoldemTableRoomScene` signatures (`holdem-table-room.tsx:831`,`:1017`) gain an `instanceId: string` prop. The store rejects publishes from any other instanceId, so a remounting branch cannot clobber the active one; `clearFeltParity(instanceId)` on unmount releases ownership.

> **CITATION DISCREPANCY (verified this session, flagged per orchestrator ruling 3 / N-1):** the critique cites component files under `apps/web/src/components/game/BlackjackModal.tsx` and `.../game/SeatedHoldemHud.tsx`. Those paths do **NOT exist** in this worktree at HEAD b982ded3 — `find apps/web/src -name BlackjackModal.tsx` returns only `apps/web/src/components/cove/blackjack/BlackjackModal.tsx` (and `.../cove/holdem/SeatedHoldemHud.tsx`). The critique's SUBSTANTIVE findings are correct against the equivalent `cove/` files; only its component PATH prefix is stale. This spec uses the verified `components/cove/...` paths. (The `apps/api/...` and `apps/web/src/lib/...` citations in the critique match this worktree.)

**Shared types — new/edit (item 4 — the web cash builders import these):**
- `packages/shared/src/types/cove-holdem.ts` — DECLARE + EXPORT `TypedHandRank`, `SettledPotResult`, `CashSettledSeat`, `CashSettledHandSnapshot` (single source; the API `poker-table-types.ts` re-exports from here or mirrors it, and `@clawville/database` rebuild after edit per the workspace-dist rule).

**Backend additions — edits (BA):**
- BA-1: `apps/api/src/services/poker/poker-table-sim.ts` (capture `SettledPotResult` at the boundary where `awardPots` truth still exists, `:987-990`) + `poker-table-types.ts` (consume the shared DTOs) + `cash-table-manager.ts` (persist `potResultJson` + per-seat accounting on `pokerCashHands`; expose `buyInLedgerTxnId` `:733` / `cashOutLedgerTxnId` `:904`) + `apps/api/src/routes/cove-cash-poker.ts` (`GET /tables/:id/last-settled`) + migration `packages/database/migrations/NNNN_cash_settled_snapshot.sql` (`pot_result_json` + per-seat columns).
- BA-2: new `apps/api/src/services/cove-test-fixture.ts` (env gate `CV_TEST_FIXTURE_ENABLED` + `CLAWVILLE_ENV` crash-loud, copied from `partner-signature.ts:81`; run-record store; token hash; budget enforcement; one-shot consumption) + `apps/api/src/routes/cove-test-fixture.ts` (`POST/DELETE /run`) + fixture arms in `cove-blackjack.ts`, `cove-baccarat.ts`, `cash-table-manager.ts` (`seedFn`), `cove-holdem.ts` (practice seed) + migration `packages/database/migrations/NNNN_test_fixture_runs.sql` (`cove_test_fixture_runs` + `fixture_run_id` FK columns on shoes/hands/events).

**Harness — new (`scripts/parity/`):** `run-parity.ts` (CLI + lifecycle), `driver.ts` (agent-browser 0.31.1, `--init-script`), `capture-hook.js` (pre-nav fetch/Response wrapper → bounded keyed `WireRecord` buffer + `__CV_PARITY_JOURNAL`), `expected-from-wire.ts` (`resolveWireForRoot` by application correlation + adapter; consumes BA-1 snapshot for cash showdown), `diff.ts`, `scenarios/{holdem,blackjack,baccarat}.ts`, `visible-surface.ts` (§6 probe table), `atlas-fixture/contact-sheet.ts` (+ `out/atlas/APPROVED.md`), `report.ts`, `preflight.ts`/`teardown.ts` (§K state machine), `README.md`, `.gitignore` (`out/`, `*.state.json`, `auth.json`).

**Docs (same-diff, §I):** `3dStructure.md`, `GameFeatures.md §18a`, `ARCHITECTURE.md` (BA-1 route + BA-2 env), new `docs/cove-visual-parity-spec-2026-07-23.md`. The handover doc is at `C:\Users\itachi\documents\crypto\clawville\docs\cove-3d-holdem-handover-2026-07-21.md` (MAIN repo — NOT this worktree; cite full path or drop — fixes N-1).

---

## 2. Exact TS signatures

```ts
// card-parity-mirror.ts
export type CardFacing = 'up' | 'down' | 'empty';
export type SlotStatus = 'active'|'folded'|'allin'|'busted'|'resolved';
export type CardCode = string & { readonly __brand: 'CardCode' };
export type CardParitySlot =
  | { slot: string; facing: 'up';    card: CardCode; status?: SlotStatus }
  | { slot: string; facing: 'down';  card: '';       status?: SlotStatus }
  | { slot: string; facing: 'empty'; card: '';       status?: SlotStatus };

export type Surface =
  | 'holdem-felt-3d'|'holdem-tray-3d'|'holdem-felt-practice'|'holdem-tray-practice'
  | 'blackjack-2d'|'blackjack-3d'|'baccarat-2d'|'baccarat-3d';
export interface Correlation { hand: string; handNumber: number | null; shoe?: string }
// hand = handId | coupId | (cash) `${tableId}:${handNumber}` (BLOCKER 7); handNumber set for holdem, null for bj/bac.

// Builders return a PAYLOAD (no instanceId/renderRevision — the STORE stamps both, BLOCKER 4).
// NO wireSeq — the root carries only application-visible correlation; the harness resolves the
// matching WireRecord itself (new-error 3).
export interface CardParityPayload {
  surface: Surface; version: 2;
  correlation: Correlation;
  dealStep: string; phase: string;
  transition: 'idle'|'revealing'|'muck-fading';
  slots: CardParitySlot[];
  meta: Record<string, string>;
}
// The rendered/stored root = payload + the store-stamped {instanceId, renderRevision}.
export interface CardParityRoot extends CardParityPayload { instanceId: string; renderRevision: number }

export interface ParityRenderCard { suit:'clubs'|'diamonds'|'hearts'|'spades'; rank:string; hidden?:boolean }
export function encodeCardCode(c: ParityRenderCard|null|undefined): CardFacingAndCode; // (A.3)

// ── Single store-owned allocator (A.6) — PER-SURFACE state (new-error 1); serves ALL surfaces. ──
export function publishFeltParity(instanceId: string, payload: CardParityPayload): number; // returns revision; dedup → same revision; non-owner-of-payload.surface → current revision
export function beginTransition(instanceId: string, surface: Surface, kind: 'revealing'|'muck-fading'): number; // returns a spanToken (new-error 2)
export function completeTransition(instanceId: string, surface: Surface, spanToken: number): boolean;            // false if the span was superseded
export function clearFeltParity(instanceId: string): void;                                  // clears ALL surfaces owned by instanceId
export function subscribeFeltParity(surface: Surface, cb: () => void): () => void;
export function getParitySnapshot(surface: Surface): CardParityRoot | null;

// ── Builders (PURE; return CardParityPayload). Callers ALIGN to these (frozen SEAM). ──
// Holdem uses ONE discriminated input covering practice + cash (BLOCKER 7):
export type HoldemFeltInput =
  | { kind:'practice'; board:(ParityRenderCard|null)[];
      opponents:{ seatIndex:number; status:SlotStatus; cards:[ParityRenderCard,ParityRenderCard]|null; count:number; peek:boolean }[];
      correlation:Correlation; dealStep:string; phase:string; transition:CardParityPayload['transition'] }
  | { kind:'cash'; board:ParityRenderCard[];
      opponents:{ seatIndex:number; status:SlotStatus; count:number; peek:boolean }[]; // cash NEVER carries opponent card values
      settled: import('@clawville/shared').CashSettledHandSnapshot|null;               // BA-1; null pre-settle
      correlation:Correlation; dealStep:string; phase:string; transition:CardParityPayload['transition'] };
export function buildHoldemFeltParity(i: HoldemFeltInput): CardParityPayload;
export type HoldemTrayInput =
  | { kind:'practice'; hole:ParityRenderCard[]; narratedBoard:(ParityRenderCard|null)[];
      publicSeats:{folded:boolean}[]; settled: import('@clawville/shared').HoldemSettledResponse|null;
      correlation:Correlation; dealStep:string; phase:string; transition:CardParityPayload['transition']; bannerText?:string; pot?:string }
  | { kind:'cash'; hole:ParityRenderCard[]; board:ParityRenderCard[];
      settled: import('@clawville/shared').CashSettledHandSnapshot|null;               // BA-1 supplies winners/net/pot meta
      correlation:Correlation; dealStep:string; phase:string; transition:CardParityPayload['transition']; bannerText?:string; pot?:string };
export function buildHoldemTrayParity(i: HoldemTrayInput): CardParityPayload;
export function buildBlackjackParity(i:{
  hand:{ playerHands:{cards:ParityRenderCard[]; total:number; isSoft:boolean; isBust:boolean; isResolved:boolean}[];
         dealerUpcard:ParityRenderCard|null; insuranceOffered:boolean; tookInsurance:boolean; didSplit:boolean }|null;
  settled:{ outcome: import('@clawville/shared').SerializedBlackjackHandResult }|null;
  activeSlot:0|1; surface:'blackjack-2d'|'blackjack-3d'; correlation:Correlation;
  dealStep:string; phase:string; transition:CardParityPayload['transition']; bannerText?:string }): CardParityPayload;
export function buildBaccaratParity(i:{
  outcome: import('@clawville/shared').SerializedBaccaratCoup|null;
  bet:'player'|'banker'|'tie'; stake:number; surface:'baccarat-2d'|'baccarat-3d'; correlation:Correlation;
  dealStep:string; phase:string; transition:CardParityPayload['transition'];
  bannerText?:string; betzoneSelected?:string }): CardParityPayload;

// FROZEN builder-input rule (SEAM): every build* input IS the frozen seam. Callers align field
// names to these (one harness adapter per game); the builder never bends to a caller. Cards nest
// in the game object; controller ids map to Correlation.hand (cash = `${tableId}:${handNumber}`);
// dealStep/phase/transition supplied per publish. Builders NEVER receive instanceId/renderRevision
// (store-owned) NOR wireSeq (harness-resolved). Publish site: `publishFeltParity(instanceId, buildX(...))`.
```

```ts
// driver.ts (agent-browser 0.31.1 — --init-script verified: commands.md:419-424)
export interface Driver {
  openWithInitScript(url:string, initScript:string): Promise<void>;  // registers hook BEFORE first nav (M-2)
  evalJson<T>(js:string): Promise<T>;
  click(sel:string): Promise<void>; fill(sel:string,v:string): Promise<void>;
  waitFn(js:string, timeoutMs?:number): Promise<void>;
  screenshot(path:string): Promise<void>; close(): Promise<void>;
}
// capture-hook.js — bounded keyed buffer + revision journal (M-1/M-8/O-5, no unbounded array).
// Frozen wire record: requestBody/responseBody are SEPARATE (M-1); `seq` is the harness capture
// buffer's OWN counter (NOT on any root — new-error 3); key = (urlSuffix, seq); ring cap 256/bucket.
export interface WireRecord {
  seq: number; method: string; url: string; urlSuffix: string; status: number;
  requestBody: unknown; responseBody: unknown;
  handId: string|null; handNumber: number|null; coupId: string|null; shoeId: string|null; idempotencyKey: string|null;
}
//   window.__CV_WIRE_GET(urlSuffix, seq?)  : WireRecord | null   (seq omitted → latest for that suffix)
//   window.__CV_WIRE_SINCE(urlSuffix, afterSeq) : WireRecord[]   (ordered, for correlating a hand's response set)
//   window.__CV_READ_PARITY(surface)       : CardParityRoot | null   (current snapshot)
//   window.__CV_PARITY_JOURNAL(surface)    : { surface,instanceId,revision,dealStep,transition,signature,ts }[]  (ordered, MAJOR 8)

// expected-from-wire.ts — the HARNESS resolves the WireRecord matching a root by its application
// correlation (root.correlation.hand / handNumber / dealStep), NOT by any root-carried seq (new-error 3).
export function resolveWireForRoot(root: CardParityRoot): WireRecord | null; // harness-side correlation match
export function expectedFromWire(game:'holdem'|'blackjack'|'baccarat', surface:Surface,
  wire: WireRecord,                        // the record resolveWireForRoot returned
  ba1Snapshot?: import('@clawville/shared').CashSettledHandSnapshot):  // cash showdown needs BA-1
  { slots:Record<string,{card:string;facing:CardFacing;status?:string}>; meta:Record<string,string> };

// diff.ts
export interface Mismatch { slot:string; field:'card'|'facing'|'status'|`meta:${string}`; expected:string; actual:string }
export function diffParity(expected:ReturnType<typeof expectedFromWire>, mirror:CardParityRoot):
  { pass:boolean; mismatches:Mismatch[] };

// scenario contract — checkpoint pins revision + correlation + dealStep (B-3/B-4)
export interface ParityCheckpoint { label:string; surface:string; expectRevisionAdvance:true;
  expectDealStep?:string; expectCorrelationHand?:string; }
export interface Scenario { game:'holdem'|'blackjack'|'baccarat'; tier:'guest'|'live';
  surface:string; name:string; required:boolean;      // required ⇒ UNPROVEN FAILS gate (M-11)
  reachedPredicate:(wire:any)=>boolean;
  run(d:Driver):AsyncGenerator<ParityCheckpoint>;
  teardown(d:Driver):Promise<void>;                    // per-scenario finally (M-5)
}
```

---

## 3. JSON schemas

### 3.1 Mirror (`__CV_READ_PARITY` = `CardParityRoot`) — incl. revision + correlation
```json
{ "surface":"blackjack-2d","version":2,"instanceId":"bj-01","renderRevision":51,
  "correlation":{"hand":"h_…","handNumber":null,"shoe":"s_…"},"dealStep":"settled","phase":"settled",
  "transition":"idle",
  "slots":[{"slot":"player-0-card-1","card":"Ah","facing":"up"},
           {"slot":"dealer-card-2","card":"","facing":"down"}],
  "meta":{"player-0-total":"21","outcome-0":"blackjack","dealer-total":"","banner-text":"BLACKJACK!"} }
```

### 3.2 Captured wire (`WireRecord` via `__CV_WIRE_GET(urlSuffix,seq)`) — requestBody/responseBody split (M-1)
```json
{ "seq":7,"method":"POST","url":"/api/cove/blackjack/hand/deal","urlSuffix":"blackjack/hand/deal","status":200,
  "handId":"…","handNumber":null,"coupId":null,"shoeId":"…","idempotencyKey":"…",
  "requestBody":{ "shoeId":"…","bet":25,"insurance":false },
  "responseBody":{ "status":"in_progress","playerHand":[{"suit":"hearts","rank":"A"}],
                   "dealerUpcard":{"suit":"diamonds","rank":"9"},"bet":"25","balance":975 } }
```

### 3.3 Per-scenario result (`out/{scenario}.json`) — surface + correlation + money legs + visible-surface
```json
{ "scenario":"blackjack.live.split.blackjack-2d","game":"blackjack","tier":"live","surface":"blackjack-2d",
  "required":true,"reached":true,"pass":false,
  "checkpoints":[{"label":"after-split","revision":52,"correlationHand":"h_…","surface":"blackjack-2d",
     "pass":false,"mismatches":[{"slot":"player-1-card-1","field":"card","expected":"8h","actual":""}],
     "resolvedWireSeq":9,"screenshot":"…"}],  // the WireRecord.seq the HARNESS resolved for this root (not carried on the root — new-error 3)
  "visibleSurface":{"bannerText":{"expected":"YOU WIN","actual":"YOU WIN","pass":true},
                    "onFeltBounds":{"pass":true}},
  "money":{"equation":"final = initial - totalBet + rakedPayout","initial":1000,"totalBet":50,
           "rakedPayout":48,"final":998,"legs":{"afterDeal":975,"insurance":0},"pass":true} }
```

### 3.4 `out/matrix.md`
Table: `game | tier | surface | scenario | required | phases/steps | reached | PASS/FAIL/UNPROVEN/BLOCKED | mismatches | screenshots`. Summary line. **Gate verdict = FAIL if any required row is FAIL/UNPROVEN/BLOCKED** (M-11). H10 rows read `BLOCKED (needs BA-1)` until the snapshot ships.

---

## 4. Env / config

- Local stack: web `http://127.0.0.1:3003`, api `http://127.0.0.1:4002` (explicit IPv4). Config `scripts/parity/parity.config.json`: `{webBase, apiBase, viewport:[1280,800], repeatBudget:{…}, maxLossPerRun, maxDurationMs, screenshotDir}`; env overrides `CV_PARITY_*`.
- **Dedicated harness identity (M-6, pragmatic):** a test account used EXCLUSIVELY by the harness (NOT `landtest1`, the founder-adjacent one). Credentials in memory topic `feedback_staging_test_accounts_and_agent_rightsizing` — **NEVER printed into any spec/report/log/screenshot filename.** Provision via agent-browser auth vault (piped stdin) or a pre-saved state file loaded by path (`.gitignore`d). **No server-side lease is specced** — instead preflight-REFUSE to start if an unexpected active session/open-shoe/seat exists for that identity, and document cross-run contention as **residual risk**.
- agent-browser 0.31.1: `open --init-script <path>` (verified) registers the capture hook before first nav (M-2).
- **Real rate limits (M-11 — the ~90s cash cooldown claim is DROPPED; it does not exist in this worktree):** guest shoe-open cap = **10/hour/fingerprint** (`cove-blackjack.ts:175-194`, `cove-baccarat.ts:165-184`); cash table CREATION limited separately (`cove-cash-poker.ts:59-60`,`:196-200`) — not a per-hand cooldown. The runner reuses one open shoe across a scenario's deals and rotates fingerprint/identity only within budget.
- Option B gate: house tables deal only with ≥1 real seated player (`cash-table-manager.ts:1119-1125`) — live holdem sits the dedicated identity first.
- BA-2 fixture: `X-CV-Test-Fixture` staging-only (crash-loud on prod), per-run `runId`, `maxLoss`/`maxDuration`.

---

## 5. Decision tables

### 5.1 Driver
| need | tool |
|---|---|
| navigate/click/fill/wait/screenshot | agent-browser 0.31.1 CLI |
| install capture BEFORE first nav | `open --init-script capture-hook.js` (M-2) |
| read mirror | `eval` → `__CV_READ_PARITY(surface)` |
| capture wire (correlated) | init-script fetch/Response wrapper → `__CV_WIRE_GET` (bounded keyed) |
| wait a staged INTERMEDIATE checkpoint | `waitFn` on journal `renderRevision`>expected AND `dealStep===expected` — **does NOT require `transition==='idle'`** (intermediate-vs-final rule, §A.6); only the FINAL hand/coup checkpoint waits for `transition==='idle'` |
| pixel evidence | screenshot (secondary, human) |

### 5.2 Forcing strategy (client cannot seed — verified)
| outcome | strategy |
|---|---|
| always occurs | assert first occurrence |
| deterministic given action | drive + assert |
| **required rare** (BJ split/natural/push/insurance; BAC naturals/3rd/tie; HOLDEM multiway showdown) | **BA-2 fixture (deterministic)** — required scenarios may NOT rest on repeat-until-seen; `UNPROVEN` FAILS the gate (M-11) |
| optional rare | repeat-until-seen within budget; UNPROVEN allowed only if flagged non-required |
| negative (dealer hole down; opp hole down; folded-not-leaked) | assert every hand (structural + A.2 encoder) |

### 5.3 Surface reachability (explicit surface ids — M-10)
| game | tier | surface id | reached |
|---|---|---|---|
| holdem | guest | `holdem-felt/tray-practice` | `/cove/table` logged-out → auto-sit T1 practice |
| holdem | live | `holdem-felt/tray-3d` | login → `?tableId=…` → SIT (Option B); H10 needs BA-1 |
| blackjack | guest+live | `blackjack-2d` (+`-3d` when it ships) | `/cove` hotspot modal; core scenarios must pass on EVERY shipped surface |
| baccarat | guest+live | `baccarat-2d` (+`-3d`) | `/cove` hotspot modal |

**Explicit cross-product (M-10) — MUST agree with §7's per-row tiers (item 6):**
- **Both-tier core** (run on every shipped surface × {guest, live}): blackjack **{B1 deal, B-neg}** (the only §7 rows defined guest+live); baccarat **{C6 bet-zones}** (guest+live); holdem **{H-neg}**.
- **Single-tier core** (run on their §7 tier only × every shipped surface — NOT the full tier cross-product): blackjack B2 hit-order = **guest-only**, B4 dealer-reveal + B5 bust = **live-only**; holdem H1–H4 deal/streets = **practice-guest** (`holdem-*-practice`), H8/H9 seated deal/streets = **cash-live** (`holdem-*-3d`).
- **Surface caveat:** `blackjack-3d`/`baccarat-3d` cells apply only once those rooms ship; B9 insurance stays `blackjack-2d`-only (§7).
- **Rare** (tier/surface-limited, matrix says so per row; report never claims full cross-product): blackjack B3/B6/B7/B8/B9, baccarat C1–C5/C7, holdem H5/H6/H10.
There is no `C-deal` or `C-neg` (deleted — item 6; baccarat's every-coup deal is covered by C1–C7). The matrix runner expands each core row over its declared `{surface}×{tier}` set and emits one result cell per combination.

---

## 6. Offline smoke plan

Baselines (Codex re-confirms; adding the mirror must not regress): web `tsc --noEmit` = **12 errors** (count `): error TS`); api tsc = **0**; web `bun test` = **re-confirm current count with `bun test`** (orchestrator brief said 55/4, handover recorded 52/4 — use the live count as baseline); `bun run build` passes.

**New unit tests (offline, deterministic):**
- `card-parity-mirror.test.ts`: `encodeCardCode` all 52 + hidden + null (rank `"10"`→`T`); each `build*` against fixture render state → expected root; **the branded union makes `{facing:'down',card:'Xx'}` a COMPILE error** (B-5).
- `no-leak.test.ts` (adversarial): given a practice-settled state holding real folded/opponent cards (`holdem-controller.ts:225-235`), the built root + rendered DOM contain NONE of those codes in non-`up` slots; searches the whole mirror DOM (B-5).
- `diff.test.ts`: identical ⇒ pass; wrong card / missing slot / facing swap ⇒ fail.
- `expected-from-wire.test.ts`: correlation-keyed adapter per game.
- `lifecycle.test.ts`: staged reveal publishes monotonic revisions per dealStep (no skip/simultaneous/out-of-order, B-4); `completeTransition` publishes once after fade (B-3).

**Atlas correctness (ship gate — orchestrator ruling 5 + MAJOR 6 + item 9, executable). §A OWNS the ONE shared normalization procedure; the siblings CITE it and delete their local versions (cross-spec atlas FAIL):**
- **Source of truth:** the atlas mapping/drawing/UV span `cove-table-cards.tsx:19-272` — the constants (`ATLAS_*`, `SUIT_*`, `RANK_*`), `drawFaceCell`/`drawBackCell`/`drawCardCorner`/`traceRoundedRect`/`getCardAtlas`, `atlasCellForCard`, and the UV math in `appendCardQuad`.
- **THE shared normalizer (frozen — `scripts/parity/atlas-fixture/normalize-atlas.ts`, single implementation all three specs import):** (1) extract the span above from a file; (2) **strip the whitelisted capacity/guard delta** — remove the exact tokens `MAX_CARD_QUADS`, any `>= MAX_CARD_QUADS` / quad-cap guard line, and per-game DOM `<li>`-cap constants (matched by a frozen allow-list of identifier names, so a sibling raising its cap 17→64 does not fail); (3) strip ALL comments (`//` and `/* */`); (4) collapse every run of whitespace to a single space and trim per line; (5) normalize EOL to `\n` (LF). Then sha256 the result. This is the SINGLE procedure — Blackjack's "exclude named cap/guard" and Baccarat's "strip comments/collapse ws/EOL" are merged into exactly these five steps; neither sibling defines its own.
- `atlas.test.ts`: `normalizeAtlas(holdemSource)` is the reference hash; asserts `normalizeAtlas(bjRoomCopy) === ref` and `normalizeAtlas(bacRoomCopy) === ref`; asserts `atlasCellForCard` for all 52 + back against the audited mapping. Any glyph/UV drift fails; a cap change does not.
- **Contact-sheet step (wired into the smoke plan, not a side note):** `bun scripts/parity/atlas-fixture/contact-sheet.ts` renders the 53-cell sheet (52 faces + back) to `scripts/parity/out/atlas/contact-sheet.png`; a human reviews it and records approval in `scripts/parity/out/atlas/APPROVED.md` (sha of the sheet + reviewer + date). The gate FAILS if the current sheet sha has no matching APPROVED record. Both sibling smoke plans MUST invoke this same step (not describe their own).

**Visible-surface probe contract (M-12, executable — `visible-surface.ts`):** each visible-surface assertion reads the ACTUAL rendered element via a frozen selector and compares to the wire, NOT the mirror meta (so it independently proves the human-visible value):
| assertion | selector (frozen) | vs |
|---|---|---|
| settlement banner text | blackjack `[data-testid="bj-outcome-banner"]`, baccarat `[data-testid="bac-outcome-banner"]`, holdem `[data-testid="holdem-settlement-narration"]` (`SeatedHoldemHud.tsx:722`) | wire outcome → expected label text |
| pot total (holdem) | `[data-testid="holdem-pot-amount"]` (add to the pot metric span, `SeatedHoldemHud.tsx:791`/`:233`) — text parsed to int | wire `pot` |
| chip/stack total (holdem) | `[data-testid="holdem-self-stack"]` (self-stack metric span) | wire seat `chipStack`/BA-1 `endStack` |
| net (blackjack/baccarat) | `[data-testid="bj-banner-net"]` / `[data-testid="bac-banner-net"]` (the net line inside the banner) — text parsed to int | wire `net` |
| stake (baccarat) | `[data-testid="bac-bet-pill"]` (the "Your bet … N vCLAW" pill, `BaccaratModal.tsx:682-692`) | wire `outcome.stake` |
| split active-hand highlight | `[data-testid="bj-subhand-0"]` / `bj-subhand-1`, each with `data-active="true"|"false"` on the focused sub-hand container | wire `activeSlot` (the `true` one) |
| baccarat bet-zone highlight | the selected `[role="radio"][aria-checked="true"]` in the bet selector (`BaccaratModal.tsx:125-129`) | wire `outcome.bet` |
| on-felt bounds (GATE, O-2) | the felt store's `onFelt` flag computed on card-state change from the bounds math (`cove-table-cards.tsx:498-519`) | must be true; a bounds failure FAILS the gate |

Any sibling that lacks one of these `data-testid`s adds it (small, additive) — the selectors are part of §A's frozen contract.

**Harness self-test (`--self-test`, mandatory before trusting any green matrix):** drive one real deal, then via `eval` mutate one `<li data-card>` to a wrong value, run `diffParity` → assert `pass=false` with exactly that `Mismatch`. If it passes, the harness is blind → non-zero exit.

---

## 7. Scenario matrix (scenario × tier × surface)

Legend: **P**=phase/step asserted (ordered, B-4). Negatives run every hand. `required=Y` ⇒ UNPROVEN/BLOCKED FAILS the gate.

### Hold'em (staged street replay is TRAY-ONLY — `holdem-tray-*`; the felt is asserted only at the full-board states it renders, BLOCKER 5)
| # | tier | surface | scenario | req | staged checkpoints | forcing |
|---|---|---|---|---|---|---|
| H1 | guest | practice | hole dealt | Y | tray rev@hole: `hole-1/2` up, board empty; felt `opp-*` down | natural |
| H2 | guest | practice | flop (3) | Y | **tray** rev@flop: `board-1/2/3` up in order (ordered replay is TRAY-ONLY, BLOCKER 5); felt asserted at full-board only | natural |
| H3 | guest | practice | turn (4th card) | Y | **tray** rev@turn: `board-4` up (not before flop) | natural |
| H4 | guest | practice | river (5th card) | Y | **tray** rev@river: `board-5` up | natural |
| H5 | guest | practice | showdown reveal | Y | rev@showdown: non-folded `opp-*` flip up = controller holeCards; muck start+complete for folded; `data-outcome`,`data-winners`,`banner-text` | BA-2 fixture |
| H6 | guest | practice | fold-win + muck | Y | `data-outcome=fold`; losers down+muck-faded (start+complete); net | BA-2 fixture |
| H7 | guest | practice | pot/blinds | Y | tray rev@`hole`: `data-pot`, blinds vs wire | natural |
| H8 | live | 3d | seated deal | Y | tray rev@`hole`: own `hole-1/2`=AgentSeatView.holeCards; `opp-*` down (public has none) | natural (SIT) |
| H9 | live | 3d | cash streets | Y | flop/turn/river = `live.board`, ordered | natural |
| H10 | live | 3d | cash showdown/settle | Y | **BLOCKED — needs BA-1** (winners/shown/mucked/deltas/net/displayUntil) | BA-1 then fixture |
| H-neg | both | all | opp never leaks | Y | every step: `opp-*` down + `data-card=""` unless wire reveals; folded settled cards absent from DOM | always |

### Blackjack — surface `blackjack-2d` today (`blackjack-3d` when it ships). CORE rows (B1/B2/B4/B5/B-neg) run on EVERY shipped surface × {guest,live} per §5.3; rare rows (B6–B9) are live-only via BA-2.
| # | tier | scenario | req | checkpoints | forcing |
|---|---|---|---|---|---|
| B1 | guest+live | 2+2 dealer hole down | Y | `player-0-card-1`,`player-0-card-2` up; `dealer-card-1` up, `dealer-card-2` down+"" | natural |
| B2 | guest | hit order | Y | each hit appends `player-0-card-{m}` in wire order | drive |
| B3 | guest | double | Y | 3rd card up; `resolved=true` | drive |
| B4 | live | dealer reveal+draw | Y | **at dealStep `dealer-reveal`** (distinct from `settled`): `dealer-card-2` up = wire hole; draws up; `dealer-total` — assert the revealed dealer hand here, BEFORE the settlement banner resolves at `settled` | drive stand |

**Blackjack dealStep sequence (canonical, published by spec-blackjack3d's controller):** non-split `hole` → `player-turn` → `dealer-reveal` → `settled`; **split path** `hole` → `player-turn` → `split` → `player-turn` (now on the two sub-hands) → `dealer-reveal` → `settled`. The harness asserts each checkpoint at its own dealStep — post-split state at `split` (see B8), dealer hand at `dealer-reveal`, outcome/banner meta at `settled` (dealStep is a free string; the harness asserts whatever ordered sequence the room publishes, per §A.6).
| B5 | live | bust | Y | bust card up (not under banner, `BlackjackModal.tsx:150`); `bust=true`,`outcome-0=loss` | drive |
| B6 | live | natural | Y | inline settle `outcome-0=blackjack` | BA-2 fixture |
| B7 | live | push | Y | `outcome-0=push` | BA-2 fixture |
| B8 | live | split | Y | **at dealStep `split`:** `player-0`+`player-1` each 2 cards (original + one dealt to each), both fans present — holds for split-aces too (Ace + one card = 2 per sub-hand). Then at `settled`: `active-slot`, per-slot outcome (`split` in `cove-blackjack.ts:397`) | BA-2 fixture |
| B9 | live | insurance | Y (**`blackjack-2d` ONLY**) | dealer-Ace ⇒ `insurance-offered=true`; after insure `-taken=true` (`:420`) — **SURFACE-SCOPED: required on `blackjack-2d` only.** The 3D room excludes the insurance bet by ruling until the founder-gated `insurance_pending` backend wave (blackjack spec OQ-1) ships; requiring B9 on `blackjack-3d` would make its gate unpassable by design, so B9 is NOT a cross-product row and `blackjack-3d` omits it until OQ-1 lands. | BA-2 fixture |
| B-neg | both | dealer hole down | Y | every in-progress read: `dealer-card-2` down+"" | always |

### Baccarat (`baccarat-2d`, +`-3d`)
| # | tier | scenario | req | checkpoints | forcing |
|---|---|---|---|---|---|
| C1 | guest | player natural P2 | Y | `player-1/2` up, `player-3` empty, `player-natural=true`, `winner` | BA-2 fixture |
| C2 | guest | banker natural B2 | Y | `banker-natural=true` | BA-2 fixture |
| C3 | live | player 3rd card | Y | `player-3` up per tableau, total | BA-2 fixture |
| C4 | live | banker 3rd card | Y | `banker-3` up per tableau | BA-2 fixture |
| C5 | guest | tie | Y | `winner=tie`; P/B bet net 0 | BA-2 fixture |
| C6 | live | 3 bet zones | Y | one coup per bet; `data-bet` + `betzone-selected` match | drive |
| C7 | live | commission | Y | banker-bet win: `data-commission` = wire `outcome.commission` (integer) | BA-2 fixture |

### Visible-surface assertions (M-12 — run alongside every settle checkpoint)
banner text (`data-banner-text` verbatim vs rendered), pot/chip/stake totals, split-hand active highlight, baccarat bet-zone highlight, and the **always-on on-felt bounds check as a GATE** (O-2 — compute on card-state change only, from `cove-table-cards.tsx:498-519`; a bounds failure FAILS the gate).

---

## 8. Money discipline (exact integer equations — M-7/M-8/M-9)

All money is integer vCLAW; assert exact wire fields, never floating-point percentages.
- **Blackjack (M-7):** stake committed at deal; insurance debited later (`cove-blackjack.ts:1423-1493`); double/split debit the incremental delta `totalBet - stakedAmount` before the settle credit (`:1098`,`:1808-1819`). Assert the complete equation `final = initial - totalBet + rakedPayout` (with `totalBet` incl. all legs incl. insurance), OR per-leg `afterDeal = initial - stakedAmount` then `final = afterDeal - (totalBet - stakedAmount) + rakedPayout`. Naturals settle inline (no intermediate checkpoint) — handle both.
- **Baccarat (M-8):** commission = `stake - floor(stake*95/100)` (integer, `baccarat-engine.ts:510-515`) — NOT exactly 5% at small stakes. Assert exact `outcome.commission`/`payout`/`net`/`balance` from the coup response (`cove-baccarat.ts:1056-1070`); tie+P/B ⇒ net 0.
- **Cash holdem (M-9):** sit returns table stack not wallet (`cash-poker.ts:157-163`); leave may queue with no final cash-out (`:165-175`); UI infers from `lastKnownStack` (`page.tsx:189-200`). **No `≈` assertions** — per-hand deltas assert against **BA-1**'s frozen per-seat fields: `endStack == startStack - totalCommitted + grossWon`, `net == grossWon - totalCommitted`, `stackDelta == endStack - startStack`, `rakeAttributed == "0"` (cash takes no rake today — `cash-table-manager.ts:1241`; chips only move between seats so `Σ stackDelta == 0` across the hand — a conservation assertion). **Caveat (M-9):** per-hand cash settlement moves the SEAT stack, it does NOT create a wallet-ledger transaction — the wallet only changes on buy-in (sit) and cash-out (leave). So wallet-level assertions are made at sit/leave boundaries (buy-in debit; cash-out credit == final seat stack), and per-hand assertions are made against the seat-stack accounting in the BA-1 snapshot. There is no per-hand wallet ledger row to wait on. Until BA-1 ships, cash money rows are `BLOCKED`.

Money is a separate column; a money mismatch is reported and (for required rows) FAILS the gate.

---

## 9. Honest limitations

1. **Render-state value parity, not full visual (M-12).** Proves value/slot/facing/order + enumerated visible-surface values + on-felt bounds. Does NOT prove glyph legibility, UV correctness, occlusion, z-order, WebGPU pixels — human sign-off retained. The atlas gate (§6) catches wrong glyphs at the atlas layer only.
2. **Two backend changes are founder-visible (BA-1, BA-2).** H10 (cash showdown) is BLOCKED until BA-1; required rare scenarios need BA-2. Both are money-path → full-team + adversarial review + PARITY notes.
3. **No client seeding.** Optional rare scenarios not covered by BA-2 may end UNPROVEN (non-required only); the matrix names them + hands played.
4. **Staged reveal is asserted from the ordered revision JOURNAL (MAJOR 8)**, so a step that advances before a browser read still appears — the earlier "missed frame" risk is largely closed. Residual: a defect entirely WITHIN one dealStep revision (identical endpoints, no distinct revision minted) is invisible; granularity is per dealStep/street, which the semantic-dedup rule guarantees is distinct per real card-state change.
5. **Concurrency residual risk (M-6).** No server lease; preflight-refuse + dedicated identity + per-scenario/SIGINT/postflight teardown (M-5) reduce but do not eliminate cross-run/founder contention.
6. **Rate limits stretch runtime.** 10 guest shoes/hour/fingerprint; cash Option-B seating. A full live matrix is minutes.
7. **Sibling 3D rooms not yet built** — `-3d` surfaces target the 2D modals until they ship; §A drops in without a harness rewrite.

---

## 10. Rollout + open questions

### Rollout
0. **Shared DTOs first (W-C dependency):** land `TypedHandRank`/`SettledPotResult`/`CashSettledSeat`/`CashSettledHandSnapshot` in `packages/shared` — the web cash builders in step 1 do not compile without them.
1. Land `card-parity-mirror.ts` (branded union + per-surface store + span-token lifecycle) **AND** `CardParityMirror.tsx` **together** — both parity files are a JOINT prerequisite for BOTH room waves (W-A/W-B) and neither room's wiring compiles until both land (item 10b). Plus offline unit tests (no-leak, lifecycle incl. span-token survives intermediate revisions, atlas normalizer/gate) — verify tsc 12 / api 0 / build.
2. Composite hold'em felt publisher in `holdem-table-room.tsx` (incl. PeekHandCards, B-2) + `cove-table-cards.tsx` callback + tray staged-revision publishing (B-4) — additive/inert; default-view screenshot confirms awaiting-verdict visuals unchanged.
3. 2D `BlackjackModal`/`BaccaratModal` mirrors.
4. **BA-1** cash settled-hand snapshot (backend full-team + adversarial) → unblock H10.
5. **BA-2** staging fixture (backend full-team + adversarial, crash-loud) → make required rare scenarios deterministic.
6. Harness (`scripts/parity/`): `--init-script` capture, correlation-keyed diff, preflight/teardown, `--self-test` (must catch the injected lie), atlas contact-sheet.
7. Guest matrix locally (:3003/:4002); then live matrix on the dedicated identity.
8. `out/matrix.md` + screenshots for founder. **No "done" without founder sign-off** (E4) — "harness green on N/M required, K blocked-on-BA-1, needs your eyes on the matrix + glyph screenshots."
9. Same-diff docs (§1). PARITY note per backend change. Nothing pushed until founder go.

### Open questions (resolved per critique) + FOUNDER product questions
- **O-1 (deterministic fixture):** ADOPTED as BA-2 (full design §BA-2). Does not solve BA-1.
- **O-2 (felt-bounds):** ADOPTED as a mandatory GATE (§6 probe table), always-on, computed on card-state change.
- **O-3 (withheld cards):** cash opp hole withheld pre- AND at-showdown (BA-1 adds entitled showdown reveal); blackjack dealer hole until settle; practice settlement places real seat cards client-side → A.2 encoder suppresses (verified).
- **O-4 (mount):** per exclusive Canvas branch, stable `instanceId`, `clearFeltParity` on unmount (MAJOR 5).
- **O-5 (capture bound):** bounded keyed buffer + journal; exact accessors `__CV_WIRE_GET(urlSuffix,seq)` / `__CV_PARITY_JOURNAL(surface)`.
- **FOUNDER Q1 (product, BLOCKER 5):** should the 3D hold'em FELT reveal the board street-by-street like the tray, instead of showing the full board immediately? Today it does not; the harness scopes ordered replay to the tray and asserts the felt only at what it renders. Changing the felt's reveal is a product/UX call on a build awaiting founder verdict — NOT ours to change unasked.
- **FOUNDER Q2:** BA-1 (`/last-settled` + `DISPLAY_WINDOW_MS=8000`) and BA-2 (staging fixture) are money-path backend changes gating a full green wagering gate. Approve to proceed? H10 + all required rare rows stay BLOCKED/UNPROVEN (gate-failing) until they land.

---

## J. Frozen answers to the implementability ambiguity list (the implementability bar)

Every item from the re-critique's list gets a frozen answer here (pointer to the governing section):
1. **Revision allocator / monotonic scope / cached-root owner / atomic ordering / stale handling / instance guards** → §A.6 store semantics (store-owned monotonic revision; PER-SURFACE `Map<Surface,{instanceId,revision,cachedRoot,activeSpan}>`; non-owner-of-surface publish rejected; transition span-token survives intermediate revisions; `completeTransition` false if span superseded).
2. **TableCards callback payload / semantic dedup / parent publication** → §A.6 + §1: `cove-table-cards.tsx` emits its resolved slot list (exact `card`/`holeCardCount`/`faceDown`) to the room via callback; the room composes ONE payload and calls `publishFeltParity(instanceId, …)`; identical semantic signatures are no-ops.
3. **Stable instanceId creation + propagation** → MAJOR 5 (`useRef(crypto.randomUUID()).current` per branch, threaded to Canvas/Scene/publisher + `<ParityMirror>`).
4. **Whether the felt stages flop/turn/river** → BLOCKER 5 ruling (b): NO; ordered replay is tray-only; FOUNDER Q1 defers the product change.
5. **`hole` vs `preflop` deal-step vocabulary** → §A.6 frozen: `dealStep='hole'` for the preflop deal; `phase` may read `preflop`.
6. **Exact wire response consumed / requestBody vs responseBody / buffer key + eviction** → §2 `WireRecord` (separate `requestBody`/`responseBody`, `seq`, key `(urlSuffix,seq)`, ring cap 256/bucket); the root carries NO seq — the harness resolves the matching `WireRecord` from the root's application correlation via `resolveWireForRoot` (new-error 3).
7. **Cash correlation before BA-1 + cash→builder adapter** → BLOCKER 7: `Correlation.hand = `${tableId}:${handNumber}``; `HoldemFeltInput`/`HoldemTrayInput` discriminated `practice|cash`; BA-1 returns the same key.
8. **BA-1 GET wrapper / null-404-403 / cadence / historical-participant auth** → §BA-1 transport (auth'd `GET /last-settled?afterHandNumber=N`, `403` never-seated, `404` unknown table, `204`/null when none newer, poll while `< displayExpiresAtMs`, authorize against the persisted hand's seats).
9. **BA-1 expiry / acknowledgement / coexistence with next hand** → §BA-1: absolute `displayExpiresAtMs = settledAtMs + DISPLAY_WINDOW_MS(8000)`; overlay coexists; `startAndAdvance` NOT delayed.
10. **Own-folded-card policy + `mucked`** → §BA-1 entitlement (MAJOR 1): folded ⇒ `shown:null` for EVERYONE incl. owner; `mucked = (status==='folded')`; no discretionary muck.
11. **Per-pot eligibility / per-winner odd-chip awards / typed rank** → §BA-1 `SettledPotResult { amount, eligibleSeatIndices, awards[{seatIndex,amount}], winningRank }` (captured at the sim boundary where `awardPots` truth exists).
12. **`net`/`stackDelta`/rake/wallet verification** → §8 + §BA-1: `net=grossWon-totalCommitted`, `stackDelta=endStack-startStack`, `rakeAttributed="0"` today; wallet asserted only at sit/leave, per-hand at seat-stack level.
13. **BA-2 env / header+body schema / run token / scenario catalog / seed-action mappings** → §BA-2 (env `CV_TEST_FIXTURE_ENABLED`, run token via `POST /test-fixture/run`, frozen scenario→seed/script catalog).
14. **Which endpoint arms each fixture (practice + cash)** → §BA-2(4): bj/bac `/session/open`; cash `seedFn`/`clientSeed` (`cash-table-manager.ts:1138`); practice `cove-holdem.ts` session seed.
15. **Fixture one-shot consumption / persistence / restart / teardown / stale-shoe recovery** → §BA-2(4,6): fresh-shoe `409` + close-reopen recovery; `fixtureRunId` on shoes/hands/events; `DELETE /run/:id`; preflight force-closes a stale `active` run.
16. **Server-side budget units + enforcement** → §BA-2(5): atomic vCLAW, checked on every wager leg (owner+expiry+remaining exposure), `402` over-budget.
17. **Per-game preflight/teardown / queued-leave polling / hard-death recovery** → §K below.
18. **Exact scenario × tier × frozen-surface expansion** → §5.3 explicit cross-product + §7 per-row surface notes.
19. **Visible-DOM selectors/probes for banners/totals/highlights** → §6 visible-surface probe table (frozen `data-testid` selectors).

## K. Cleanup state machine (M-5, frozen)

Per-scenario `Scenario.teardown` + a run-level supervisor. State per game:
- **Blackjack/Baccarat:** if a hand/coup is in progress, play it to settle (never leave `in_progress` — it blocks new deals AND shoe close, `cove-blackjack.ts:1135-1142`,`:2181-2188`); then `POST /session/close` (reveals seed) → shoe `closed`. Verify via `GET /session/current` returns no open shoe.
- **Cash holdem:** call `leave`; if `202 queued` (mid-hand, `page.tsx:232-245`), POLL the public state until the seat is ABSENT and record `cashedOutCt`; assert the seat is gone and the wallet was credited the final stack. Never abandon a seated player (a stale seat keeps house games dealing, `cash-table-manager.ts:1119-1125`).
- **Practice holdem:** no server close exists (`cove-holdem.ts:1738-1746`); teardown = navigate away (the session is recoverable, `:1848-1869`); a new run's preflight resumes+finishes or ignores it.
- **BA-2 fixture:** `DELETE /test-fixture/run/:runId`.
- **Supervisor:** `preflight.ts` runs BEFORE every scenario — reconcile the dedicated identity: any open shoe → close; any seated cash table → leave+drain; any stale `active` fixture run → force-close. REFUSE to start if reconciliation cannot reach a clean state (surfaces the founder-session/contention case, M-6). `teardown.ts` runs in a per-scenario `finally` AND on `SIGINT`/`SIGTERM` (best-effort). Hard death is covered by the next run's preflight.

---

### Load-bearing citations (verified this session, this worktree HEAD b982ded3)
- 3D card mesh = merged BufferGeometry, no per-card DOM: `apps/web/src/lib/three/cove-table-cards.tsx:210-271,521-530,583-603` (Codex-confirmed).
- Peek cards rendered OUTSIDE TableCards3D + suppressed from merged mesh (B-2): `holdem-table-room.tsx:587-609,859-881,973-978,995-1010`.
- Muck fade set in layout effect, cleared in useFrame w/o re-render (B-3): `cove-table-cards.tsx:541-544,563-573,571`.
- Practice settlement loads REAL holeCards for all seats incl. folded (B-5): `holdem-controller.ts:200-218` (live placeholders) vs `:225-235` (`seatsForSettled` real cards); renderer forces backs `cove-table-cards.tsx:439-468`.
- Cash wire has NO showdown object (B-1): action resp `cove-cash-poker.ts:355-359`; public snapshot no hole cards `poker-table-types.ts:104-120`; agent view own-only `:166-174`; settle→advance→settle `cash-table-manager.ts:1002-1010`; showdown only in owner history `:1299-1325`,`cove-history.ts:314-354`; client ignores settled detail `cove/table/page.tsx:253-267`.
- Blackjack dealer hole withheld on wire; hidden placeholder fabricated client-side: `BlackjackModal.tsx:694` (upcard only), `:1338-1340` (fabricated hidden); settled reveals `cove-blackjack.ts:71-77`.
- Blackjack money legs: incremental double/split delta `cove-blackjack.ts:1098`; insurance debit `:1423-1493`; settle credit path `:1808-1819` (M-7).
- Baccarat commission integer floor (M-8): `baccarat-engine.ts:510-515`; coup response carries balance/outcome `cove-baccarat.ts:1056-1070`.
- Baccarat/blackjack `/session/open` accepts only currency; baccarat client seed server-generated (BA-2 rationale): `cove-blackjack.ts:367-371`, `cove-baccarat.ts:345-349,527-541`.
- Guest shoe cap 10/hour/fingerprint; cash-table creation limit (M-11, no 90s cooldown): `cove-blackjack.ts:175-194`, `cove-baccarat.ts:165-184`, `cove-cash-poker.ts:59-60,196-200`.
- BA-1 pot award truth loss (BLOCKER 3): `awardPots` returns full `SeatResult[]` `holdem-engine.ts:1638-1662`, but `poker-table-sim.ts:987-990` collapses to `PublicSidePot {amount,eligibleSeatIndices}` (drops winners/awards); lossy at `poker-table-types.ts:238`, unrecoverable at `cash-table-manager.ts:1254`.
- BA-1 settlement + net (MAJOR 3): `post = start - totalCommitted + won` `cash-table-manager.ts:1240`; `net = won - totalCommitted`, `holeCards` null if folded `poker-table-types.ts:221,224`.
- BA-1 entitlement (MAJOR 1): `holeCards = endedAt==='showdown' && status!=='folded' ? s.hole : null` — folded null for everyone, fold-win reveals nobody: `poker-table-sim.ts:967-977`.
- BA-2 cash seed path (BLOCKER 1): cash draws `this.seedFn()` + `DEFAULT_CLIENT_SEED` `cash-table-manager.ts:1138-1139`; practice seeds separately on `cove-holdem.ts`.
- BA-2 crash-loud gate model: `partner-signature.ts:81` (env named, throws at module load off staging, rechecks at use).
- Staging has its OWN Supabase DB (project ref `mtpixvtclsjqjguouxes`, 2026-06-16) — does NOT share prod (BA-2 risk correction).
- agent-browser 0.31.1 `--init-script` pre-nav hook (M-2): `AppData/Roaming/npm/.../references/commands.md:419-424`.
- **Blocker 6 (baccarat lifecycle fork) was ALREADY-RESOLVED before this critique's run:** my §A.6 "intermediate-vs-final assertion rule" edit is the canonicalization; the remaining action (deleting the sibling restatement) is the orchestrator's instruction to the siblings, not a §A change.
- **Component paths verified `apps/web/src/components/cove/...` (NOT `.../game/...` as the critique cited):** `find apps/web/src -name BlackjackModal.tsx` → only `components/cove/blackjack/BlackjackModal.tsx`; `SeatedHoldemHud.tsx` → only `components/cove/holdem/`.
- Handover doc lives in MAIN repo: `C:\Users\itachi\documents\crypto\clawville\docs\cove-3d-holdem-handover-2026-07-21.md` (not this worktree — N-1).
