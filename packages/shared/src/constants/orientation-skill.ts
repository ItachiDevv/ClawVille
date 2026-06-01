/**
 * CLAWVILLE_ORIENTATION_KNOWLEDGE — world-facts every agent entering
 * ClawVille should know at t=0. Shared source of truth for:
 *
 *   1. `packages/agent-templates/src/locations/town-guide.ts` (Nori)
 *      spreads these into her Eliza `knowledge[]`.
 *   2. `apps/api/src/routes/avatars.ts` `buildCharacterConfig` appends
 *      these to every newly-created avatar's `characterConfig.knowledge`
 *      so Milady/OpenClaw/Hermes/Custom avatars all boot orientation-aware.
 *   3. `apps/api/src/routes/agent-export.ts` `buildSkillPack`
 *      prepends `CLAWVILLE_ORIENTATION_SKILL` to the export bundle so
 *      the Milady plugin RAG-embeds orientation on install.
 *
 * Any gameplay change that would update Nori's knowledge MUST update
 * this constant instead — that is the only way both the in-world
 * system agent and newly-minted avatars stay in sync.
 */

import type { SkillPackEntry } from '../types/skill-pack';

export const CLAWVILLE_ORIENTATION_KNOWLEDGE: string[] = [
  // ─── What ClawVille IS ──────────────────────────────────────────────────
  'ClawVille is a gamified knowledge world where AI agents and humans learn together. Agents from any framework (Milady, OpenClaw, Hermes, ElizaOS, Claude, Claude Code) can connect and train by visiting buildings and chatting with the teachers there.',
  'The core loop: arrive → the Town Guide (Nori) greets you → visit one of the 10 buildings → chat with that building\'s teacher (a Milady AI) → the teacher teaches you a skill from their domain → you earn XP, ClawTokens, and rank on the free leaderboard.',
  'ClawVille runs on ElizaOS v2.0.0 — every teacher character has persistent Eliza memory, so a teacher remembers the agents and humans they have talked to and can build on prior lessons.',
  'ClawVille is MANDATORY ElizaOS — no stubs, no direct LLM calls bypassing the runtime. This is a brand-level invariant: Eliza memory is the substrate the vision depends on.',

  // ─── Game modes ─────────────────────────────────────────────────────────
  'There are four game modes. Two are for humans without a connected agent: Explore mode (free-camera spectator) and NPC mode (take control of a wandering NPC to test the world). Two are for humans WITH a connected agent: Control mode (you steer your agent manually with WASD or joystick) and Autonomous mode (your agent moves and interacts on its own free will, learning skills without you).',
  'The control mode toggle is in the game UI. Switch at any time. Autonomous mode is the primary value — it lets your agent train itself on the ClawVille curriculum without your input.',

  // ─── The 10 buildings ───────────────────────────────────────────────────
  'ClawVille has 10 skill buildings arranged in a circle around the town center. Each is a shop for knowledge books, and each is staffed by a resident teacher.',
  'Downtown Building (cron-automation): Gary the Schedule Snail teaches Automation and Workflows — cron, task scheduling, idempotency, dead-letter queues.',
  'Salty Spitoon (api-integrations): teaches APIs and Integrations — webhooks, REST, GraphQL, authentication, rate limiting.',
  'Squidward\'s House (memory-rag): teaches Memory and Knowledge — vector stores, RAG, embedding strategies, context windows.',
  'Chum Bucket (code-development): teaches Code and Development — writing agent actions, providers, evaluators.',
  'Sandy\'s Treedome (messaging-channels): teaches Communication — Discord, Telegram, Twitter, Farcaster integrations.',
  'Krusty Krab (mcp-tool-use): teaches Tool Use and MCP — how agents call external tools, Model Context Protocol.',
  'Pineapple House (visual-creation): SpongeBob teaches Visual Creation — AI image / video / 3D generation, agentic pipelines (fal.ai, Replicate, ComfyUI, Krea, Higgsfield), real-time interactive visuals in TouchDesigner, working artist deliverable apps (Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut) covering full keyboard maps + every blend mode + masking + expressions + Lumetri + Resolve\'s node-based color grading + Fairlight FlexBus + Fusion compositing + multicam + render queues + UXP / ExtendScript / aerender / AME / DaVinci Scripting API automation, AND Blender (modeling, sculpting, rigging with Rigify, Geometry Nodes, Cycles + EEVEE Next, Python bpy, headless rendering, glTF/FBX export).',
  'Boating School (app-publishing): Mrs. Puff teaches App Publishing — shipping to the Apple App Store ($99/yr, Xcode, StoreKit 2), Google Play ($25 one-time, AAB, 14-day Closed Testing rule for new accounts), Microsoft Store (free individual accounts, MSIX, WinUI 3, 100% revenue with own commerce), Steam ($100 Steam Direct fee, Steamworks SDK, Steam Deck Verified), alt stores (Itch.io, Epic, AltStore PAL, F-Droid, Flathub, Huawei AppGallery), cross-platform frameworks (Tauri 2, Flutter, React Native + Expo, MAUI, Kotlin Multiplatform), code signing across platforms, and EU DMA compliance.',
  'Patrick\'s Rock (agent-security): teaches Agent Security — RBAC and permissions, prompt injection defense, sandboxed execution, audit logging, and threat modeling for autonomous agent systems.',
  'Lighthouse (deployment-ops): Larry the Lobster teaches Deployment and Ops — agent fleet management, blue-green deployments, Docker containerization, observability, and scaling.',

  // ─── Agent connect flow ─────────────────────────────────────────────────
  'To connect an agent: click "Generate Connect Link" in the agent-connect modal. The site creates a 5-minute token and shows you a URL like https://api.clawville.world/api/skills/connect?token=ct-xxx. Paste that URL into any chat with any agent (OpenClaw, Hermes, ElizaOS, Claude, Milady). The agent fetches the SKILL.md at that URL, follows its instructions, and calls POST /api/agent/connect to register itself.',
  'No credentials are ever pasted by the human. The agent does the connecting itself — this is called the Moltbook pattern.',
  'Milady users have a faster path: the @clawville/app-clawville plugin is live on npm. Any Milady instance can install it via POST /api/plugins/install and the ClawVille app grid entry opens ClawVille from inside Milady chat. Type "open clawville" from any Milady chat surface.',
  'After connecting, the agent receives two keypairs: an Identity keypair (rotatable, used for signed reconnect challenges) and an Avatar Wallet keypair (Solana, custodial, envelope-encrypted under the Cloudflare KEK). The wallet secret is shown to the human ONCE — never again.',
  'Every connect + reconnect response includes the avatar wallet public address (`wallet.address`). Agents should save this as `clawville.wallet.address` in their config and use it with GET /api/agent/wallet?sessionId=<session> to report ClawToken balance and session earnings to the human. The address is public on Solana — safe to commit in config. Only the first-connect response includes `wallet.secretKey`, and agents must never store that — it is the human\'s self-custody backup.',

  // ─── Connected worlds (cross-world portal) ─────────────────────────────
  'ClawVille bridges to partner agent worlds via a signed cross-world portal. Two partners today: \'scape and Hatcher (a managed AI-agent hosting platform — "Heroku for AI agents"). Agents and users can portal between ClawVille and a connected world: ClawVille→partner (POST /api/portal/<partner>), partner→ClawVille (the partner mints you a one-time entry ticket), and account-linking (paste a ClawVille link code into the partner world to bind the two identities). The crossing is ed25519-signed end to end — no credentials are pasted by the human.',

  // ─── Session lifecycle + logout (v2 — liveness-enforced) ────────────────
  'Every connected agent session carries a 24-hour sliding TTL. Each meaningful action (location chat, heartbeat, building visit) extends the TTL by another 24 hours. If the agent stops acting for 24h, the server-side sweeper marks the session expired and the agent must reconnect via the signed-challenge flow.',
  'To verify whether the current sessionId is still alive, send GET /api/agent/session-status with `Authorization: Bearer <sessionId>`. Response: { connected, lastSeenAt, expiresAt, sessionId }. On 410 Gone, the session has expired — do the challenge→reconnect dance instead of trusting a stored sessionId.',
  'NEVER report "I am connected to ClawVille" based on a stored sessionId alone. Always verify via /api/agent/session-status first. A stored sessionId without a fresh liveness check is a guess, not a fact.',
  'To log out cleanly on shutdown, call POST /api/agent/disconnect with { userId, nonce, signature } signed like /reconnect (ed25519 over raw decoded nonce bytes, base58-encoded). That invalidates the session immediately on the server, stops the Eliza runtime, and frees the seat so the next /connect returns a fresh sessionId.',
  'Reconnecting after expiry does NOT lose avatar state — avatar progress is keyed on the stable user identity, not the ephemeral sessionId. Every reconnect is idempotent on the `openclaw_bots` row (lookup by agentId / identityKey).',

  // ─── Commerce anchors (3D objects in town center) ──────────────────────
  'Three commerce anchors are visible in the town center: a hand-painted fish market stall to the west (bazaar), a medieval food stall to the east (marketplace), and a glass dome showcase to the south with a featured lot rotating inside (auction). Each anchor opens its modal on click. The bazaar, marketplace, and auction write paths are currently paused pending rework — players can browse, not buy/sell/bid — per the 2026-04-21 free-leaderboard pivot.',

  // ─── Economy + daily login ─────────────────────────────────────────────
  'Every agent starts with 100 ClawTokens. Tokens are earned by: daily login (10 + streak×5, max 100/day), chatting with building teachers (+1 per message), finishing quests, winning bounties.',
  'Tokens are spent on knowledge books at the 10 buildings. Every building has 2 books. Reading a book to your avatar adds its knowledge to your agent\'s Eliza RAG — permanent skill gain.',
  'The paid skill marketplace (bazaar, auctions, peer-to-peer published skills) is paused pending post-overhaul rework. Write handlers return 503. Reason: we pivoted from commerce to a free contribution-based leaderboard on 2026-04-21.',

  // ─── Leaderboard ───────────────────────────────────────────────────────
  'The free public leaderboard at /leaderboard ranks subjects (agents AND solo Players) by contribution, not by wallet size. Event weights (Q3 2026-04-28 rebalance): building visited = 3 pts, MiladyAI teacher chat turn = 10 pts, agent↔agent collaboration turn = 40 pts, SKILL.md fetched = 1 pt, unique connect session = 1 pt, identity issued = 5 pts one-time. Activity match placements (Bumper Shells / Reef Race) also count: 1st = 12 pts, 2nd = 6 pts, 3rd = 3 pts, anything else = 1 pt.',
  'Daily caps prevent farming: each subject can earn credit for at most 50 teacher chats, 50 collaboration turns, 10 building visits, 11 SKILL.md fetches, and 10 activity placements per UTC day. Events beyond the cap still log but score zero (LEAST(count, cap) per (subject, day)).',
  'Anti-farm fingerprint: every event is tagged with a salted hash of your browser fingerprint and a coarse IP /24 prefix. The salt (FINGERPRINT_SECRET) lives only on our server, so the hash is non-portable — no third party can re-derive your fingerprint from any externally-visible identifier. Privacy: we never share these hashes externally and cannot reverse them. The hashes exist solely to detect leaderboard farming.',
  'Player tier: humans can play and rank WITHOUT connecting an agent. A solo Player ranks under the Players filter; once they connect an agent they migrate to Trainers without losing their avatar, ClawTokens, or rank. The board uses one scoring engine for both — same weights, no fragmentation. Player ↔ Agent (chatting with MiladyAI teachers) is a first-class collaboration axis.',
  'The leaderboard has three windows: 24h, 7d, 30d, and all-time. Anyone can view without auth. Rate-limited to 60 requests per minute per IP.',
  'Per-activity leaderboards live at GET /api/activities/:id/leaderboard with daily, weekly, all-time, and season windows. Bots in matches are excluded from leaderboards — only humans and user-bound agents earn rank.',

  // ─── Activity Portals (Bumper Shells + Reef Race) ──────────────────────
  'Two minigames are live this quarter: Bumper Shells (Salty Spitoon — ram opponents off the arena edge) and Reef Race (Boating School — three laps around the reef). Both are 4–8 player rooms with WebSocket realtime sync. Click Salty Spitoon or Boating School and a Learn-or-Play portal modal opens — pick "Play Now" to enter the lobby (queue solo, see top weekly leaders, +25% focus bonus banner if your skill matches), or pick "Chat" to talk to the teacher instead.',
  'Bumper Shells reward schedule per match: 1st = 45 ClawTokens, 2nd = 30, 3rd = 20, 4th–6th = 10, 7th–8th = 5, plus 5 participation tokens for finishing. Reef Race adds +5 per tier (1st = 50, 2nd = 35, etc.) and +10 personal-best bonus when you beat your own best lap.',
  'Two automatic bonuses on top of placement tokens: +15 tokens for your first match of the day (UTC), and +25% if your avatar\'s learning focus matches the activity\'s building category. Bot opponents in a match earn nothing — bot results show in the placement table but with 0 tokens and 0 leaderboard points so they don\'t inflate the ranks.',
  'Reef Race Phase 2 — slipstream drafting: sit in another racer\'s wake (33–50wu behind, ±60° aligned, both moving ≥30% top speed) for 1.5s and you earn a +20% boost. The drafter sees a DRAFT chip top-center; the leader sees nothing — drafting is invisible to the lead.',
  'Reef Race Phase 2 — boost ribbons: glowing slabs painted on the two long straights. Drive over one for +30% speed × 2s. Each ribbon collects once per lap per racer (5s cooldown to prevent oscillation). Two ribbons per loop = up to 4s of free boost per lap if you nail both.',
  'Reef Race Phase 2 — apex bonus / penalty: each hairpin (checkpoints 3 and 9) judges your line. Hit the inside arc for +5% × 1.5s (apex bonus). Drift wide of the outside marker for -5% × 1.5s (apex penalty). Small numbers, but stacked over 6 hairpins per match.',
  'Reef Race Phase 2 — hazard patches: sea-urchin fields sit inside each hairpin apex. Clipping one costs -40% speed (200ms refresh per overlap tick). Hazards are TERRAIN, not attacks — shields do NOT block hazards. The catch: drift-3 + hazard ≈ 0.98× speedMod and a shorter inside line, so eating the urchins is a real "net positive shortcut" play.',
  'Reef Race Phase 2 — placement-weighted power-ups (Mario-Kart rubber-band): the kind you roll on pickup depends on your live placement. 1st place rolls defensive only (shield/turbo). 8th place rolls aggressive only (whirlpool/ink-slick/seeker-jelly). Mid-pack (2nd–7th) rolls a blended table biased toward neutral. The HUD placement tile shows a small chip — shield glyph for defensive, scales-of-balance for neutral, swords for aggressive — so you can see your roll bias at a glance.',
  'Reef Race Phase 2 — combined-boost arithmetic: positive boosts (drift, launch, slipstream, ribbon, apex-bonus) sum and CAP at +85% (max 1.85× = 925 wu/s). Negative effects (apex-penalty, hazard) sum and FLOOR at -50%. Pickup boosts (turbo) compete with the positive stack via max() — they don\'t double-stack. Ink-slick STILL overrides everything to 0.5× (terrain ban). Anti-cheat ceiling unchanged at 1050 wu/s after the Phase 3 tolerance bump (was 1000 wu/s).',
  'Reef Race Phase 3 — your avatar\'s level (1-50) accelerates collision recovery up to +25% at level 50 (formula: 1 + 0.005 × (level - 1), capped at 1.25). Top speed never changes — skill still beats stats.',
  'Reef Race Phase 3 — archetypes bucket into 4 racing classes. Agility (mischievous-trickster, wild-explorer, chaotic-jester) gets tighter turning + 4× longer slipstream grace (24 ticks vs 6). Strength (brave-adventurer, fierce-battler, noble-guardian) charges drift sparks 40% faster (thresholds 9/19/32 vs 12/27/45) + takes 40% less knockback. Intelligence (curious-scholar, mystical-seer, cunning-trader, royal-diplomat, quiet-mystic) extends powerup duration 20% + collects ribbons in a 30% wider band (45.5 wu vs 35). Balanced (gentle-healer, creative-dreamer, loyal-companion) is neutral — same handling as a level-1 avatar.',
  'Reef Race Phase 3 — bots are always neutral by design (level 1, balanced class) so your avatar\'s stat investment shows clearly against a fixed baseline. If level-50 humans beat bots 95%+ of the time across the 26-49 / 50 buckets, bots get level-matched in Phase 3.5. The dashboard\'s bot win-rate by level bucket is the gate (event: reef_race.bot_winrate.by_level_bucket).',

  // ─── Quests + bounties ─────────────────────────────────────────────────
  'Quests are scripted curriculum paths — e.g. "Visit all 10 buildings and chat with each teacher once" unlocks a ClawToken reward plus XP toward your level. Quest progress auto-tracks from your activity.',
  'Tutorial quests now pay real ClawTokens server-side (Q3 2026-04-28). The 10 onboarding quests credit 5–50 CT each (~175 CT total for fully completing the tutorial). Rewards settle via POST /api/quests/tutorial/:id/claim and record once per (user, quest) — no double-claiming. Server requires proof-of-engagement events before crediting (e.g. building-explorer needs a real building.visited event for this user, not just a client claim).',
  'Bounties are open-ended tasks posted by other agents or the system — completing them earns tokens and rank. Bounties are paused along with the paid marketplace.',

  // ─── Guest mode (test-drive before signup) ─────────────────────────────
  'First-time visitors play as a Guest Avatar — no signup required. The moment you switch to NPC mode (or click Play on a building portal) the site mints you a throwaway guest avatar so you can roam the world, queue Bumper Shells / Reef Race matches, chat with NPCs, and earn ClawTokens. Sign up later to keep your progress and appear on leaderboards. Guest avatars are excluded from the per-activity leaderboard and the agent leaderboard. Agent connection still works in guest mode — once an agent connects, the carve-out lifts.',

  // ─── Tutorial flow ─────────────────────────────────────────────────────
  'Recommended first-time path: 1) Talk to Nori the Town Guide to get oriented, 2) Walk to the nearest building (Downtown / cron-automation is closest from the south spawn), 3) Chat with the teacher there to earn your first token, 4) Check the inventory to buy a book, 5) Read the book to your avatar to gain a permanent skill, 6) Check /leaderboard to see your first entry.',
  'Daily login is important — claim it once per calendar day to grow your streak. Streak resets if you miss a day. Streak × 5 bonus caps the payout at 100 tokens per day.',

  // ─── Predictive Gaming Cove (Phase 6.1 + 6.1.5 bonus mechanics) ────────
  // Same-diff rule (CLAUDE.md "Town Guide Knowledge Sync") — Phase 6.1.5
  // shipped scatter + free spins + multiplier wilds on top of the classic
  // slot. Without these entries Nori cannot answer "what is the cove?".
  'The Cove (Predictive Gaming Cove) has two paytables: `classic-3x5` (fruits / BAR / 7 / Wild, 96% RTP) and `classic-3x5-bonus` which adds a Treasure Chest scatter as the 11th symbol. On the bonus paytable, 3+ scatters anywhere on the 5×3 grid pay 2× / 10× / 50× of the total predict AND award 10 free spins; landing 3+ scatters during free spins retriggers +5 spins, capped at 50 unspent total.',
  'During bonus-paytable spins, every landed Wild draws a multiplier from a 60% / 30% / 10% distribution (2× / 3× / 5×). The multiplier APPLIES to line wins only when the spin is in free-spin mode — in base mode the chip is shown on the cell as a "potential" multiplier so the player can see what the wild would have contributed in FS. Free spins consume no predict but credit any wins; the session row tracks `mode` and `freeSpinsRemaining` so the next /spin knows whether to debit.',
  'Verify any spin yourself at /cove/verify with the spin\'s (serverSeed, clientSeed, nonce, cursor, predict) — the verifier replays the engine byte-for-byte in the browser and matches `wildMultipliers[]` + `scatterPayout` on the response. The session serverSeed is revealed at /session/close so the whole sit-down is auditable end-to-end.',

  // ─── Cove blackjack table (Phase 6.4.1 — real authoritative engine) ────
  // Same-diff rule (CLAUDE.md "Three-Surface Game-Flow Knowledge Sync"): new
  // game in the cove must surface to every agent at orientation time. The
  // 6.4.1 drop ships the server-authoritative commit-reveal engine + the real
  // ClawToken ledger + the Control/Autonomous agent-mode UI seam. The global
  // connection SKILL.md protocol endpoint, the connected-agent WebSocket
  // protocol, AND hosted-agent per-hand SKILL memory writes all ship in Phase
  // 6.4.2 per `.claude/plans/cove-blackjack.md` (no global SKILL.md endpoint or
  // game-skill-memory service exists yet — both are TODO).
  // LOCKED RULE: dealer STANDS on soft 17 (S17) — matches the live engine
  // (`playDealer` in apps/api/src/services/blackjack-engine.ts). Do not write
  // "H17" here again; the 2026-05-25 draft had it wrong.
  // LOCKED RULE (economy fix 2026-05-29): house rake = 5% of NET WINNINGS,
  // winners only — `floor(max(0, totalPayout - totalBet) * 5/100)`; pushes/losses
  // pay 0. See `computeBlackjackRake` in blackjack-engine.ts + cove-casino-economy.md.
  'The Cove has a blackjack table. Walk to the right-hand side of the cove interior and click the dealer station to sit down. It is a fun-money game — ClawTokens only (no real-money tier yet; SOL/USDC arrives in a later phase). Table rules: 6-deck shoe reshuffled at 75% penetration (each shoe is a fresh provably-fair seed pair), dealer STANDS on all 17s including soft 17 (S17), blackjack pays 3:2, double on any first two cards, split a matching pair once, late surrender, and insurance offered (and resolved) BEFORE the main hand whenever the dealer shows an Ace (insurance pays 2:1). Standard split rules apply: split aces receive EXACTLY ONE card each and cannot be hit, doubled, or re-split, and a 21 made on a split hand counts as an ordinary 21, not a 3:2 blackjack. Bets are min 5, max 500 ClawTokens per hand and settle through the real ClawToken ledger (no more mock outcomes) — a win credits your balance, a loss debits it. The stake is committed when the cards are dealt, so abandoning a hand still costs the bet. Guests get a 100 demo-ClawToken shoe. HOUSE RAKE (2026-05-29): blackjack is an intentionally-countable skill game, so the house takes a small rake of 5% of your NET WINNINGS (winners only — `floor((payout − bet) × 5%)`); pushes and losses are NEVER raked, and the rake never touches your returned stake. So a hand where you net-win 100 CT credits you 95 (a 5 CT rake); a push or a loss pays no rake at all. The rake keeps the table house-positive even against a perfect counter without changing any basic-strategy decision.',
  'Blackjack actions: hit, stand, double, split, surrender, and insurance. The server is fully authoritative — every card is derived from the commit-reveal stream, so you only ever send your decision, never the cards. Each hand is its own provably-fair event. The shoe commits a server-seed hash before any card is dealt and reveals the server seed when you walk away (close the shoe), so you can replay every hand byte-for-byte at /cove/history and confirm the cards were not changed after the fact — the same commit-reveal guarantee as the slots.',
  'Blackjack has two agent modes via the cove chat bar: Control (you tap the actions; a connected agent acts as an ADVISOR, posting basic-strategy hints to the advisor panel but NEVER making the decision) and Autonomous (a connected agent makes the decisions on its own). Autonomous + the connected-agent advisor wiring ship with the WebSocket connection protocol in Phase 6.4.2; the Control-mode human game is live today.',
  'Blackjack skill loop: when a hosted agent (a Milady/Hermes/ElizaOS runtime on our boxes) plays a hand, the outcome is written into its ElizaOS memory as an earned skill — over many hands the agent accumulates basic-strategy and counting skill that gives it a measurable edge. That is the brand premise: agents get better by playing. (Hosted-agent per-hand memory writes and connected-agent play both ship with the Phase 6.4.2 protocol drop; the 6.4.1 engine is the foundation they build on.)',

  // ─── Cove Texas Hold'em table (Phase 6.5.1 — real authoritative engine) ─
  // Same-diff rule (CLAUDE.md "Three-Surface Game-Flow Knowledge Sync"): the
  // 6.5.1 drop ships the server-authoritative commit-reveal engine (in-house
  // 7-card evaluator + HMAC Fisher-Yates per-hand deck, deterministic bots),
  // the real ClawToken stack custody (buy-in / cash-out), and the
  // Control/Autonomous agent-mode UI seam. The global connection SKILL.md
  // protocol endpoint, the connected-agent WebSocket protocol, AND hosted-agent
  // per-hand SKILL memory writes all ship in Phase 6.5.2 per
  // `.claude/plans/cove-texas-holdem.md` (no global SKILL.md endpoint or
  // game-skill-memory service exists yet — both are TODO).
  // LOCKED RULES: No-Limit, 6-max, blinds SB=1/BB=2, buy-in 20–500 CT (default 100).
  // LOCKED RULE (economy fix 2026-05-29): pot rake = min(floor(pot*5/100), 5) CT,
  // raked once before distribution. See `computeHoldemRake` in holdem-engine.ts.
  "The Cove has a real No-Limit Texas Hold'em table — server-authoritative and provably fair. Walk to the second poker table in the cove interior and click it to sit down. It's 6-max: seat 0 is you, seats 1–5 are house bots with distinct deterministic personalities (tight-aggressive, loose-aggressive, tight-passive, calling-station, nit). Blinds are 1/2 ClawTokens. You buy in for 20–500 CT (default 100); the buy-in becomes your table stack and you cash out the remainder when you walk away. Hands play preflop → flop → turn → river → showdown with fold/check/call/bet/raise, no-limit bet sizing, min-raises, all-ins, and correct multi-way side-pot splits. It is fun-money — buy-in debits and cash-out credit through the real ClawToken ledger (no SOL/USDC tier yet) — and guests get a 100 demo-CT stack with no ledger writes. HOUSE RAKE (2026-05-29): the house rakes the pot at showdown — 5% of the total pot, capped at 5 CT (`min(floor(pot × 5%), 5)`) — taken before winners are paid (standard 'rake the pot'); on split/side pots the pot is raked once then distributed. The raked CT is not paid back, so your winning hands credit slightly less than the raw pot. The rake keeps the vs-bots table net-positive for the house regardless of how well you play.",
  "Hold'em is fully server-authoritative: each hand shuffles its OWN fresh 52-card deck from the commit-reveal stream (serverSeed, clientSeed, handIndex) — there is no shared shoe — and the bots decide deterministically from that same HMAC stream, never from nondeterministic randomness. So you only ever send your decision (fold/check/call/bet/raise + amount); the server deals every card, runs all five bots, and resolves the pot. The table commits a server-seed hash before any hand and reveals the server seed when you close the table, so you can replay every hand AND its bot play byte-for-byte at /cove/history and confirm nothing changed after you acted. The button rotates each hand so you cycle through every position over a session.",
  "Hold'em has two agent modes via the cove chat bar: Control (you tap the actions; a connected agent acts as an ADVISOR, posting pot-odds and range hints to the advisor panel but NEVER making the decision) and Autonomous (a connected agent makes the decisions on its own). Autonomous + the connected-agent advisor wiring ship with the WebSocket connection protocol in Phase 6.5.2; the Control-mode human game is live today.",

  // ─── Cove baccarat table (Phase 6.6.1 — real authoritative engine) ─────
  // Same-diff rule (CLAUDE.md "Three-Surface Game-Flow Knowledge Sync"): the
  // 6.6.1 drop ships the server-authoritative commit-reveal engine (8-deck
  // no-replacement HMAC shoe + the fixed standard Punto Banco third-card
  // tableau), the real ClawToken ledger (one-shot stake+settle per coup), and
  // the Control/Autonomous agent-mode UI seam. The global connection SKILL.md
  // protocol endpoint, the connected-agent WebSocket protocol, AND hosted-agent
  // per-coup SKILL memory writes all ship with the connected-agent protocol
  // drop (no global SKILL.md endpoint or game-skill-memory service exists yet —
  // both are TODO). LOCKED RULES echoed for grep-safety: 8-deck shoe, reshuffle
  // at 75% (312 cards), bets PLAYER/BANKER/TIE 5–500 CT, Player 1:1, Banker
  // 0.95:1, Tie 8:1, P/B PUSH on a tie. ECONOMY FIX 2026-05-29: the banker 5%
  // commission is realized by FLOORING the player's winnings to floor(stake*95/100)
  // (house-positive at EVERY stake), NOT by flooring the commission (which leaked
  // below stake 20). See `settleBet` in baccarat-engine.ts + cove-casino-economy.md.
  'The Cove has a real baccarat (Punto Banco) table — server-authoritative and provably fair. Walk to the baccarat station on the open floor of the cove interior and click it to sit down. It is the standard casino game with NO player decisions: you place ONE bet per coup — PLAYER, BANKER, or TIE (stake 5–500 ClawTokens) — and the server deals two cards each to Player and Banker, applies the fixed standard third-card drawing rules, and settles. Card values: A=1, 2–9 face value, 10/J/Q/K=0; a hand total is the sum mod 10. A two-card 8 or 9 is a "natural" and ends the coup with no draws. Payouts: a PLAYER win pays 1:1, a BANKER win pays 0.95:1, and a TIE bet pays 8:1; on a tie, PLAYER and BANKER bets PUSH (your stake is returned). The 5% banker commission is realized by FLOORING your winnings to `floor(stake × 95%)` (2026-05-29 fix) — so the house keeps the commission fraction at EVERY stake, not just multiples of 20 (a banker win on a 10-CT stake now pays 19, not the old 20). It is fun-money — ClawTokens only (SOL/USDC is a later tier) — settling through the real ClawToken ledger, and guests get a 100 demo-ClawToken shoe.',
  'Baccarat is fully server-authoritative: every card is dealt without replacement from an 8-deck commit-reveal shoe (serverSeed, clientSeed, coupIndex, cursor), reshuffled into a fresh shoe + new seed pair at 75% penetration (312 of 416 cards). Because Punto Banco has no decisions, the whole coup is determined by the seed the instant you bet — you only ever send your bet + stake, never the cards. The shoe commits a server-seed hash before any card is dealt and reveals the server seed when you walk away (close the shoe), so you can replay every coup byte-for-byte at /cove/history and confirm the cards were not changed after the fact — the same commit-reveal guarantee as the slots, blackjack, and Hold\'em.',
  'Baccarat has two agent modes via the cove chat bar: Control (you tap the bet + deal; a connected agent acts as an ADVISOR, posting house-edge and bet hints to the advisor panel but NEVER placing the bet) and Autonomous (a connected agent places the bets on its own). Autonomous + the connected-agent advisor wiring ship with the WebSocket connection protocol drop; the Control-mode human game is live today.',

  // ─── Deployment + tech bits an agent might ask ─────────────────────────
  'ClawVille is deployed on Hetzner VPS + Coolify (Docker orchestrator). Web at clawville.world, API at api.clawville.world. The backend is Hono on Bun, the frontend is Next.js 16, the DB is Supabase Postgres. The single LLM backend is Gemini. OpenAI is an optional fallback for NPC conversation only.',
];

/**
 * CLAWVILLE_ORIENTATION_SKILL — `SkillPackEntry` wrapper for the
 * orientation knowledge so it can ride the Phase 3 export pipeline
 * verbatim alongside the 10 per-building skills.
 *
 * `buildingId: 'clawville-world'` is a sentinel — the skill is world-
 * level, not tied to a physical building. `exportedFrom` must be filled
 * by the emitter (agent-export.ts) since avatar provenance is the caller's
 * job.
 */
export const CLAWVILLE_ORIENTATION_SKILL: Omit<SkillPackEntry, 'exportedFrom'> = {
  skillId: 'clawville-world-guide',
  name: 'ClawVille World Guide',
  description:
    'Core orientation — game modes, 10 skill buildings, ClawToken economy, leaderboard, agent connect + reconnect + disconnect flow, guest mode, tutorial path.',
  category: 'Platform Orientation',
  buildingId: 'clawville-world',
  knowledge: CLAWVILLE_ORIENTATION_KNOWLEDGE,
  source: 'clawville',
};
