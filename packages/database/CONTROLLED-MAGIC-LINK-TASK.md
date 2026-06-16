# Controlled-mode-through-magic-link — pipeline trace + fix (Codex + Claude, co-working)

GOAL (authoritative, set by the user): the deliverable is **controlled mode through the magic
link** — owner clicks Launch on Hatcher → magic-link auth → lands IN CONTROL of the agent's
in-world avatar (drives it), NOT spectate. The "autonomous-first / controlled-deferred" framing
in `.claude/plans/hatcher-launch-exchange.md` (Decision 3, §D) and `docs/hatcher-launch-exchange-reply.md`
§3 is **SUPERSEDED and was a flaw** — do NOT treat those as authority. Code = source of truth.

Worktree under review: this one (`ClawVille-codex-review`, commit bfafa96a = current staging).

## Verified facts so far (cite-checked, file:line — confirm or correct each)
- Magic link is built + already used by the partner: `apps/api/src/routes/portal.ts:854`
  `POST /api/portal/mint-for-hatcher` → `mintSessionTicket` (`session-ticket-service.ts`) →
  `{ redirectUrl }` (one-time ticket → Lucia session as the agent's bound user).
- ControlMode includes `'player'`: `apps/web/src/stores/game.ts:23`
  (`'explore' | 'npc' | 'player' | 'autonomous'`).
- A logged-in user WITH an avatar row naturally embodies in `'player'` (drives their own body):
  `apps/web/src/stores/game.ts:264-291` ("keeps driving their own body — controlMode stays
  'player', isSpectator false… sessionId truthy always embodies in 'player'").
- The launch handler OVERRIDES that to spectate: `apps/web/src/components/game/hatcher-launch-handler.tsx:127`
  `setControlMode('explore')` ("do NOT possess… regardless of the agent's mode").
- The exchange request hardcodes `mode:'autonomous'`: `apps/api/src/routes/partner-hatcher-launch.ts:202`.

## The three unknowns to RESOLVE with citations (do not assume)
1. Is the bound-user avatar the agent's in-world body END TO END? Trace `ensureHatcherAvatar`
   (`partner-hatcher.ts`) → the avatar/`openclaw_bots` body → does `'player'` control drive THAT
   exact body? Cite the chain. If the human's player-avatar and the agent's sim body are two
   different objects, controlled mode needs more than a mode flip — say so.
2. Do autonomous cognition turns fight a human driver? How does `npc-simulation.ts` decide to run
   an autonomous turn for a `hatcher:` agent, and does `controlMode==='player'` / human possession
   suppress it? If nothing suppresses it, controlled mode needs a suspend path — cite where.
3. What else keys off the launch landing in `'explore'` (camera focus, hatcherSpectate, the
   game-page explore→player promotion guard)? Changing to `'player'` must not break those.

## Deliverable
A cited end-to-end trace answering 1–3, then the EXACT minimal diff to make a magic-link launch
land the owner in `'player'` control of the agent's avatar (suspending autonomous turns while
driven), with every changed line justified. Flag anything uncertain as UNVERIFIED rather than
guessing. Write findings to `.hatcher-ref/CONTROLLED-FINDINGS.md`.
