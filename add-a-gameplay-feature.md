# Add a gameplay feature

"Gameplay feature" = anything a player perceives — a new mode, a new mini-game, a new UI surface, a new economy mechanic, a new quest tier, a portal flow change.

## Preconditions

- The feature is in scope. Discuss in an issue first if it touches:
  - The agent-onboarding contract (`POST /api/agent/connect`)
  - The ClawToken economy formulas
  - The ElizaOS runtime
  - A new top-level package or app
- You have a one-paragraph description of the feature, ready to drop into the relevant `GameFeatures.md` section.

## Steps

1. **Identify the surfaces.** A gameplay feature usually touches some combo of:
   - **Frontend store** — `apps/web/src/stores/{game,npc,activity,quest}.ts`
   - **UI components** — `apps/web/src/components/game/**`
   - **3D anchor** — a new component under `apps/web/src/lib/three/**`
   - **Backend route(s)** — `apps/api/src/routes/**`
   - **Server service(s)** — `apps/api/src/services/**`
   - **Database** — `packages/database/src/schema/**`
   - **Shared constants** — `packages/shared/src/constants/**`
2. **Walk the matching workflow runbooks** for each surface in turn:
   - New route → [`add-a-route.md`](./add-a-route.md)
   - New service → [`add-a-service.md`](./add-a-service.md)
   - New NPC → [`add-an-npc.md`](./add-an-npc.md)
   - New building → [`add-a-building.md`](./add-a-building.md)
3. **Update the gameplay store** if you added a field (`controlMode`, `agentConnected`, `selfStreak`, `selfBestStreakThisMatch`, etc.).
4. **Wire the UI**.
   - For modal flows, add the modal under `apps/web/src/components/game/<feature>-modal.tsx` and gate it on a store flag.
   - For in-world surfaces, add the React component under `apps/web/src/lib/three/<feature>.tsx`.
   - Decide the visibility gate: `always` / `hasAvatar` / `agentConnected`. Mirror the existing matrix in `GameFeatures.md §11`.
5. **Emit events** for analytics. Hook into `event-logger.logEvent({...})`. If the feature contributes to the agent leaderboard, also touch `apps/api/src/routes/leaderboard.ts` — see `ARCHITECTURE.md §5b`.
6. **Tutorial quest hook (optional).** If the feature deserves a tutorial step, add a row to `TUTORIAL_QUESTS` in `packages/shared/src/constants/tutorial-quest-rewards.ts`. Set `status: 'pending'` until the event aggregator is wired up.
7. **Typecheck both apps:**
   ```bash
   cd apps/web && bun x tsc --noEmit -p tsconfig.json && echo WEB_OK
   cd apps/api && bun x tsc --noEmit -p tsconfig.json && echo API_OK
   ```
8. **Ship** via [`ship-a-feature.md`](./ship-a-feature.md). Browser-verify the full happy path AND at least one error path.

## Doc updates required (same diff)

Multi-doc by default. Walk top-to-bottom:

- [ ] **`GameFeatures.md`** — add the player-facing description. New section, or extend an existing one. Bump §0 "Accuracy corrections" only if you also fix a prior factual bug. Add the change to §20 "Recent material changes".
- [ ] **`WorldContent.md`** — only if the feature adds something to the open-world scene.
- [ ] **`3dStructure.md`** — only if it adds 3D rendering specs (new shader, new animation system, new camera mode, new GPU constraint).
- [ ] **`ARCHITECTURE.md §2/§3/§4/§8`** — for the route / middleware / service / schema changes.
- [ ] **`ARCHITECTURE.md §5`** — if it emits new event types or changes the leaderboard rubric.
- [ ] **`CLAUDE.md` path → doc matrix** — add rows if the feature creates new "go-to" code paths.
- [ ] **Town Guide `knowledge[]`** — `packages/agent-templates/src/locations/town-guide.ts`. Nori must be able to tell new players about the feature.

## Watch out for

- **Visibility gating bug:** the most-recent rewrite of `GameFeatures.md §11c` explicitly flagged a 2026-04-24 fix that re-gated player UI from `hasAvatar` to `agentConnected`. Pre-fix, NPC mode + guest flow got slammed with full player chrome (~75% of mobile real estate). Decide your gate consciously.
- **State scope:** Zustand re-renders every subscribed component when a store field changes. For high-frequency updates (jump physics, NPC positions), use module-scope refs + R3F `useFrame` — never per-frame `set()`. See `3dStructure.md §6e` (jump pattern) and the `npc.ts` mutation pattern.
- **WorldLabelsOverlay**: never use drei `<Html>` for new in-world DOM labels. The single-root `WorldLabelsOverlay` already provides registry + projection. Use `useWorldLabel(...)` + `<WorldLabel>` per `3dStructure.md §5d`.
- **Activity portals:** Bumper Shells + Reef Race are the canonical examples of "complete gameplay feature". When you read the source, every layer is there: store slice, WS hook, sim service, anti-cheat validators, bot controller, reward pipeline, leaderboard route, season service. New activities should mirror that.
