## Summary

Unstubs `@clawville/app-clawville` so the curated app card actually appears in the Apps section. Today the package is imported as a side effect from `apps/app/src/main.tsx`, but `apps/app/vite.config.ts` aliases it to `optional-eliza-app-stub.tsx`, replacing the real package with a no-op shell. Result: ClawVille is registered in `MILADY_CURATED_APP_DEFINITIONS`, the hero image at `apps/app/public/app-heroes/clawville.png` is staged, the import line exists — but no surface ever loads.

The package is now ready: [`@clawville/app-clawville@0.2.0`](https://www.npmjs.com/package/@clawville/app-clawville) ships a `./ui` subpath that calls `registerOperatorSurface(...)` with a real React component (matching the `@elizaos/app-screenshare` and `@elizaos/app-scape` patterns).

## Changes

- **`apps/app/vite.config.ts`** — remove the 4-line `@clawville/app-clawville` stub alias entry. The other stubs (`hyperscape/ui`, the generic `optionalElizaAppAliasPattern`) are untouched.
- **`apps/app/package.json`** — add `"@clawville/app-clawville": "^0.2.0"` to dependencies.

## Why now

`@clawville/app-clawville@0.1.0` shipped with only the chat-action surface (no `/ui`), which is why we were stubbed. `0.2.0` (just published) adds the curated-grid surface using the canonical pattern verified against `plugins/app-screenshare/src/ui/` and `plugins/app-scape/src/ui/`:

```ts
import { registerOperatorSurface } from "@elizaos/app-core";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface.js";
registerOperatorSurface("@clawville/app-clawville", ClawvilleOperatorSurface);
```

The component reads session state via `useApp()` + `selectLatestRunForApp(appName, appRuns)`, then renders three variants — `detail` (catalog), `live` (compact sidebar), `running` (full dashboard). It branches on `AppOperatorSurfaceProps.variant` exactly like the screenshare and scape surfaces.

## Verification

Plugin-side end-to-end smoke (against production `api.clawville.world`):

```
✅ package.json exports ./ui correctly
✅ package.json declares @elizaos/app-core + react peer deps
✅ package.json elizaos.app.heroImage points at assets/hero.svg
✅ All 13 expected exports present
✅ plugin.name / plugin.actions / default alias all correct
✅ LAUNCH_CLAWVILLE action has validate + handler
✅ validate() accepts 5/5 launch phrases / rejects 3/3 unrelated
✅ handler() returned success=true (live POST /api/agent/connect)
✅ wallet=HUv5nsj2Cboai7HWT8VasSU4SFdJeJwKi7LLS8TdGHtt
✅ Runtime settings stashed (session / uuid / wallet)
```

Persistent smoke fixture: agentId `clawville-plugin-smoketest-v1` (re-runnable in `clawville-milady-plugin` repo via `npm run smoke`).

## After this PR merges

Next desktop / cloud build cuts ClawVille into the curated grid. Hero image already at `apps/app/public/app-heroes/clawville.png`. No CI changes required; `bun install` resolves the new dep from npm.

## Related

- Plugin source: https://github.com/ItachiDevv/clawville-milady-plugin
- npm: https://www.npmjs.com/package/@clawville/app-clawville
- Original integration: #1839 (added `MILADY_CURATED_APP_DEFINITIONS` entry + the import line that this PR now lets resolve to the real package)
