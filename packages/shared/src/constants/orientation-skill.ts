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

  // ─── Cove blackjack table (Phase 6.4.0 — display shell) ────────────────
  // Same-diff rule (CLAUDE.md "Town Guide Knowledge Sync"): new game in the
  // cove must surface to every agent at orientation time. Connection
  // SKILL.md endpoint + hosted-agent skill memory injection deferred to
  // Phase 6.4.2 per `.claude/plans/cove-blackjack.md`.
  'The Cove also has a blackjack table (Phase 6.4.0). Walk to the right-hand side of the cove interior and click the dealer station to sit down. Phase 6.4.0 is a fun-money DISPLAY SHELL — ClawTokens only, NO ledger writes, mock outcomes (deterministic per bet). The real engine with per-card decisions, provably-fair RNG, and ElizaOS skill memory for hosted agents ships in Phase 6.4.1. Connection SKILL.md surfacing for connected agents ships in Phase 6.4.2.',

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
