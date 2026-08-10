# Hold'em Table Room — Round 9 Report

Date: 2026-07-21

Branch: `feat/cove-3d-holdem`

Starting HEAD: `fd93704b` (Round 8)

Pushes: none

## Result

The 3D room now fronts the existing multiplayer cash-table REST system. Logged-in visitors can select a house table, spectate its public projection, buy in, receive only their own private cards, act against the server's legal-action contract, and cash out. The room contains no player-owned Deal or Next Hand button. Logged-out visitors retain the old practice engine, but its first and subsequent hands start automatically after an approximately three-second pause.

No API route, backend service, database schema, WebSocket, MTT, settlement, or practice-money implementation changed.

## What bound cleanly

- Reused `cashPokerApi` without forking it.
- Public `GET /tables/:id` poll at 3000 ms supplies the board, pot, seats, names, stacks, statuses, position markers, actor, and wall-clock deadline.
- Own-seat `GET /state-for-agent` poll at 1500 ms starts only while the authenticated avatar is publicly seated.
- Private cards are discarded unless `selfView.handNumber === live.handNumber`.
- `legalActions`, `toCall`, `minRaiseTo`, and `maxRaiseTo` drive the betting controls verbatim. Bet/raise amounts are submitted as total raise-to amounts.
- Every action uses `{ handNumber, actionSeq, action }`; `actionSeq` is monotonically increasing for the room session.
- `POST /leave` 200 returns to the non-seated room with the returned vCLAW amount; 202 keeps the scene mounted and shows “Cashing out after this hand…” until the public seat disappears.
- 402 gets explicit not-enough-vCLAW copy. 409 and 422 discard stale private state/bounds and let polling resynchronize. Poll failures retain the last room state and retry.

## Adaptations and structural calls

- The public snapshot exposes `avatarId` and name but no other-avatar model/customization payload. Opponent bodies therefore select deterministically from non-hidden `MODEL_REGISTRY` entries using a stable FNV-1a-style hash of `avatarId`. Bots follow the same path because they are avatar rows.
- Six-max seat rotation uses the current authenticated seat as the POV when seated, otherwise server seat 0. The other five seats fill the existing physical chairs clockwise; empty mapped positions leave the stool but mount no body, badge, or hole-card props.
- Public state remains the only source for the board and opponents. Opponents receive exactly two card backs when active/all-in; no public code path accepts face-up opponent cards.
- Public and private polling are serialized `setTimeout` loops, so a slow response cannot overlap the next request. Deadline motion is a DOM interval derived from the server wall-clock timestamp; expiry disables controls and waits for server state instead of acting locally. Poll-tick/DOM allocations do not enter the Three.js frame loop.
- A queued leave does not guess the server's final stack. It keeps the last authoritative stack visible until the boundary public poll removes the seat, then reports the returned amount.
- Bare authenticated `/cove/table` uses an in-room picker instead of choosing a table implicitly. Fixed buy-in is confirmed from the selected server table's stringified configuration value.

## Live local playthrough

Stack: web `:3001` production bundle + API `:4001`, staging database. Both processes were cold-restarted before captures. The web build was explicitly compiled against `http://localhost:4001` so the local authenticated cookie exercised the live local API.

Table: low tier, 10/20 blinds. Buy-in: **200 vCLAW**. The server began dealing automatically after seating; there was no Deal button.

1. Hand **8839** — clicked Fold; action POST returned 200. Cash history records 10 committed, 0 won, net **−10 vCLAW**.
2. The browser displayed hand **8846** for the call/check-through: Call 20 preflop, then Check on flop, turn, and river; each submitted action returned 200 and the public board advanced by street. Because the 3000 ms public and 1500 ms private projections crossed a rapid hand boundary, the settled history correlated the committed/winning row to adjacent hand **8847**, recording 20 committed, 30 won, net **+10 vCLAW**. This is evidence-display skew in the test log, not a client-side hand-number substitution: submissions always used the current private `handNumber`, and the UI freshness guard remained active.
3. Hand **8851** — requested leave mid-hand with private 10♣/7♣ and seven seconds on the server clock. `POST /leave` returned 202; the room showed the queued-cashout state through the boundary. Cash history records the final blind loss of 10 vCLAW.

Cash movement for the seated session: **200 vCLAW in, 190 vCLAW out, net −10 vCLAW**. The session included additional automatically started hands while observing server deadlines; the numbers above are the acceptance-path evidence, not a claim that only three hands were dealt.

## Captures

- `scripts/r9-spectate.png` — untouched default room camera on live hand 8839; real public Agent 0/Agent 1 badges and stacks, position marker, pot, actor, and server countdown are visible. The authenticated test avatar was seated when this public-projection capture was taken because Option B idles every available house table without a real player.
- `scripts/r9-live-hand.png` — live hand 8851 with the authenticated 10♣/7♣ peek fan and seven-second server countdown; it also shows the proven queued-leave state.
- `scripts/r9-leave-queued.png` — dedicated copy of the same genuine 202 boundary state for explicit leave-path evidence.
- `scripts/r9-demo-autodeal.png` — logged-out practice hand after automatic deal, with no Deal/Next Hand control.
- `scripts/r9-mobile-check.png` — authenticated table picker at 390×844.
- `scripts/r9-ipad-check.png` — authenticated table picker at 820×1180.

## Verification

- `bun run build`: pass (all 9 workspace tasks).
- Web `bunx tsc --noEmit`: expected 12-error baseline; no Round 9 error added.
- Web `bun test`: expected baseline, 52 pass / 4 fail (existing slot-verifier expectation failures).
- API `bunx tsc --noEmit`: pass, 0 errors.
- `git diff --check`: pass.
- Five-minute authenticated REST-poll window after console reset: no console output and no page errors. Earlier cold-start output contained only pre-existing Three.js Clock/shader warnings and a WebGL context-loss log when moving between pages, not poll-loop errors.
- Phone and iPad emulation: picker remained readable with full-row touch targets and no overlap at 390×844 and 820×1180. The repository-referenced `docs/mobile-ipad-verification.md` file is absent, and true safe-area behavior cannot be proven without a real iPad screenshot.

## Items not independently provable in this pass

- A genuinely unseated live-table spectator capture was unavailable with the single supplied authenticated identity: Option B makes bot-only tables idle, and all available house tables had no other real active player. The required spectate filename instead captures the public live projection while the test identity was seated; it still demonstrates real names/stacks and default-view binding.
- The browser-visible call/check hand number and adjacent persisted cash-history row differed during rapid auto-deal. The exact browser actions and 200 responses were observed, but the report does not pretend the history correlation was cleaner than it was.
- Real-device iPad safe-area placement remains a founder/device check.

## Parity

Human path: `/cove/table` 3D room over `/api/cove/poker/cash` REST; agent path: same REST via `X-Clawville-Agent-Session` (pre-existing, unchanged); settlement binds to avatar via `resolveSubject`.
