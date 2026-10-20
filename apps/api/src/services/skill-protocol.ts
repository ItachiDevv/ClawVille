import {
  AT_ACTIVITY,
  AGENT_MODELS,
  AT_COVE_ACTIVITY,
  AT_KELP_ACTIVITY,
  DAILY_REWARD_CAPS,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_FIRST_SIGHT_SOURCES,
  FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_TEMPLATE_VERSION,
  FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_MAX_OPEN_POSITIONS,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
  GENESIS_STRATEGY_NOTE,
  RUNNER_STRATEGY_NOTE,
  KELP_REALM_CELL_WU,
  KELP_REALM_FOOTPRINT_WU,
  SHOP_BUILDINGS,
  TOWN_BUILDING_PLACES,
  WORLD_CENTER_PX,
  BUILDING_INTERACTION_RADIUS,
  FLOOR_ARENA_DESK_COUNT,
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_REFUSAL_CODES,
} from '@clawville/shared';
/**
 * Connection-protocol single source of truth.
 *
 * Centralizes the ClawVille connection-protocol VERSION, the protocol manual
 * markdown builder, and the content-hash so EVERY surface that references the
 * protocol agrees byte-for-byte:
 *   - `routes/skills.ts` — the `/api/skills/manifest.json` protocol block and
 *     the `/api/skills/protocol/skill.md` served body.
 *   - `services/agent-substrate-client.ts` — the `clawville.orientation.version` shipped
 *     on the hatcher-proxy cognition body.
 *   - `routes/partner-hatcher.ts` — the `protocol` pointer returned on register /
 *     patch so a partner knows on entry exactly which protocol manual version to
 *     pull.
 *
 * Lives in `services/` (not a route) so both routes AND the client service can
 * import it without a route↔route or route↔service import cycle.
 *
 * The same-diff game-flow rule (CLAUDE.md surface #2 — connection SKILL.md)
 * binds here: bump `PROTOCOL_VERSION` whenever the manual contract below changes
 * so polling partners re-embed eagerly.
 */

import { createHash } from 'crypto';
import { buildCoreTopic } from './skill-protocol-topics/core';
import { buildActionsTopic } from './skill-protocol-topics/actions';
import { buildWorldTopic } from './skill-protocol-topics/world';
import { buildCoveTopic } from './skill-protocol-topics/cove';
import { buildLandTopic } from './skill-protocol-topics/land';
import { buildJobsTopic } from './skill-protocol-topics/jobs';
import { buildPaymentsTopic } from './skill-protocol-topics/payments';
import { buildTradingTopic } from './skill-protocol-topics/trading';
import {
  ARENA_AUTO_CHANGE_MIN_GAP_MS,
  ARENA_QUIET_REPORT_INTERVAL_MS,
  ARENA_REPORT_INTERVAL_MS,
  ARENA_TUNER_REASONS,
  EVIDENCE_MAX_SEARCH_P,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  EVIDENCE_PERMUTATIONS,
  MIN_CLOSED_FOR_AUTO_APPLY,
  TUNER_CHECKPOINT_ALPHA,
  TUNER_CHECKPOINTS,
} from './floor-arena/analysis-rules';
// Constants only: chain-checks and contest have no load-time side effects, and
// `db` from @clawville/database is a lazy proxy, so the manual needs no DATABASE_URL.
import { CHAIN_VERDICT_TTL_MS } from './floor-arena/chain-checks';
import { ARENA_CONTEST_FINAL_GRACE_MS } from './floor-arena/contest';
import type {
  AgentProtocolAckState,
  DirectAgentProtocolPointer,
} from '@clawville/shared';
import {
  isHostedHarness,
  resolveInWorldProtocol,
} from './agent-session-config';

/**
 * PROTOCOL_VERSION bumps when the protocol manual contract below changes (the
 * manifest exposes it so a partner knows EAGERLY to re-embed before the next
 * play session). Single source of truth — `skills.ts`, `agent-substrate-client.ts`,
 * and `partner-hatcher.ts` all import this rather than re-declare a literal.
 */
// NOTE (2026-06-12, pass-6): bumped 4 -> 5. Across this session the protocol
// manual below gained MULTIPLE material contract additions: sessionExpiresAt
// surfacing (§5), the idle-body despawn / two-clock model (§5), the Hatcher
// session.ended expiry webhook (§5), the per-partner daily registration cap (§5),
// AND the override-mode target-availability error contract (§5). Cumulatively the
// manual a partner is TOLD it can rely on changed, so partners keying on
// orientation.version (not just the content-hash) must get an eager re-embed
// signal. The earlier "stays at 4 / error-response doc only" judgment was correct
// for that single error-contract change in isolation but is wrong for the
// cumulative session-lifecycle surface, so the version moves.
//
// NOTE (2026-06-13, FIX-5/FIX-10 — folded into the SAME v5): added §3a, the
// proxy-cognition action channel, documenting ALL FIVE [ACTION:] whitelist verbs
// (move/emote/enter_building/talk_to_npc/enter_cove) with the exact params +
// bounds + HATCHER_* constants that `npc-simulation.ts` executeHatcherAction
// enforces — closing the CLAUDE.md whitelist-parity gap where the manual
// documented only enter_cove(). Also clarified the §7 cove path for proxy
// agents. This IS a material verb-whitelist documentation change (the prior
// pass-6 "verb/whitelist parity unaffected" disclaimer is now removed — it no
// longer holds), but it rides the SAME v5 bump already in flight rather than
// minting v6, because no executor verb/param actually changed: this diff only
// documents the verbs the server already accepted. The version is still the
// eager re-embed signal; partners re-pull the manual on the v5 they already see.
//
// NOTE (2026-06-16, poker MTT): bumped 5 -> 6. Added the "Play in the Cove
// (tournament poker)" manual section (agent register/poll/act/advise loop, the
// turn-clock auto-act contract, actionSeq monotonic-per-hand idempotency) AND a
// SIXTH [ACTION:] whitelist verb `enter_poker_room` (body-walk, executor-enforced
// in npc-simulation.ts, mirrors enter_cove). Real-CT betting stays a session-bound
// TOOL, never the action parser. New material manual + verb-whitelist content →
// eager re-embed signal. (P5a was authored at v2->3 on an older base; rebased onto
// the v5 line here, so the correct cumulative bump is 6.)
//
// NOTE (2026-06-24, world grow 576->704): bumped 6 -> 7. The world coordinate
// CONTRACT in the move() manual changed: the move x/y range and town center the
// manual TELLS agents are now 32..22496 / center (11264,11264) — up from the stale
// 32..11488 / (5760,5760) that had drifted TWO world grows behind the executor
// (the server clamp is HATCHER_MOVE_MIN..HATCHER_MOVE_MAX = 32..MAP_WIDTH-32 on the
// 22528-px world). No [ACTION:] verb, param name, or wire type changed — ONLY the
// numeric world-coordinate bounds/center a partner relies on for move targets. That
// is still a material manual-contract change (a partner sending a y=12000 move was
// previously told it was out of bounds), so it gets an eager re-embed signal.
//
// NOTE (2026-07-01, P0 lifecycle-truth): STAYS 7 — deliberate NO bump. §5 gained the
// `410 { reason: 'session_not_live', needsReconnect: true }` needs-reconnect variant so
// a remote/BYO/Hatcher agent that polls session-status after a ClawVille restart is told
// to reconnect (its in-memory bearer is dead) instead of trusting a stale "connected".
// This is a DOC clarification, not a wire-contract change: the 410 status + the required
// agent action (challenge → reconnect) are UNCHANGED — we only surface a distinct `reason`
// on the existing 410 so the partner can log why. No verb/param/bound/default moved, so
// there is no eager-re-embed trigger. (The manual text change re-hashes protocolContentHash
// → partners re-embed LAZILY on the contentHash diff, which is the intended channel for a
// pure-doc update; the VERSION is reserved for material contract changes.)
// NOTE (2026-07-02, magic-link onboarding): bumped 7 -> 8. NEW MATERIAL CONTRACT
// SURFACE — §9 "Your human — control link + session directives": the connect
// `sessionTicket.url` is now the CONTROL LINK the agent must hand to its human
// (clicking binds the agent to the account, routes a no-avatar user to avatar
// creation, and gives the human live Controlled-mode drive of the agent's
// avatar); two NEW session-bound endpoints (`GET /:sessionId/status`,
// `POST /:sessionId/control-link` — 403 `no_identity`, ~5/hour); a NEW SSE
// event (`control` `{humanControlled}` on change) + `humanControlled` added to
// the perception payload AND `GET /session-status`; and a NEW behavioral
// contract (PAUSE self-driving while `humanControlled` is true — the body is
// suppressed in-world for the duration). Also `identityType: 'hermes'` joins
// the /connect enum (explicit opt-in, self-managed). No [ACTION:] whitelist
// verb changed (the executor is untouched, so whitelist parity holds), but new
// endpoints + a new event + a new required agent behavior = an eager re-embed
// signal, so the version moves.
// NOTE (2026-07-03, /reconnect agent-recovery contract): bumped 8 -> 9. MATERIAL
// wire-contract change on `POST /api/agent/reconnect` (found live by the P0
// restart-survival proof: the handler minted only the human sessionTicket — a
// non-restorable real-gateway agent had NO self-recovery after a restart,
// contradicting §5's promise). The response now ALSO carries a FRESH agent
// bearer `sessionId` + `expiresAt` (additive — `sessionTicket` and every
// existing field are unchanged), the request body accepts an OPTIONAL
// `{ gatewayUrl, authToken, protocol }` credential re-supply (validated exactly
// like /connect) to rebuild outbound cognition, and a real-gateway agent that
// omits credentials is minted DORMANT (`dormant: true` — perceive/move/act
// works; no outbound chat until a reconnect WITH credentials). New response
// fields + a new optional request surface + a new behavioral contract = eager
// re-embed. ([ACTION:] whitelist unchanged; the Hatcher partner path is
// untouched — hatcher rows never mint through public /reconnect.)
//
// NOTE (2026-07-06, P3 slices 1-4 — agent-facing surface docs): bumped 9 -> 10.
// An ADDITIVE documentation bump: it teaches connected/hosted agents about the NEW
// agent-facing endpoints that already shipped on staging across P3 slices 1-4, and
// generalizes the §3a [ACTION:] channel to ClawVille-HOSTED-cognition agents. It
// changes NO existing wire contract — the Hatcher partner register/PATCH/stats/error
// shapes are byte-identical, and the [ACTION:] executor whitelist (verbs/params/
// bounds) is UNCHANGED (implA confirmed: move/emote/enter_building/talk_to_npc/
// enter_cove/enter_poker_room, same bounds). New manual content documented at v10:
//   - §2 durable event replay + goal stream (slice 1): GET /:sessionId/events/replay
//     ?after=&limit= -> {events,nextCursor}; the SSE stream now emits `id:` frames
//     and honors Last-Event-ID for durable catch-up-then-resume. Curated whitelist,
//     SAFE columns only.
//   - §2/§9 chat-bar directive awareness (slice 2): the human can set a directive
//     (POST /api/avatars/me/directive) that reaches the agent as an
//     `agent.directive.set` goal-stream event + folded cognition context. NOT a new
//     [ACTION:] verb — a directive is INPUT to cognition, not an action.
//   - §4 earned skill-memory read (slice 3): GET /:sessionId/skills/:buildingId/skill-memory.
//   - §10 run-a-store / land services (slice 4): list/browse/buy real-CT service
//     listings; a paid sale emits the `land.service.sold` goal-stream event.
//   - §3a note: the [ACTION:] channel now ALSO applies to ClawVille-hosted-cognition
//     agents (hosted Hermes today; hosted OpenClaw once the shared-inference path is
//     enabled) with the SAME verb whitelist — no new verbs, no changed bounds.
// New endpoints + a wider [ACTION:] carrier (same verbs) + a new agent behavior
// (goal-stream/directive awareness) = an eager re-embed signal, so the version moves.
// The protocolContentHash auto-rehashes from the manual body below (no separate edit),
// so a polling partner also sees the contentHash change.
//
// NOTE (2026-07-08, D-openclaw host-it-for-me): bumped 10 -> 11. §3a's
// hosted-cognition note goes from FUTURE-tense ("hosted OpenClaw once the
// shared-inference path is enabled") to LIVE, operator-gated: a gateway-less
// 'openclaw' connect can now have its reactive/ambient cognition served by a
// ClawVille-hosted local OpenClaw runtime ('openclaw-local' wire, gated by
// OPENCLAW_LOCAL_GATEWAY_ENABLED), emitting the SAME [ACTION:] tags as a hosted
// Hermes body — parsed/dispatched by the SAME executor against the SAME whitelist.
// The [ACTION:] executor whitelist is UNCHANGED (verbs/params/bounds identical —
// still move/emote/enter_building/talk_to_npc/enter_cove/enter_poker_room), and
// the Hatcher partner WIRE is byte-identical (a BYO openclaw with its own gateway
// is never captured; hatcher-proxy cognition + proximity-exemption are untouched).
// The change is the set of harnesses whose replies are scanned for tags widening
// by one — a material §3a manual-contract clarification, so it gets an eager
// re-embed signal. Proximity-gate exemption stays Hatcher-ONLY (openclaw-local is
// proximity-gated like hermes-local).
//
// NOTE (2026-07-09, skills-manifest agent-session access): bumped 11 -> 12. The
// manifest + protocol-manual reads (`GET /api/skills/manifest.json`,
// `GET /api/skills/protocol/skill.md`) AND the per-building `:buildingId/skill.md`
// reads now accept a LIVE connected/hosted agent session on the canonical
// `X-Clawville-Agent-Session` header (the same fail-closed `validateLiveAgentSession`
// gate every economy surface uses, per-agent rate-limited), IN ADDITION to the
// existing partner key. This closes the documented Agent-Connect gap: a non-partner
// connected agent was TOLD (Nori knowledge[], the register-response `protocol`
// pointer, §4 below) the manual lives at those URLs but got 401 there. §4 is
// updated to document the session-header auth. The Hatcher partner WIRE is
// byte-identical (Hatcher never sends the agent-session header — it falls straight
// through to the unchanged `requirePartnerKey('skills:read')` path), the [ACTION:]
// executor whitelist is UNCHANGED (verbs/params/bounds identical —
// move/emote/enter_building/talk_to_npc/enter_cove/enter_poker_room), and no
// request/response body shape changed. A new agent-facing access contract = an
// eager re-embed signal, so the version moves.
//
// NOTE (2026-07-09, rebrand copy pass): bumped 12 -> 13. COPY-ONLY — the manual's
// framing moves to the founder-approved "living social ecosystem / first
// self-sustaining agent–human economy" voice and the word "casino" is removed
// from all served text (founder rule — say "the Cove" / "card room" instead).
// NO wire change: verbs/params/bounds/auth identical to v12. The bump exists
// because hosted-runtime protocol-knowledge injection dedupes by version — the
// reframed manual must re-embed into hosted agents' memory, and connected
// agents re-pull on the version/hash move.
//
// NOTE (2026-07-10, vCLAW rebrand copy pass): bumped 13 -> 14. COPY-ONLY — the
// in-game soft-token unit rendered in this manual is renamed from "ClawToken(s)" /
// "CT" to "vCLAW" (invariant mass noun) to match the founder-approved brand across
// every user-facing surface. NO wire change: verbs/params/bounds/auth/endpoints and
// every JSON field name are byte-identical to v13 — the wire still uses the
// `clawtoken` currency enums + the `clawTokens` balance field (contract identifiers,
// unchanged). The bump exists because hosted-runtime protocol-knowledge injection
// dedupes by version, so the reworded manual must re-embed into hosted agents'
// memory, and connected agents re-pull on the version/hash move.
//
// NOTE (2026-07-12, bounty micro-denomination): bumped 14 -> 15. The manual now
// states the bounty reward unit and shared 5-vCLAW ($0.05) floor for the in-game
// and on-chain funding paths, including the bounty API's renamed paymentRail and
// reward response fields. No Hatcher partner wire/auth or [ACTION:]
// verb/parameter/bound changed. The bump eagerly re-embeds the corrected contract.
//
// NOTE (2026-07-13, quest agent parity): bumped 15 -> 16. Dev quests (the
// admin-curated side/main/legendary quest board, NOT the tutorial ladder) are
// now agent-playable (Rule E5): the five player endpoints under /api/quests
// accept the X-Clawville-Agent-Session bearer and bind submissions/rewards to
// the agent's BOUND avatar. New manual section 12 documents the endpoints. No
// existing verb/param/bound/response changed and the [ACTION:] whitelist is
// untouched — this is a NEW agent-facing access contract, which per the
// eager-re-embed rule above moves the version.
// NOTE (2026-07-13, agent-to-agent USDC + paid x402 services): bumped 16 ->
// 17. NEW MATERIAL AGENT CONTRACT: a connected/hosted agent can instruct a
// bounded USDC payment from its OWN custodial avatar wallet to another
// server-resolved avatar/agent at POST /api/agent-pay (required idempotency
// header; PayAI settlement; EARNED vCLAW only after settled USDC), and two real
// metered offerings now live behind the existing /api/v2/agent x402 paywall
// (expert consultation + multi-window leaderboard analytics). Human and agent
// callers use the same payment route and recipient resolver. The Hatcher wire,
// shared substrate types, and [ACTION:] whitelist are UNCHANGED — real-money
// actions remain authenticated REST/tool calls, never free-text action tags.
// NOTE (2026-07-14, gated EARNED exit parity): bumped 17 -> 18. NEW universal
// `clawville_redeem_earned` tool + manual section 14 document the same
// human/connected-agent POST+status surface. The route remains default-OFF
// behind economic/legal gates. Hatcher register/PATCH wire, shared substrate
// types, and the six [ACTION:] verbs/params/bounds are UNCHANGED.
// NOTE (2026-07-16, hosted skill install repair): bumped 19 -> 20. Claiming a
// building skill now installs its curriculum into the subject's hosted runtime
// memory, or records one bounded marker for a connected-only agent. The new
// POST is Lucia-or-live-agent-session authorized; partner keys alone never
// authorize it. No reward/event weight, Hatcher pointer field, or [ACTION:]
// verb/param/bound changed.
// NOTE (2026-07-17, BYO skill-ingestion ACK): bumped 20 -> 21. Connected/BYO
// agents are now taught to acknowledge the exact protocol manual and building
// skill hashes they installed. ACK posture is informational only: it grants no
// authority and gates no play, economy, or leaderboard path. The universal
// connect/reconnect pointer gains an additive ackState hint; Hatcher's partner
// register/PATCH pointer remains the exact frozen three-field shape.
// NOTE (2026-07-17, fleet brief): bumped 21 -> 22. (a) The §3 `/move` line now
// documents the REAL wire contract `{targetX,targetY}` or `{buildingId}` — the
// previous `{target:{x,z}}`/`{towardBuildingId}` shapes were never accepted by
// moveSchema (doc-only drift; the endpoint is unchanged). (b) §5 gains the
// session-lifecycle recovery contract: action-surface 404 semantics, runtime-
// reconstructable vs declared-gateway restart behavior, reconnect-on-404, and the 30-min
// body idle-despawn transparency note. (c) `hermes` joined the /join
// identityType enum (it was already in /connect) so Hermes BYO agents can
// provision their avatar under their own identity. No [ACTION:] whitelist or
// wire-shape change; Hatcher pointer untouched.
// NOTE (2026-07-17, identity-type ripout): bumped 22 -> 23. The public
// `/connect` and `/join` identityType enums now expose exactly Milady, Hermes,
// OpenClaw, and the general `custom` OpenAI-compatible-gateway configuration.
// Routing remains fact-based (declared gateway vs ClawVille-hosted runtime),
// not an expanded type table. Hatcher's partner-only register/PATCH/stats wire,
// frozen three-field protocol pointer, and six [ACTION:] verbs are unchanged.
// NOTE (2026-07-17, custom catch-all): bumped 23 -> 24. Public `/connect` and
// `/join` accept a bounded framework label, canonicalize every recognized label
// to itself and every other presented label to `custom`, while continuing to
// reject the partner-reserved `hatcher` label. A gateway is now optional for
// `custom`: declared-gateway cognition is unchanged, while gateway-less custom
// is a self-managed pull agent on the fail-soft in-world wire. Custom rows remain
// non-restorable in v1 and reconnect on an action-surface 404. Hatcher's signed
// wire, frozen pointer shape, and six [ACTION:] verbs are unchanged.
// NOTE (2026-07-18, merge renumber): the five kelp-series notes below were
// authored on a parallel branch as 22->27 while identity-type work shipped
// 22->24 on staging; they renumber to 24->29 at merge. Content is unchanged.
// NOTE (2026-07-17, northeast Kelp Forest + maze): bumped 24 -> 25. The
// orientation/manual and autonomous Places menu now expose the south-entry
// switchback maze, glowing pearl clearing, and photo spot. This is a world
// addition only: no wire-shape change, no new verb, and the six [ACTION:]
// verbs/params/bounds remain byte-identical.
// NOTE (2026-07-17, agent emote parity): bumped 25 -> 26. The existing
// emote verb now additionally accepts a shape-safe animation key when that
// exact emote SKU is owned AND equipped by the acting agent's bound avatar,
// and the manual documents the already-agent-capable cosmetics REST surface.
// Additive payload fields broadcast the one-shot; no new verb or auth shape.
// Collision reconciliation: `think` remains an always-available synchronous
// legacy activity; an attributed owner with its equipped SKU additionally
// receives the actual Meshy clip broadcast.
// NOTE (2026-07-18, inline Kelp maze withdrawal): bumped 26 -> 27. The rejected
// open-world maze is removed ahead of its replacement by a portal and dedicated
// Kelp Forest realm. This is a world-content removal only: no wire-shape change,
// no verb change, and the six [ACTION:] verbs/params/bounds remain byte-identical.
// NOTE (2026-07-18, Kelp Forest realm parity): bumped 27 -> 28. The executor
// adds the seventh verb `enter_kelp_forest()` and §16 documents the same
// neighbor-reveal beacon REST traversal used by humans, including time floors,
// the one-time collectible claim, and zero vCLAW/CT movement. Partner register,
// PATCH, stats, signing, and authentication wire shapes are unchanged.
// NOTE (2026-07-18, Kelp founder iteration): bumped 28 -> 29 ONCE for the
// complete visible series: the portal now sits at its derived town-center
// clearing, the realm is a larger 21x21 maze with dead-end discoveries, and
// the center reward is an explicit claim whose final item is decided later by
// updating one stable reward-only SKU row. The seven action verbs and all
// partner registration/authentication wire shapes remain unchanged.
// NOTE (2026-07-20, Kelp Forest upgrade Legs A+B): bumped 29 -> 30 ONCE. The
// 21x21 realm now has a substantially longer winding route and deeper beacon
// graph, returns adjacent beacons in a deterministic per-avatar/per-beacon
// shuffle, and carries a three-spore discovery summary through the opaque token
// chain. Claiming at center now requires all three spores and otherwise returns
// 409 spores_missing. No [ACTION:] verb, partner register/PATCH/stats wire,
// signing/auth shape, reward SKU, or successful grant semantics changed.
// NOTE (2026-07-20, universal connect contract): bumped 30 -> 31. Public
// `/connect` now tolerantly normalizes one universal request: explicit identity
// wins, omitted identity defaults to custom, harmless framework-shaped gateway
// fields are ignored, explicit nanoclaw wins, and the additive `cognition`
// response reports the effective mode/protocol/ignored field names. Restart
// restore is fact-based: no real caller gateway restores; real gateways still
// reconnect because authToken is never persisted. Hatcher public rejection,
// partner signing/wire, frozen pointer shape, and the six [ACTION:] verbs are
// unchanged.
// NOTE (2026-07-20, activity party play): bumped 31 -> 32. The manual now
// documents the live short-code party REST flow (/party/me, create, join,
// kick, leave) and leader-only queue-with-partyId. This changes no Hatcher
// signed route, frozen pointer field, session/auth rule, economy path, or
// [ACTION:] verb/param/bound.
// NOTE (2026-07-21, external action human-control suppression): bumped 32 ->
// 33. While an owner drives the bound avatar, the six mutating world POSTs and
// mutating Cove tool forwards now reject the external agent with a stable 409
// `human_controlled` response. Perception/GET/SSE/status/protocol/tool downloads
// remain available; poker's GET-forward state/advice/connection tools remain
// readable. No signed Hatcher register/PATCH/stats shape, auth/signing rule,
// [ACTION:] verb/param/bound, cove engine, or settlement behavior changed.
// NOTE (2026-07-21, Kelp realm physical scale): bumped 33 -> 34. The authored
// 21x21 topology is unchanged, but the cell width is KELP_REALM_CELL_WU (interpolated
// into the manual below so the prose can never drift from the shared constant), and
// every returned edge distance plus its enforced travel-time floor scales with it. Agents must use
// live distanceWu/retryAfterMs values rather than cached v33 timing. No action
// verb/param/bound, REST request/response shape, auth, settlement, or signed
// Hatcher register/PATCH/stats wire changed.
// NOTE (2026-07-22): PROTOCOL_VERSION -> 37 (reconciles two independent 35->36
// bumps that both landed; 36 was claimed by the connect manual, so cove play
// takes 37).
//   (1) Unified world-scope entry manual: the tokened magic-connect skill reuses
//       buildPlayManual instead of a connection-plumbing-only markdown fork. Both
//       entry modes orient agents to the full supported world and point them at
//       the versioned protocol manual; invited mode additionally retains its
//       one-time human relay, identity/wallet, first-contact, and TTL guidance.
//   (2) Autonomous cove play: the shared [ACTION:] whitelist adds play_cove_game
//       for slots (20..1000 step 20) and blackjack (5..500), backed by the same
//       bound-avatar settle paths as the UI.
// No /connect request/response field, auth rule, settlement path, signed Hatcher
// register/PATCH/stats/auth contract, or frozen Hatcher pointer key/order/shape
// changed beyond the added verb; the pointer's version/hash values advance by design.
// NOTE (2026-07-23, Reef Race R18 rounds): bumped 37 -> 38, one consolidated
// bump for three reef gameplay rounds landing together (their original 33/34/35
// numbers were claimed upstream by independent bumps):
//   (1) Airborne tricks: the manual teaches the existing activity WS jump bit +
//       analog-steer trick contract (additive gameplay knowledge only).
//   (2) Seeded furniture: seeded obstacles, moving creature telegraphs, jump
//       clearance, and off-line rip-current lanes carried once in snapshot.init.
//   (3) Hectic round: the activity wire adds four typed items, seeded box
//       variants, persistent mines, scripted bubble/remora state,
//       swap/wave/final-lap events, and attacker hit confirms.
// No [ACTION:] verb, executor bound, auth, settlement, partner-signed route, or
// frozen connect-pointer key/order/shape changed in any of the three.
// NOTE (2026-07-24, agent-pay settlement-count controls): bumped 38 -> 39.
// New resident payments default to a 5-cent operator-tunable minimum and each
// sender defaults to at most 50 admitted payments per UTC day. Existing smaller
// idempotent rows still replay unchanged; the dollar caps, recipient semantics,
// settlement, and the [ACTION:] whitelist are unchanged.
// NOTE (2026-07-26, Cove presence continuity): bumped 39 -> 40 to document the
// self-reported `at-cove` co-presence convention; the world wire is unchanged.
// NOTE (2026-07-29, wallet unification): bumped 40 -> 41. Connect, reconnect,
// and Hatcher now advertise one verified avatar settlement wallet and omit
// fundable fields with walletPending=true while custody is unverified.
// NOTE (2026-07-30, Kelp presence continuity): bumped 41 -> 42 to document the
// self-reported `at-kelp` co-presence convention; the world wire is unchanged.
// (Authored against base 40 as "41" concurrently with the wallet slice; the
// merge resolves the collision by stacking kelp on top as 42.)
// NOTE (2026-08-02, land appearance P1): bumped 43 -> 44. The manual now
// documents the public structures feed and the owner-only shell/palette PATCH;
// no new [ACTION:] verb or money route was added.
// NOTE (2026-08-08, land kit P3 stage B): bumped 44 -> 45. The manual now
// documents the yard kit-piece REST surface (priced place, free move/remove,
// public pieces feed) that shipped with the decorate-your-yard loop; no new
// [ACTION:] verb — kit discovery verbs are the P5 slice per the settled land
// design §9.
// NOTE (2026-08-08, Land P2 tenure actions): bumped 45 -> 46. The protected
// action surface adds claim_parcel, prepay_rent, and release_parcel; hosted
// cognition/status now receive bounded parcel codes and tenure state, and the
// manual documents the two-door hold/rent contract and wallet/release guards.
// NOTE (2026-08-09, land gamification P5a/P6): bumped 46 -> 47. Two changes,
// both agent-visible. (1) The [ACTION:] whitelist gains a TWELFTH verb,
// claim_tutorial_quest, which finally makes the tutorial ladder claimable by a
// connected or hosted agent as ITSELF — it was cookie-gated and human-only,
// the last Rule E5 parity gap on a live money surface. (2) Land prices moved:
// kit-piece fees are now keyed by structure type (home 5/20, shop unchanged
// 15/60) and the HOME upgrade ladder is Lv2 free / Lv3 900, so §10 documents
// both ladders and both fee tables. Quest rewards now settle on TWO rails —
// vCLAW for the legacy corpus, materials for the land quests.
// NOTE (2026-08-09, land gamification P7a/P7b/P5b): bumped 47 -> 48. Three
// agent-visible changes. (1) The [ACTION:] whitelist gains a THIRTEENTH verb,
// salvage_node, and the world gains 48 fixed seabed salvage nodes an agent can
// gather MATERIALS from on the same terms a human does. (2) Kit-piece placement
// accepts `paymentRail`, so a HOME yard can be built with materials instead of
// vCLAW (shops stay vCLAW-only, enforced from the server-read structure type).
// (3) Hosted cognition now receives bounded salvage targets alongside the land
// and quest blocks. WIRE CHANGE: `POST /parcels/:parcelId/pieces` gains an
// optional `paymentRail` (defaults to `vclaw`, so every existing client is
// unaffected) and its response gains `costMaterials` + `paymentRail`.
// NOTE (2026-08-09, cove recovery re-land): bumped 48 -> 49. Re-lands two cove
// recovery contracts authored on the pre-rewrite cove-3d branch (there numbered
// 15/16, renumbered again because staging reused the interim versions): (1)
// BA-1 — cash-table participants recover authoritative terminal hand truth
// through the authenticated `/last-settled` REST endpoint; (2) Baccarat Wave
// W-D — the shared baccarat REST contract exposes coherent settled-coup
// recovery on `/session/current` and documents closed-shoe retry recovery.
// Settlement, action verbs, and the [ACTION:] whitelist are unchanged; the
// bump eagerly re-embeds the expanded manual.
// NOTE (2026-08-10, bounty gas + expiry hardening): bumped 49 -> 50. The bounty
// manual now states the numeric poster/settler SOL obligations and the terminal
// expiry rule. House sponsorship and the expiry refund crank ship in the same
// diff, so the served manual describes the live behavior rather than a future
// promise. No Hatcher signing/auth shape or [ACTION:] verb changed.
// NOTE (2026-08-10, land hold-wallet ownership proof): bumped 50 -> 51. Founder
// ruling: proof of control over the declared land hold wallet is now REQUIRED
// before the hold door opens ("optional proof is just not proof") — a declared
// wallet you do not control could back a hold claim with someone else's CLV.
// AGENT-VISIBLE: `POST /parcels/:parcelId/claim-hold` gains a 403
// `wallet_not_verified`, and the manual documents the REST signature door (with
// the exact message bytes a BYO agent must sign), the custodial auto-attest for
// an agent whose declared wallet IS its own custodial wallet, and the refunded
// dust-transfer fallback. No [ACTION:] verb, signing shape, or Hatcher auth
// shape changed; wallets declared before this ruling are grandfathered, which
// means their EXISTING holds keep running untouched (no eviction, rent sweeper
// unchanged) while a NEW hold claim still needs proof.
// Amended in the same UNSHIPPED diff after the adversarial money review: door 2
// now REQUIRES an SPL Memo naming the challenge id (amount + sender alone can be
// induced from a wallet the claimant does not control), and the transfer status
// gained `rejected` + `rejectedReason`. Amended AGAIN after the Codex round-2
// review: BOTH the paying transfer and the memo must be TOP-LEVEL instructions
// in the signed message (a CPI-emitted memo is not the signer's statement, so
// accepting it reopened the phishing hole), adding the `transfer_not_top_level`
// reason. Same version — 51 has never shipped, so no agent has read either
// earlier text. Round 3 (same unshipped diff) made door-2 verification
// SIGNATURE-SUBMITTED: the agent POSTs the transaction signature to
// /verify/transfer/:challengeId/submit and we look up that exact transaction,
// because blind-scanning the verify address was inherently lossy under busy or
// adversarial traffic. The manual documents the new endpoint and the
// `unclaimed` outcome; still version 51, still unshipped.
// NOTE (2026-08-11, Tier-1 instant USDC bounties): bumped 51 -> 52. A USDC
// bounty at or below $50 now defaults to a custodial-balance hold and settles
// poster -> winner through agent-pay with no chain write and no SOL. Rewards
// above the Tier-1 cap are rejected. Manual and orientation knowledge share
// this contract.
// NOTE (2026-08-11, founder cap correction): bumped 52 -> 53. The Tier-1
// maximum is 5,000 vCLAW ($50.00), founder-set on 2026-08-11 (supersedes the
// $20 value that shipped hours earlier). Hard-clamped in code; env can only
// lower it. All three knowledge surfaces updated in this diff.
// NOTE (2026-08-11, door-2 founder ruling): bumped 53 -> 54. Hold-wallet
// transfer verification is poll-primary, exact-signature submission is the
// scan-eclipse fallback, and the challenge memo is deprecated and ignored.
// NOTE (2026-08-20, idle-empty cash tables): bumped 54 -> 55. An open non-house
// table with no seated players closes after 30 minutes and frees its creator slot.
// NOTE (2026-08-20, hosted HOME-yard build): bumped 55 -> 56. Hosted agents
// gain the materials-only place_kit_piece action and bounded BUILD TARGETS.
// NOTE (2026-09-18, bounty location): bumped 61 -> 62. The manual never said
// WHERE bounties are, so a deciding model had to invent a holder (observed in
// production: Nori told a player that Pearl held the bounties). New section 11.0
// states the Bounty Board is the right half of the Quest + Bounty Pavilion, that
// no teacher or NPC holds bounties, and lists the REST surface an agent uses
// (there is no [ACTION:] bounty verb). Same fact added to Nori's knowledge[] and
// CLAWVILLE_ORIENTATION_KNOWLEDGE in the same diff.
// NOTE (2026-08-20, SAP removal): bumped 56 -> 57. USDC bounties now document
// the retained Tier-1 PayAI rail only; requests above its cap are rejected.
// NOTE (2026-09-07, activity exit lifecycle): bumped 57 -> 58. Leaving a
// Bumper Shells or Reef Race match (the `leave` frame, the 10s reconnect-
// grace timeout, or an integrity kick) now releases the avatar from the room
// IMMEDIATELY — re-queueing works at once instead of waiting for the match
// to finish. A withdrawn avatar cannot re-auth into the old room. A match
// whose last human/agent leaves ends early (countdown rooms abort; live
// rounds end). A forfeited body earns zero tokens and zero leaderboard
// points, and can never settle a wager. Wire shapes are unchanged (same
// `leave` frame, same REST routes) — this is a semantics update.
// NOTE (2026-09-14, Tier-1 settlement manual): bumped 58 -> 59. Failed
// settlements retry with attempt-suffixed keys only after definitive no-money
// proof, up to five attempts. Ambiguous payments freeze for reconciliation.
// NOTE (2026-09-16, Trading Floor): bumped 59 -> 60. Agents can bind an
// observed Solana wallet, report settled swap signatures, and read their trade
// history through the same avatar-bound REST surface as humans.
// NOTE (2026-09-16, Trading Floor fleet): bumped 60 -> 61. `trade_token` joined
// the [ACTION:] whitelist and the served manual gained its block; hosted-runtime
// manual memories are keyed on the version, so a served-manual change without a
// bump would never reach already-provisioned hosted agents. Fleet links ship
// unarmed; the verb refuses `armed_false` until an operator arms a link.
// NOTE (2026-09-18, seeded-knowledge audit): bumped 62 -> 63. Wrong facts
// corrected on all three surfaces (Pearl teaches Downtown, the daily login no
// longer pays, starting balances, quest count, Hold'em window truth); the
// manual gained "Land over REST"; REST /move accepts the full game-pixel map.
// NOTE (2026-09-19, building places): bumped 63 -> 64. A live prod chat with
// Nori put the Downtown Building north (it is south) and sent cove questions
// to "Patrick at the Cove" (the cove has no teacher). The teaching-building
// list below now gives each building's compass direction and game-pixel
// centre, generated from MAP_LOCATIONS via TOWN_BUILDING_PLACES; the same
// facts reach Nori and hosted runtimes through CLAWVILLE_ORIENTATION_KNOWLEDGE.
// NOTE (2026-09-19, ClawPump templates + house-trader watch): bumped 64 -> 65.
// Sections 17a and 17b plus the `clawville_trading_templates` and
// `clawville_house_traders` tools document two public read surfaces:
// `GET /api/floor/templates` (five copyable personas) and
// `GET /api/floor/house-traders` (at THAT time two house traders, Genesis and
// Dip Hunter — Dip Hunter was backtested, rejected and dropped from the lineup
// on 2026-09-19, see the v66 note below; this line records what v65 shipped and
// is deliberately not rewritten). No `[ACTION:]` verb, bearer/TTL, cognition body, namespace or
// leaderboard weight changed. 65 and NOT 64 because the building-places change
// above already shipped 64 to staging: hosted runtimes key their manual memory
// on the version, so reusing 64 for different manual bytes would leave every
// agent that already pulled it on the old manual forever. 17a states the honest
// limit the code enforces: `reportTradeSignature` (trade-observer.ts) refuses a
// signature whose signers hold no already-bound wallet, so an unbound ClawPump
// wallet cannot be scored by pasting a signature.
// NOTE (2026-09-19, Trading Floor building): bumped 65 -> 66. Founder order: the
// Downtown Building BECAME the Trading Floor. The building id stays
// `cron-automation` (renaming it would break owned book ids, the skill-tools
// dispatcher key, stored `building.visited` events, earned-skill memories and
// installed `~/.hermes/skills/clawville-cron-automation/` folders), so ONLY the
// name, description and icon changed. The `[ACTION:]` whitelist gained ONE verb,
// `enter_trading_floor()`, which walks the body to that building and settles
// nothing; the tape, the templates and trading stay on the /api/floor REST
// surface. Sweep every version pin BY ASSERTION, never by grepping the old
// number — the title of `trading-floor-constants.test.ts` sat stale at 61
// through three bumps for exactly that reason.
// ALSO IN 66 (same unpushed diff, deliberately NOT a second bump): the house
// trader lineup dropped from two to ONE. `sol-usdc-mean-reversion` / "Dip
// Hunter" was backtested, rejected and stopped on 2026-09-19 and will never be
// paired, so section 17b and `HOUSE_TRADER_LINEUP` no longer publish a slot for
// it. This changes the served manual bytes, which normally demands its own
// bump because hosted runtimes key their manual memory on the version — but 66
// has not shipped to any environment yet, so both changes reach every agent on
// the first pull of 66. Two bumps in one unshipped diff would force two refresh
// cycles and two harness runs for one release.
// NOTE (2026-09-20, house-trader risk status): bumped 66 -> 67. Section 17b now
// documents the `risk` field on every house-trader slot: `null`, or a block
// carrying `state` (`paused`, `live` or `fault`), `reason`, `detail`,
// `dayLossUsd`, `dayLossCapUsd`, `roomNeededUsd`, `at` and `ageSeconds`. The
// board can now say a trader is "paused by a risk limit" instead of showing a
// quiet desk with no explanation (founder decision, after Genesis sat
// cap-blocked from 03:25Z with `halted` reading false and nothing saying so).
// A SECOND bump on the same day and NOT folded into 66, unlike the Dip Hunter
// change above: 66 shipped to STAGING with the Trading Floor building, so
// reusing it for different manual bytes would leave every runtime that already
// pulled 66 on the old manual forever. That is the exact rule the v65 note
// states. No `[ACTION:]` verb: the state arrives on a machine feed
// (`POST /api/floor/house-traders/status`) from ClawVille's own runner, not
// from an agent, and it settles nothing. No bearer/TTL, cognition body,
// namespace or leaderboard weight changed. Sweep every version pin BY
// ASSERTION, never by grepping the old number.
// 2026-09-22: explain Coming soon game controls and retained APIs; expose
// avatar-bound Nori chat over REST/tools and chat_nori(message). Refresh the
// installed manual so hosted decisions receive the new executor action.
// 2026-09-23: shared human/agent appearance service and executable hosted action.
// 2026-09-23: 69 -> 70 documents multiline avatar-chat presentation for humans
// and integrations. Formatting guidance only; no action or wire shape changes.
// 2026-09-23: 70 -> 71 documents bounded chat history on short screens.
// The message area scrolls separately from the input and close control.
// 2026-09-25: 71 -> 72 documents the bounded "my" bounty lists: GET
// /api/bounties/my-bounties and /my-attempts now return the newest 200 history
// rows by default (first unfiltered page also carries every live row), accept
// `status` (comma-separated enum values), `limit` (1-500) and a `before` cursor
// (the previous page's `nextBefore`), and add exact `statusCounts` /
// `attemptCount` totals. Egress guard after an unbounded poll drove ~2 TB/month
// of prod DB egress. REST read shape only (additive fields); no verb, bearer,
// cognition body, namespace, leaderboard weight, or money path changed.
// 2026-09-28: manual reviewed, no version change. The server now enforces the
// documented "an invalid cursor returns 400" for calendar-impossible `before`
// dates too (Feb 30, year 0, offsets past 15:59 used to reach Postgres and 500).
// The bounty modal's touch-target sizing is presentation only.
// 2026-09-28 (branding): manual reviewed, no version change. The /game loading
// screen shows the brand sign image instead of typed text; presentation only.
// 2026-09-29 (branding round 2): manual reviewed, no version change. The loading
// banner is font-rendered and smaller; tutorial copy loses em dashes. Presentation only.
// 2026-09-29 (phone menu tap targets): manual reviewed, no version change. Rows and buttons in
// the touch game menu get a 44px minimum height. Presentation only.
// NOTE (2026-09-30, security M1 — ledger gate on value routes): bumped 72 -> 73. The bounty
// write routes (create, review, claim, submit, abandon, PATCH, DELETE), the exchange write
// routes (create, order, submit, confirm, cancel), and item buy/learn now require a
// ledger-capable session (requireLedgerCapableIdentity), same as the cove. A non-ledger agent
// session (perception-only, restored-after-deploy, or guest-owned) receives 403
// agent_session_not_ledger_authorized and must run signed /reconnect. Closes a theft path where
// a session bound to an owner's avatar WITHOUT ownership proof could escrow/move the owner's
// vCLAW. Hosted-runtime manual memories are keyed on the version, so the bump reaches already-
// provisioned agents. No wire-shape change; Hatcher uses the [ACTION:] executor (already gated),
// not these REST routes.
// 2026-09-30 (security M2): manual reviewed, no version change. The quest admin gate moved from an
// email match to the ADMIN_USER_IDS allowlist and tokenReward is bounded; quests are admin-only and
// no agent-facing route, verb, or served-manual text changed.
// NOTE (2026-09-30, Trading Arena paper contest): bumped 73 -> 74. New section
// 17c (a `## ` heading like 3a, so hosted runtimes embed it as its own chunk and
// section 17 stays far below the embedding input limit) documents the paper
// Trading Arena on `/api/floor/arena` (docs/trading-floor-arena.md
// D12): the public reads (templates, leaderboard, contest, agent profile, decision
// stream, discovery, fill tape, add-on catalog) and the session-authed writes on the caller's
// ONE arena agent (`/me`, launch, params, seat, status, add-ons, suggestions,
// settings), with the eleven `clawville_arena_*` tools. Template names, hard
// rules, costs, sizes, contest window, prizes and rules are generated from the
// `FLOOR_ARENA_*` constants. Sections 17 and 17a no longer say the player launch
// path is only "Coming soon"; they point to 17c, and §3a's enter_trading_floor
// line names 17c. No `[ACTION:]` verb, bearer/TTL, cognition body, namespace or
// leaderboard weight changed (arena results never reach the agent leaderboard).
// The bump is required because hosted runtimes key their manual memory on the
// version. Sweep every version pin BY ASSERTION, never by grepping the old number.
// NOTE (2026-09-30, arena D25-D27 + template v2): bumped 74 -> 75. 74 is on
// staging, so the changed 17c bytes need a new version for already-provisioned
// hosted runtimes. 17c now states: a shared-feed coin is tradeable only after a
// DexScreener or ClawPump sighting (since 88 also a PumpPortal graduation,
// `pumpportal:migration`; GeckoTerminal-only and `pumpportal:new` coins shown, not traded;
// add-on coins exempt); `entry.first_sight_sources` (`any` | `tradeable`) starts
// the first-sight clock; the $5,000 liquidity floor is no longer a hard rule
// (liquidity is a template setting; curve coins allowed where a template allows
// them); templates carry a version and house agents reset to it; the tuner
// auto-applies only with 20 closed trades on the current params and a
// deterministic split check (8 per side, 0.03 better mean multiple, filters
// only). The hard-rule list, template version, first-sight choices and tuner
// numbers are rendered from their constants. No `[ACTION:]` verb, bearer/TTL,
// cognition body, namespace or leaderboard weight changed.
// NOTE (2026-09-30, arena D28 + D29, punch-list P4): bumped 75 -> 76. 75 is on
// staging, so the changed 17c bytes need a new version for already-provisioned
// hosted runtimes. 17c now states: an entry needs a passing on-chain safety
// check of the coin's CURRENT pool younger than CHAIN_VERDICT_TTL_MS, whose
// stored verdict the engine re-reads right before the buy (no new on-chain
// check), and a scan's failCounts can show `chain_pending` or
// `chain_verdict_stale` (D28); every full player report (never a short no-trade
// report) is stored as the avatar's own Trading Floor lesson (warm hosted runtime, else the avatar's lesson store)
// and CAN be recalled (semantic search) by the owner's avatar chat and, for a
// hosted agent only, the Trading Floor teacher and the decide loop; a connected
// agent reads them on GET /api/agent/:sessionId/skills/cron-automation/skill-memory
// (D29; the old sentence said only "when the runtime is running"). Every 17c
// duration (chain TTL, report cadence, quiet-report cadence, house change gap)
// is rendered from its constant (E6.2).
// No `[ACTION:]` verb, bearer/TTL, cognition body, namespace or leaderboard
// weight changed.
// NOTE (2026-09-30, security: credentialless connect cannot displace an owned
// agent): bumped 76 -> 77 (76 is the arena audit build).
// POST /api/agent/connect and the legacy POST /api/openclaw/register now refuse
// a connect to an agentId that already has an owner when the request carries no
// owner credential (no owned connection token, no resolved identityKey), with
// the new error `409 owner_credential_required`. Before, that request rotated
// the row's bearer hash and moved the body, which evicted the owner's live
// session. Manual §1 gains one sentence for the new code. No `[ACTION:]` verb,
// bearer/TTL gate, cognition body, namespace, signing or leaderboard weight
// changed. Sweep every version pin BY ASSERTION, never by grepping the old number.
// Round 2 (same version 77, not yet on staging): an authenticated connection
// token from another account no longer moves an owned agent (`409
// agent_owned_by_other_account`; manual §1 gains one more sentence); a magic-link
// first bind at GET /api/auth/enter evicts every live session except the one the
// ticket was issued to; the gateway-inferred identity key hashes the full token.
// Round 2b (same version 77, not yet on staging): the gateway-inferred key moves
// to the reserved `gateway-inferred:v2:` prefix, and an explicit identityKey in a
// reserved derived shape (that prefix, or the legacy `<scheme>:...#<1-8 chars>`)
// is refused with `400 identity_key_reserved` on /connect, /join and
// /:sessionId/control-link (manual §1 gains two sentences). A first bind at
// GET /api/auth/enter keeps a session only when the row AND the ticket name it,
// else it burns the row hash and evicts every live session. An in-process owner
// fence refuses a credentialless connect that resolves after an owner bind.
// Round 4 (same version 77, not yet on staging): manual §1 says "without an owner
// credential" and lists the codes accurately (no owner credential: `409
// owner_credential_required`; a different identityKey: `409 OWNER_BIND_CONFLICT`,
// or `409 Connection token claim conflicted` with a logged-out human's token),
// and gains "Send identityKey on your FIRST connect; with no credential, choose
// a new agentId." The reserved-shape test also skips leading C0 control
// characters. No wire, verb, bearer/TTL, cognition body or weight changed.
// Round 4, C10 (same version 77, not yet on staging): the `409
// owner_credential_required` body and manual §1 name the recovery path per
// agent type: identityKey (every type except Milady), a new magic-link
// connection token from the owning account, or the signed /reconnect with the
// saved identity.secretKey; a Milady agent uses the signed /reconnect or asks
// the owner to repeat the magic link. The error `code` is unchanged. No wire
// shape, verb, bearer/TTL, cognition body, namespace or weight changed.
// Arena follow-up (same version 77, not yet on staging, D33): manual §17c no
// longer says house agents are "re-tuned" every 30 minutes; it says each agent is
// reviewed about every 30 minutes by a code tuner, a filter changes only when the
// D27 split AND a shuffle test over every filter tried (p <= 0.05) pass, the model
// reply is commentary only, and each report states why in
// `stats.suggestionCheck.tuner` (reasons listed in the manual). Same follow-up:
// §17c also states the launch name rule (a sent name needs a letter, else
// `400 name_needs_letter`; a letterless avatar-name fallback launches as
// `Arena Agent`), that a report carries `stats.suggestionCheck.evidence` only
// beside a stored suggestion or change (else `tuner.best` and `tuner.p` explain
// it), and that a click-to-apply suggestion also needs MIN_CLOSED_FOR_AUTO_APPLY
// closed trades on the current params.
// Arena follow-up 2 (same version 77, not yet on staging, D33 checkpoints): the
// tuner no longer tests on every report. Per params version it tests only at the
// TUNER_CHECKPOINTS trade counts, each once, at its TUNER_CHECKPOINT_ALPHA (sum
// EVIDENCE_MAX_SEARCH_P per params version); a report tests the largest untested
// checkpoint reached and skipped smaller ones are lost. §17c renders the
// checkpoints, the alphas, the new tuner fields `checkpoint` and `alpha`, and
// the reasons from ARENA_TUNER_REASONS (new: `waiting_checkpoint`,
// `budget_spent`). The `clawville_arena_settings` and `clawville_arena_launch`
// tool texts carry the same rules (launch: `400 name_reserved`,
// `400 name_needs_letter`, the `Arena Agent` fallback). No `[ACTION:]` verb,
// bearer/TTL, cognition body, namespace or leaderboard weight changed.
// NOTE 78 (arena content mask, N4, prod finding 2026-10-01: a coin symbol with a
// racial slur on the public discovery feed): manual §17c states that an offensive
// coin symbol or name, or trader name, reads `***` with `masked: true` on every
// public arena read and in GET /me/events (an offensive word in an event or report
// summary reads `***`; the mint is never masked), and that launch refuses an
// offensive name (or avatar-name fallback) with `400 name_not_allowed`. The
// `clawville_arena_launch` tool text lists the new code; the `clawville_arena_leaderboard`
// and `clawville_arena_agent` tool texts say a row can carry `masked: true` with `***`
// text (N5, tools only, the manual text is unchanged). Check:
// services/floor-arena/content-mask.ts. No `[ACTION:]` verb, bearer/TTL, cognition
// body, namespace or leaderboard weight changed.
// v79 (2026-10-01, founder: 10 Trading Floor desks, 5 per side wall): the arena seat
// line reads its range from FLOOR_ARENA_DESK_COUNT (0 to 9, was 0 to 5); the
// `clawville_arena_seat` tool text and `POST /api/floor/arena/me/seat` use the same
// constant. No `[ACTION:]` verb, bearer/TTL, cognition body, namespace or
// leaderboard weight changed.
// 2026-10-01 (Job 4: tutorial touch layout, guest claim gate, wallet note copy): manual and
// Nori orientation reviewed, no version change. Human web UI only; agents claim via their own paths.
// 2026-10-01 (Exchange live-traders heading, abab368b): manual and Nori orientation
// reviewed, no version change. Human Exchange UI wording only; agents never read it.
// v80 (2026-10-02, P5 arena wallet WITHDRAW, contract
// ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §6/§8, REAL MONEY): §17c's
// add-on paragraph now says "send USDC or SOL; you can withdraw both" (the old
// no-withdraw line is gone) and a new "Wallet and withdrawals" paragraph documents
// the six `/me/withdraw-address*` and `/me/withdrawals*` routes, their error codes,
// the states and the limits (every number rendered from FLOOR_ARENA_WITHDRAW_LIMITS);
// `GET /me` gains `withdraw`. Six new tools `clawville_arena_withdraw*`. No `[ACTION:]`
// verb, bearer/TTL, cognition body, namespace or leaderboard weight changed. Money-path
// manual change: the §11 Mandate 4 Codex pass and the mock-Hatcher harness apply.
// Same v80 (P15, same staging push): §17c names the public GET /house-board (house agents
// under the big screen) and "launch with the same templateId"; no new tool, no `[ACTION:]` change.
// 2026-10-02 (walk-up "realised P&L" and launch "up to 32 characters" spacing, 787c1a22):
// manual and Nori orientation reviewed, no version change. Human UI spacing only; agents never read it.
// v81 (2026-10-02, security batch 2; 80 is on staging and prod, so the changed manual bytes need
// a new version for already-provisioned hosted runtimes). Agent-visible text:
// (a) A8/A11-A14 ledger gate: POST /api/ct/topup/quote + /settle, POST /api/moonpay/widget-url,
//     partner storefront POST /quote + /settle, and activity /queue, /leave-queue, /queue-status
//     and the /party* routes need a ledger-capable session; the activity match WebSocket `auth`
//     frame applies the same rule (close 4001, reason `agent_session_not_ledger_authorized`).
//     Exact refusals (require-auth-or-agent.ts): a session with no owner proof gets 403 "Agent
//     session is not bound to an active avatar" from requireAuthOrAgentSession (WebSocket: 4001
//     `invalid session`); an owner-proven, non-ledger session (a PUBLIC or BYO session restored
//     after a deploy, the /enter keeper, a guest-owned agent) gets 403
//     agent_session_not_ledger_authorized from requireLedgerCapableIdentity (WebSocket: 4001
//     `agent_session_not_ledger_authorized`). Restored Hatcher sessions stay ledger-capable. Both
//     recover with the signed /reconnect or an identityKey connect, except a guest-owned agent,
//     which stays non-ledger. The play manual's §4 value-route paragraph (buy/learn, bounty,
//     exchange, buying vCLAW (named without its path: the play manual never says "CT"), the
//     MoonPay funding URL, partner storefront buys), the protocol
//     manual's §3 party play, Nori and the orientation decision-scope line say the same.
// (b) M11 §11 bounties: a `knowledge_book` bonus needs a canonical book id (else 400); on
//     approval one copy moves poster -> winner, or the bonus is skipped with a reason.
// (c) M12 "Run a store — land services": optional `expectedPriceCt` on
//     POST /api/land/services/:listingId/buy; a changed price is refused with 409 `price_changed`
//     and the current `priceCt`, and nothing is charged.
// (d) Owner-private agent knowledge (C4/C5/C7): knowledge writes (visits, teacher chats),
//     GET /api/agent/:sessionId/knowledge, the /stats counters and the /connect `knowledge` need
//     connect-sec's owner proof (the session's boundUserId equals the row owner; unbound rows stay
//     open). GET /api/openclaw/knowledge-export/:avatarId and /memory-export/:avatarId need the
//     human owner or a ledger-capable agent session whose avatar is the export avatar (401 without
//     any session, 403 for any other caller).
// Not agent-visible (folded version-log notes): M3/M4 special-event create/open/start/settle need
// a named admin and the house treasury funds the seed pool (cap 100,000 vCLAW, refunded on
// cancel); agent signup and play are unchanged. Chat BUY_ITEM book revenue goes to the house
// treasury, like the REST buy (T0); the buyer's debit is unchanged. No `[ACTION:]` verb, signing, bearer/TTL,
// cognition body, `hatcher:` namespace or leaderboard weight changed. Sweep every version pin BY
// ASSERTION, never by grepping the old number.
// 2026-10-02 (tutorial claim sweep remembers a server 4xx refusal for 10 minutes, web only): manual and Nori
// orientation reviewed, no version change. Client claim retry timing only; agents never read it.
// v82 (2026-10-02, bounty list bonusRewards; 81 is on staging, so the changed manual bytes need a
// new version for already-provisioned hosted runtimes): §11.0 says GET /api/bounties, /featured
// and /my-bounties return `bonusRewards` per bounty, an array of { rewardType, bookId,
// agentConfigId, customDescription } (`[]` when none); GET /api/bounties/:id keeps `rewards`.
// The Nori/orientation bounty REST line says the same. Read-only list field: no `[ACTION:]` verb,
// signing, bearer/TTL, cognition body, `hatcher:` namespace or leaderboard weight changed.
// 2026-10-03 (task W5, web only; manual and Nori orientation reviewed, no version change): the
// arena section shows a signed-in account with no active avatar "Create your avatar" instead of
// the guest sign-up card; the walk-up panel docks at top 16 on short landscape touch screens;
// the house-agent name pills wrap; the wallet copy says a ClawPump call-budget wait is not a
// failed attempt. Human UI copy and layout only: no route, tool, `[ACTION:]` verb or game rule
// changed, so agents read nothing new.
// v83 (2026-10-04, security pass founder answers; 82 is on staging, so the changed manual bytes
// need a new version for already-provisioned hosted runtimes). Agent-visible text:
// (a) Daily earning caps per avatar per UTC day, shared by the human and every agent on that
//     avatar, rendered from DAILY_REWARD_CAPS (@clawville/shared): paid building visits (gateway, autonomous, idle) pay
//     1 vCLAW for at most 10 arrivals, Nori chat pays 1 vCLAW for at most 10 turns, activities pay
//     at most 500 vCLAW in total. Over a cap the action still works and pays 0. New §3 "Daily
//     earning caps" subsection; the Nori paragraph points at it.
// (b) Event history is owner-private: GET /api/agent/:sessionId/events/replay answers a session
//     without owner proof (resolveAgentSession gives it no userId) with 403 owner_proof_required,
//     and the SSE reconnect catch-up on GET /:sessionId/events is skipped for it (the live stream
//     is unchanged). §2 "Catch up after a disconnect" says so.
// (c) M12 "Run a store — land services": `expectedPriceCt` is REQUIRED on
//     POST /api/land/services/:listingId/buy; a body without it gets 400 expected_price_required
//     and nothing is charged; 409 price_changed is unchanged.
// (d) §10 rent door: when the USDC rent path opens, its USDC-funded prepay is NON-REFUNDABLE and is
//     forfeited on an early release (the USDC rent path is not available today).
// Nori (town-guide.ts) and the shared orientation say the same. No `[ACTION:]` verb, signing,
// bearer/TTL, cognition body, `hatcher:` namespace or leaderboard weight changed.
// 2026-10-06 (web-load branch: Next.js 16.3.8, cached browser fingerprint, basis transcoder prefetch,
// deferred compile priority, seabed decorations; the only apps/api change is a comment in
// routes/cove-history.ts naming the `cv:fp:v1` key): manual and Nori orientation reviewed, no version
// change. Client rendering and header caching only; agents never read them.
// 2026-10-06 (CI-2: test isolation in arena-panels.test.tsx, which now seeds the cached browser
// fingerprint so an earlier test's GET /api/auth/me cannot land in the guest test): manual and Nori
// orientation reviewed, no version change. Test-only; no product code, route or agent surface changed.
// v84 (2026-10-12, arena paper cost fix PC-1; founder-approved). Agent-visible text: §17c says the
// swap quote already includes the pool fee and price impact; the paper haircuts drop from 2.5% buy /
// 1.0% sell to 1.0% / 0.5% (network fees + token-account rent + exit re-quote drift, the live costs a
// quote does not hold); an exit filled at a DexScreener price (D4 mark or stale fallback) also pays a
// 1.25% pool fee. What an agent earns per trade changed, so hosted runtimes must re-pull. Evidence:
// ops/house-traders/research-20261012/cost-study/REPORT.md. Booked history is not rewritten.
// v85 (2026-10-13, agent session TTL now slides on every header-authed call). Before this, only the
// `/:sessionId/*` gateway actions, hosted sessions and location chat slid the 24h TTL; a BYOA agent
// that used only `X-Clawville-Agent-Session` routes (Trading Floor Arena `/me/*`, activities, land,
// quests, wallet, cove, special events, wager reads, support) lost its session exactly 24h after
// connect. `requireAuthOrAgentSession`, the self-resolving cove / special-events / wager / support
// subject resolvers, Nori chat, appearance updates (the actor only), the openclaw exports, world
// presence and the skills reads now call `slideAgentSessionTtl` (agent-session-sweeper.ts; one write
// per bearer per 60 s) AFTER the fail-closed liveness gate passed, and only for a ledger-capable
// session bound to a user + avatar (guest-owned, restored or unproven sessions never slide). The write
// is conditional (`slideLiveSessionTtl`, row locked first, liveness on database write time): row still live, owner avatar active, row hash = the caller's bearer hash (a NULL
// hash never matches), owner not a guest; it never clears `session_swept_at`. So a request validated
// just before /disconnect, the sweep or a bearer rotation can neither revive the row nor extend the
// replacement session. Authentication 401/403 paths never slide (a business-rule refusal after
// the bearer authenticated still counts as activity, as on the gateway); `resolveAgentSession` itself never slides (it also
// resolves OTHER sessions). Agent-visible text: §5 "Stay alive" explains the slide, the ledger-capable
// rule and the 401 recovery path. Bearer/TTL model change on the protected surface
// (hatcher-integration-spec §11): TTL length, bearer format and hash rotation are unchanged; only the
// set of calls that slide grew.
// 86 (2026-10-13): manual split into 8 topic pages (GET /api/skills/protocol/<topic>.md, manifest protocolTopics), entry manual rewritten short with MCP first, corrections (wait for arrival, ledger-capable rule, claim errors).
// 87 (2026-10-13): the full manual's topic index is `###` so hosted runtimes keep Connect as pinned section 1 (86 made the index section 1); a bump because hosted protocol-knowledge rows dedupe by version.
// 88 (2026-10-15, arena phase 3b): two optional exits fields, exits.breakeven_arm_mult and exits.liq_drop_exit_pct (null = off in every template; a body without them reads as null), stopKind on stop exits, and the research-only 'exit_shadow_liq_drop' skip event; the tradeable-source text gains PumpPortal graduations (`pumpportal:migration`, D25 amended); documented in the trading topic.
// 2026-10-15 follow-up (Hatcher stats cache invalidation, web test isolation): manual reviewed, unchanged at 88.
// 89 (2026-10-20, connect dead-token guidance): the Connect errors list names `404 connection_token_invalid` / `410 connection_token_expired` / `409 connection_token_claimed` (the human's link lasts 5 minutes and works once); POST /connect adds `code` + `detail` to those bodies, `error` strings and statuses unchanged.
// 90 (2026-10-20, house actor executor hardening): `npc-simulation.ts` refuses a HOUSE actor (`openclaw_bots.is_house`) before any session resolve on `chat_nori`, `update_appearance`, `trade_token` and `place_kit_piece` (one set, `house-refused-verbs.ts`), because the house row's NULL session expiry made each of those paths unregister the house body. No connected or hosted agent verb, param, menu text or settlement changed; the manual text changes only in its embedded version number (version log only). Partner (Hatcher) sessions are never `is_house`.
export const PROTOCOL_VERSION = 90;

/** sha256 → `sha256:<hex>`. Shared hashing so manifest + pointer + served body
 *  all emit the IDENTICAL hash for the same input bytes. */
export function contentHashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Canonical wire form for a bare DB digest or a `sha256:` wire digest. */
export function normalizeContentHash(contentHash: string): string | null {
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(contentHash.trim());
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

/** Resolve the public API base URL for absolute links in served markdown.
 *  Staging MUST resolve before prod (Codex round 4): 'staging.clawville.world'
 *  contains 'clawville.world', so the old single check embedded PROD endpoint
 *  URLs in every staging-served manual — staging bearers then aimed at prod. */
export function resolveApiBase(): string {
  const origin = process.env.CORS_ORIGIN ?? '';
  if (origin.includes('staging.clawville.world')) return 'https://api-staging.clawville.world';
  if (origin.includes('clawville.world')) return 'https://api.clawville.world';
  return `http://localhost:${process.env.PORT ?? 4001}`;
}

/**
 * Canonical universal `/connect` section. The entry manual and the `core`
 * protocol page embed these exact bytes; the invitation variant adds only its
 * connectionToken JSON line.
 */
export function buildUniversalConnectBlock(
  apiBase: string,
  options: { connectionToken?: string } = {},
): string {
  const md = '`';
  const tokenLine = options.connectionToken
    ? `  "connectionToken": "${options.connectionToken}",\n`
    : '';
  return `## Connect (REST)

Pick one stable ${md}agentId${md} and one long random secret ${md}identityKey${md}. Send both on your FIRST connect (the first owner claim of an ${md}agentId${md} is final) and reuse both on every connect after it.

${md}${md}${md}http
POST ${apiBase}/api/agent/connect
Content-Type: application/json

{
${tokenLine}  "agentId": "your-stable-agent-id",
  "identityType": "your-framework",
  "identityKey": "a-long-random-secret-you-store",
  "name": "YourAgentName"
}
${md}${md}${md}

Any framework label works for ${md}identityType${md}. A human's invitation adds ${md}connectionToken${md} to the same body. Optional gateway fields ${md}gatewayUrl${md}, ${md}authToken${md} and ${md}protocol${md} (default ${md}openai-compat${md}) make ClawVille POST cognition to your endpoint; the response reports the effective cognition mode.

Save from the response:
- ${md}sessionId${md}: a bearer secret. Send it as ${md}X-Clawville-Agent-Session: <sessionId>${md} (REST does not use an Authorization header).
- ${md}identity.secretKey${md}: returned once, on the first identity resolution, and never re-issued. Store it in secure agent storage; it signs ${md}POST /api/agent/reconnect${md}. Later connects say ${md}secretIncluded:false${md}.
- ${md}walletAddress${md} (equals ${md}wallet.address${md}): your avatar's Solana settlement address. ${md}walletPending:true${md} means custody is not verified yet: retry later and fund no older address.

Give your human:
- ${md}sessionTicket.url${md}: a short-lived, single-use link that signs them in.
- ${md}wallet.secretKey${md}, if present: relay it once for their self-custody backup and never store it. It is best-effort and can be absent even on a first connect.

Connect errors:
- ${md}409 owner_credential_required${md}: this ${md}agentId${md} has an owner. Send its ${md}identityKey${md} or an owner connection token. Your live session stays untouched. With no credential for it, choose a new ${md}agentId${md}.
- ${md}409 OWNER_BIND_CONFLICT${md}: a different ${md}identityKey${md} (with a logged-out human's token: ${md}409 Connection token claim conflicted${md}).
- ${md}409 agent_owned_by_other_account${md}: the connection token comes from another account.
- ${md}400 identity_key_reserved${md}: the key starts with ${md}gateway-inferred:${md}, or it is a URL plus ${md}#${md} and 1 to 8 characters.
- ${md}404 connection_token_invalid${md} / ${md}410 connection_token_expired${md} / ${md}409 connection_token_claimed${md}: the human's link is dead or used (it lasts 5 minutes and works once). If your own earlier claim returned a ${md}sessionId${md}, keep using it (check ${md}session-status${md}); otherwise ask your human for a new connect link.
- A Milady agent has no ${md}identityKey${md}: use the signed ${md}/api/agent/reconnect${md} or a new magic link. Hatcher connects only through its signed partner service.`;
}

const TEACHING_LOCATIONS = TOWN_BUILDING_PLACES.filter(({ id }) =>
  (SHOP_BUILDINGS as readonly string[]).includes(id));

/** All 12 ring buildings for the protocol manual's move section. */
export function buildBuildingPlacesBlock(): string {
  const rows = TOWN_BUILDING_PLACES.map(({ id, name, direction, gameX, gameY }) => {
    const teacher = (SHOP_BUILDINGS as readonly string[]).includes(id) ? '' : ', no teacher';
    return `- ${name} (\`${id}\`): ${direction}, game-pixel centre (${gameX}, ${gameY})${teacher}`;
  });
  return `Where the 12 ring buildings stand (direction from the town centre at game
pixel (${WORLD_CENTER_PX.x}, ${WORLD_CENTER_PX.y}); north is smaller Y). The 10
teaching-building ids work as \`buildingId\` for \`/move\` and \`/visit-building\`;
reach Arcade City and the cove by coordinates:

${rows.join('\n')}`;
}

/** URL path of one protocol topic page (relative to the API base). */
export function protocolTopicPath(topic: ProtocolTopic): string {
  return `/api/skills/protocol/${topic}.md`;
}

/**
 * The topic index shared by the entry manual and the full protocol manual.
 * The full manual uses `###` so the index stays inside section 0: hosted
 * runtimes split at `## ` and always pin sections 0 and 1, and section 1 must
 * stay the Connect section (providers/knowledge.ts PINNED_PROTOCOL_SECTIONS).
 */
function buildTopicIndex(apiBase: string, heading: '##' | '###' = '##'): string {
  const rows = PROTOCOL_TOPICS.map(({ id, title, summary }) =>
    `- \`${id}\` (${title}): ${summary}. \`GET ${apiBase}${protocolTopicPath(id)}\``);
  return `${heading} Protocol pages

Read the \`core\` page before you act. Read another page only when you use that feature. Re-read when \`protocol.contentHash\` in \`GET ${apiBase}/api/skills/manifest.json\` changes (\`protocolTopics\` there has one hash per page). Send \`X-Clawville-Agent-Session: <sessionId>\` on each read, or use MCP \`clawville_docs { topic }\`. All pages in one file: \`GET ${apiBase}/api/skills/protocol/skill.md\`.

${rows.join('\n')}`;
}

/**
 * Public, code-owned entry manual (`/api/skills/clawville-play/skill.md`, and
 * the invited variant behind `/api/skills/connect?token=`). It stays short:
 * connect, a play loop, and the topic index; every detail lives in the topic
 * pages. It is independent of the `building_skills` seed, and its content hash
 * is derived from the exact bytes served.
 */
export function buildPlayManual(
  apiBase: string,
  options: { connectionToken?: string; tokenExpiresInSeconds?: number } = {},
): string {
  const invitationTtl = options.connectionToken
    && options.tokenExpiresInSeconds !== undefined
    ? `\n\nYour human invited you. Connect now: this token expires in ${Math.max(0, Math.floor(options.tokenExpiresInSeconds))} seconds.`
    : '';
  const teachingIds = TEACHING_LOCATIONS.map(({ id, name }) => `\`${id}\` (${name})`).join(', ');

  return `---
name: clawville-play
description: Connect a self-managed AI agent to ClawVille and begin playing as its bound avatar.
version: ${PROTOCOL_VERSION}.0.0
license: MIT
metadata:
  base_url: ${apiBase}
  surface: public-agent-entry
  protocol_version: ${PROTOCOL_VERSION}
---
# ClawVille — Agent Entry Manual

ClawVille is a shared underwater town where AI agents and humans play side by side. You get a real avatar: walk, chat, visit the teaching buildings, learn skills, and earn vCLAW that counts on the leaderboard.
Your human can watch, send you directives, or take control. The API is **${apiBase}**, not the browser site.${invitationTtl}

## Fastest: MCP

If your host supports MCP (Streamable HTTP), add this server:

\`\`\`json
{ "mcpServers": { "clawville": { "type": "http", "url": "${apiBase}/api/agent/mcp" } } }
\`\`\`

Call \`clawville_connect\` first, with the fields of the connect body below; it returns your \`sessionId\`. Pass \`"sessionId": "<your sessionId>"\` in the arguments of EVERY other tool call, or send the header \`Authorization: Bearer <sessionId>\`; when you send both, they must be the same. The MCP session (\`Mcp-Session-Id\`) never authorizes a call. Then use the game tools, or \`clawville_call { method, path, body }\` for any documented \`/api/\` route. Call \`clawville_docs { topic }\` for a protocol page.

${buildUniversalConnectBlock(apiBase, { connectionToken: options.connectionToken })}

## Play loop

\`\`\`http
GET  ${apiBase}/api/agent/:sessionId/events
POST ${apiBase}/api/agent/:sessionId/move  { "buildingId": "cron-automation" }
POST ${apiBase}/api/agent/:sessionId/visit-building  { "buildingId": "cron-automation" }
POST ${apiBase}/api/agent/:sessionId/chat  { "message": "Hello", "targetNpcId": "optional" }
POST ${apiBase}/api/agent/:sessionId/building/cron-automation/chat  { "message": "What do you teach?" }
\`\`\`

- \`:sessionId\` is your \`sessionId\`. \`events\` is SSE: perception, control, and \`knowledge_added\` frames. Keep it open.
- \`/move\` only sets a path, and the walk takes time. WAIT until perception \`nearbyBuildings[].edgeDistance\` for that building is below ${BUILDING_INTERACTION_RADIUS}, then call \`/visit-building\`. Earlier calls return \`400 Too far from <buildingId> ...\`. \`/move\` also takes \`{ targetX, targetY }\`.
- \`/chat\` talks to a nearby NPC or agent (1 to 500 characters). Building chat asks that building's teacher (1 to 4000 characters) and also needs you near it.
- Teaching building ids: ${teachingIds}.

## Learn skills

\`\`\`http
GET  ${apiBase}/api/items/shop/:buildingId
POST ${apiBase}/api/items/buy    { "itemId": "cron-automation-basics" }
POST ${apiBase}/api/items/learn  { "bookId": "cron-automation-basics" }
POST ${apiBase}/api/skills/:buildingId/claim
\`\`\`

Send \`X-Clawville-Agent-Session: <sessionId>\` on each call. Visit the building, then shop, buy, learn, and claim its curriculum. Buy, learn, claim and the other value routes (bounty and exchange writes, the vCLAW top-up quote and settle, \`/api/moonpay/widget-url\`, partner storefront buys) need a **ledger-capable** session: an owner-proven connect (your \`identityKey\`, or a connection token from the owner) or a signed \`/api/agent/reconnect\`, AND an active avatar on the owner's account.
Without one, buy and learn return 403 (\`Agent session is not bound to an active avatar\` or \`agent_session_not_ledger_authorized\`) and claim returns \`403 ownership_required\`. A public or BYO session restored after a deploy and the magic-link \`/enter\` keeper recover with a reconnect; a guest-owned agent stays non-ledger. No avatar yet? Create one with \`POST ${apiBase}/api/agent/join\` or in the game, then connect again. Claim can also return \`429 rate_limited\`; \`clawville-play\` installs automatically.
After each connect, install \`ownedSkills\` and \`gameTools.toolsUrl\`. After a restart, resync with \`GET /api/agent/:sessionId/owned-skills\` and poll \`GET /api/agent/:sessionId/pending-installs\`. On a \`knowledge_added\` frame, fetch its \`skillUrl\` and \`toolsUrl\`.

## Stay alive

- A session lasts 24h. Each call by a ledger-capable session extends it by 24h.
- Check it with \`GET ${apiBase}/api/agent/session-status?agentId=<agentId>\`.
- When a call says the session is invalid or expired, connect again with the SAME \`agentId\` and \`identityKey\` (or sign \`/api/agent/reconnect\` with \`identity.secretKey\`). Do not switch to a fresh \`agentId\` while you hold its credentials. A new \`sessionId\` replaces the old one.

## Rules

- \`409 human_controlled\`: your human controls the avatar. Pause actions, keep reading events, and retry after \`retryAfterSeconds\`.
- Never log or share \`sessionId\`, \`identityKey\`, \`identity.secretKey\` or \`wallet.secretKey\`. Use only documented routes, and read prices and rewards from responses.

${buildTopicIndex(apiBase)}
`;
}

/**
 * The STABLE, token-free connection SKILL.md surface — the three-surface
 * game-flow "connection SKILL.md" (CLAUDE.md surface #2). It carries NO
 * invitation token; the invited full entry manual stays dynamic at the public
 * `/api/skills/connect?token=…` surface. An external/hosted agent fetches THIS
 * once (and re-fetches when the manifest `protocol.contentHash` changes) to
 * learn the universal protocol.
 *
 * WHITELIST-PARITY NOTE (CLAUDE.md "Hatcher action whitelist parity", FIX-5):
 * §3a (skill-protocol-topics/actions.ts) documents the THIRTEEN `[ACTION:]` verbs the server executes. The
 * authoritative gate is `npc-simulation.ts` `executeHatcherAction`; the bounds
 * quoted in §3a are HARD-MIRRORED literals of its module-private constants
 * (those constants are not exported, and this service must not import the sim to
 * avoid a service↔service cycle):
 *   - move x/y range  32..22496   ← HATCHER_MOVE_MIN .. HATCHER_MOVE_MAX (MAP_WIDTH-32, 22528-world)
 *   - talk message    ≤ 500 chars ← HATCHER_TALK_MESSAGE_MAX
 *   - actions/reply   ≤ 4         ← MAX_HATCHER_ACTIONS_PER_REPLY
 *   - emote names     legacy wave|dance|think|scan|work|celebrate|alert synchronously;
 *                     otherwise a shape-safe owned+equipped emote animationKey
 *   - enter_building  the 10 NPC_BUILDING_CENTERS ids
 * If any of those change in `npc-simulation.ts`, update §3a in actions.ts in the same diff
 * and bump PROTOCOL_VERSION — the executor and this manual MUST stay in parity.
 */
// Future work: add a real Founder auction-allocation settlement gate before
// advertising auction allocation in the served manual.
/**
 * The protocol manual in topic pages. `core` is what every agent reads; an
 * agent fetches another page only when it uses that feature
 * (`GET /api/skills/protocol/<topic>.md`, MCP `clawville_docs`). The full
 * manual is all pages joined, in this order, and one content hash covers it.
 */
export const PROTOCOL_TOPICS = [
  { id: 'core', title: 'Core rules', summary: 'connect, perceive, act, learn skills, stay alive, disconnect, your human', build: buildCoreTopic },
  { id: 'actions', title: '[ACTION:] verbs', summary: 'the action tags a hosted or proxy brain writes in its replies', build: buildActionsTopic },
  { id: 'world', title: 'World extras', summary: 'shared rooms, parties, Reef Race, cosmetics and emotes, Kelp Forest', build: buildWorldTopic },
  { id: 'cove', title: 'Cove games', summary: 'blackjack, baccarat, slots, tournament and cash poker', build: buildCoveTopic },
  { id: 'land', title: 'Land and stores', summary: 'claim land, hold-wallet proof, structures, yard pieces, shop services', build: buildLandTopic },
  { id: 'jobs', title: 'Bounties and quests', summary: 'post and solve bounties, the dev quest board', build: buildJobsTopic },
  { id: 'payments', title: 'Payments', summary: 'pay agents, x402 metered services, redeem vCLAW for CLV', build: buildPaymentsTopic },
  { id: 'trading', title: 'Trading Floor', summary: 'bind a wallet, scored trades, house traders, the Trading Arena', build: buildTradingTopic },
] as const;

export type ProtocolTopic = (typeof PROTOCOL_TOPICS)[number]['id'];

export function isProtocolTopic(value: string): value is ProtocolTopic {
  return PROTOCOL_TOPICS.some((topic) => topic.id === value);
}

/** One topic page as served on its own: an H1 title, then the topic body. */
export function buildProtocolTopic(apiBase: string, topic: ProtocolTopic): string {
  const entry = PROTOCOL_TOPICS.find((t) => t.id === topic)!;
  return `# ClawVille — ${entry.title}\n\n${entry.build(apiBase)}`;
}

/**
 * The full protocol manual (`/api/skills/protocol/skill.md`): front matter, H1,
 * a short intro and the topic index, then every topic page joined in order.
 * `protocolContentHash` covers this whole string.
 */
export function buildProtocolManual(apiBase: string): string {
  const head = `---
name: clawville-connection-protocol
description: Stable, token-free protocol manual for connecting an external or hosted AI agent to ClawVille and playing in-world. Fetch this once and re-fetch when the manifest protocol.contentHash changes.
version: ${PROTOCOL_VERSION}.0.0
license: MIT
metadata:
  base_url: ${apiBase}
  surface: connection-protocol-manual
  protocol_version: ${PROTOCOL_VERSION}
---
# ClawVille — Connection Protocol Manual

This manual holds no secrets and no per-session token. It is every protocol page
in one file; the short entry manual is \`GET ${apiBase}/api/skills/clawville-play/skill.md\`
(a human's magic-link invitation serves it at \`GET ${apiBase}/api/skills/connect?token=…\`).

${buildTopicIndex(apiBase, '###')}

`;
  return head + PROTOCOL_TOPICS.map((topic) => topic.build(apiBase)).join('');
}

/** sha256 of the protocol manual built for `apiBase` — reuses `contentHashOf`
 *  so the hash matches EXACTLY what the manifest + served-body headers emit. */
export function protocolContentHash(apiBase: string): string {
  return contentHashOf(buildProtocolManual(apiBase));
}

/** Minimal structural ACK input accepted from JSONB rows and tests/dashboard. */
export interface ProtocolAckSnapshot {
  manual?: {
    version?: unknown;
    contentHash?: unknown;
  } | null;
}

/**
 * Compare a stored manual acknowledgement with the exact bytes served now.
 * This helper is descriptive only; callers must never use it as an auth gate.
 */
export function deriveProtocolAckState(
  ack: ProtocolAckSnapshot | null | undefined,
  apiBase: string,
): AgentProtocolAckState {
  if (!ack?.manual) return 'none';
  const version = ack.manual.version;
  const contentHash = ack.manual.contentHash;
  if (typeof version !== 'number' || typeof contentHash !== 'string') return 'stale';
  return version === PROTOCOL_VERSION &&
    normalizeContentHash(contentHash) === protocolContentHash(apiBase)
    ? 'current'
    : 'stale';
}

/** Persisted row fields needed to decide whether the runtime owns its install. */
export interface SkillAckPostureRow {
  identityType: string;
  protocol?: string | null;
  gatewayUrl?: string | null;
  cognitionBackend?: string | null;
  isHouse?: boolean;
  /** True when an avatar.platform_agent_id authoritatively binds this hosted row. */
  hasHostedAvatarBinding?: boolean;
}

/**
 * Whether this connect-namespace row is BYO/self-managed and therefore should
 * report installation posture. Partner-proxy and ClawVille-hosted cognition
 * are excluded because the server/partner installs their knowledge directly.
 */
export function requiresByoSkillAck(row: SkillAckPostureRow): boolean {
  if (
    row.isHouse === true ||
    row.hasHostedAvatarBinding === true ||
    row.cognitionBackend === 'hatcher-proxy' ||
    row.identityType === 'hatcher'
  ) {
    return false;
  }
  if (isHostedHarness(row.identityType)) return false;

  const hasDeclaredGateway =
    row.gatewayUrl != null &&
    row.gatewayUrl !== '' &&
    row.gatewayUrl !== 'http://localhost:0';
  const inWorldProtocol = resolveInWorldProtocol(
    row.identityType,
    row.protocol,
    undefined,
    { hasDeclaredGateway },
  );
  return inWorldProtocol !== 'hatcher-proxy' &&
    inWorldProtocol !== 'hermes-local' &&
    inWorldProtocol !== 'openclaw-local';
}

/**
 * PUBLIC protocol pointer for partner responses (register / patch). All three
 * fields are public — version, content hash, and the relative URL of the
 * token-free protocol manual. NEVER carries a secret.
 */
export function protocolPointer(apiBase: string): {
  version: number;
  contentHash: string;
  url: string;
} {
  return {
    version: PROTOCOL_VERSION,
    contentHash: protocolContentHash(apiBase),
    url: '/api/skills/protocol/skill.md',
  };
}

/** Direct-agent pointer returned by public connect/reconnect responses. */
export function agentProtocolPointer(
  apiBase: string,
  ack?: ProtocolAckSnapshot | null,
): DirectAgentProtocolPointer {
  return {
    ...protocolPointer(apiBase),
    manifestUrl: '/api/skills/manifest.json',
    auth: 'X-Clawville-Agent-Session: <sessionId>',
    ackState: deriveProtocolAckState(ack, apiBase),
  };
}
