# Land options popup implementation notes

Date: 2026-07-30  
Spec: `docs/land-options-popup-brief.md`, frozen rev 2

## Implemented inventory

- `apps/web/src/lib/land-proximity.ts`: centered-world parcel hit testing with module-load ring bounds, an indexed zero-allocation sweep, and O(1) parcel-slot lookup.
- `apps/web/src/lib/land-proximity.test.ts`: pins current ring bounds and exercises centers, edges, corners, outside points, lookups, and primitive return values.
- `apps/web/src/components/three/World3DCanvas.tsx`: mounts the headless 5 Hz `LandProximityTracker` for player, possessed NPC, autonomous, and explore lifecycle handling.
- `apps/web/src/stores/game.ts`: adds the guarded `nearParcelCode` axis and clears it on body/mode, building-entry, and reset transitions.
- `apps/web/src/lib/three/land-state-hydrator.tsx`: hydrates available, owned, reserved, and retired parcel statuses in fail-safe merge order.
- `apps/web/src/components/game/land-options-pill.tsx`: renders the amber read-only route pill only for explicitly hydrated actionable/informational parcel states.
- `apps/web/src/app/(world)/game/page.tsx`: mounts the pill for every avatar-bearing visitor, including guests.
- `apps/web/src/components/game/talk-to-character-bar.tsx`: yields the lower slot whenever parcel proximity is active.
- `GameFeatures.md`: documents copy, guest behavior, explicit-hydration suppression, and building > parcel > NPC prompt precedence.
- `3dStructure.md`: inventories the 5 Hz headless tracker and its zero-geometry, zero-draw, zero-allocation sweep contract.

## Verification record

The first Gate 1 run reached Turbo, then a Bun child process failed with Windows
status `-1073741502`. After that failure, Windows refused to initialize any new
PowerShell or Bun process with the same status, including one-line process probes
with profile loading disabled. This prevented Gates 2 through 6 and all Git
operations. Browser gates 7 and 8 were intentionally not run by the implementer.

### Gate 1: build

Command: `bun run build`

Exit code: `66`

Relevant tail:

```text
Tasks:    3 successful, 6 total
Cached:    0 cached, 6 total
  Time:    2.61s
Failed:    @clawville/agent-templates#build

EXIT CODE: 66
• turbo 2.9.5
 ERROR  @clawville/agent-templates#build: command
(C:\Users\itachi\Documents\Crypto\cv-land-pill\packages\agent-templates)
C:\Users\itachi\AppData\Local\Microsoft\WinGet\Links\bun.exe run build exited
(-1073741502)
 ERROR  run failed: command  exited (-1073741502)
error: script "build" exited with code 66
```

One retry of the exact command exited `-1073741502` before producing build
output. The failure is an OS process-initialization failure, not a compiler
diagnostic.

### Gate 2: strict web types

Not run. Windows process initialization remained unavailable with exit
`-1073741502`.

### Gate 3: land proximity unit test

Not run. Windows process initialization remained unavailable with exit
`-1073741502`.

### Gate 4: coordinate-space audit

Not run. Windows process initialization remained unavailable with exit
`-1073741502`.

### Gate 5: poison-default audit

Not run. Windows process initialization remained unavailable with exit
`-1073741502`.

### Gate 6: allocation audit

Not run. Windows process initialization remained unavailable with exit
`-1073741502`.

### Gate 7: browser walk-ons

Not attempted. Owned by the orchestrator.

### Gate 8: viewport sweep

Not attempted. Owned by the orchestrator. DevTools emulation does not expose `env(safe-area-inset-*)`, so that sweep cannot prove the bottom-anchor safe-area math. One real-iPad screenshot from the founder is still required.

## Deviations

None. Every spec-stated file/line fact used by the implementation matched the live code at implementation time.

## Honest residuals and limitations

1. **The reserved/retired hole is currently latent, not live.** No code path in `apps/api/src` writes `reserved` or `retired` to `land_parcels` today. The mechanism was still defective because the existing client fetched only available and owned. The live risk was fetch failure and the first-mount pre-hydration window: a naive consumer of the store default could label occupied parcels available. Full four-status hydration plus the pill's explicit-map-entry gate fixes all three cases.
2. **The poison available default survives elsewhere.** `getParcelStatus` in `apps/web/src/stores/land.ts` and the sign-hitbox filter in `apps/web/src/lib/three/land-parcels.tsx` still default a missing parcel to available. Changing 3D sign visibility on fetch failure is a separate product decision and was explicitly out of scope.
3. **The Land Office modal still says "For Sale".** The existing tab label in `land-office-modal.tsx` retains retired tenure framing. The pill copy does not use that language, but the destination modal still does. This is follow-up copy debt and was out of scope.
4. **The 5 Hz tracker permits up to 200 ms of boundary lag.** This is deliberate against 1088 to 1216 wu parcel footprints.
5. **Safe-area positioning cannot be proven offline.** Gate 8 still needs orchestrator viewport checks, and DevTools emulation cannot prove `env(safe-area-inset-*)`; a real-iPad screenshot is required.
6. **Autonomous coverage waits for a confirmed `autonomousBodyId`.** Between the mode toggle and the first confirming SSE tick, the tracker keeps `nearParcelCode` null instead of guessing a body.
7. **Pixi has no parcel proximity.** The Pixi path has no live mount site, and this slice deliberately leaves it unchanged.
8. **Ownership is browser-session-scoped.** `useAvatar()` resolves through `/api/avatars/me`, so a raw agent-session-only client does not receive the "Your parcel" variant. This was accepted as out of scope.

---

## Browser verification record (orchestrator, 2026-07-30, local prod bundle :3005 → API :4001 → staging DB)

Gate 7 walk-ons — VERIFIED live:
- Available parcel (`parcel-starter-10`, warped via World Map fast travel as staging user LandTest1): pill fired "🏝️ Parcel parcel-starter-10 · Available / Refundable vCLAW deposit / VIEW IN LAND OFFICE" within a tick of arrival; amber border; positioned above the avatar chat bar.
- Pill tap → Land Office opened on the For Sale tab. NOTE (pre-existing modal debt, NOT this slice): the focused parcel's card renders in the DOM but is NOT auto-scrolled into view (card top at y≈4632). Same behavior as the legacy 3D sign-click path (both call `openLandOffice(parcelCode)`); logged as follow-up copy/UX debt beside the modal's "For Sale" tab label.
- Modal close → pill returned immediately (no blink; the deliberate non-clear in `openLandOffice` behaves as designed).
- Owned-by-me (`parcel-c-00`, LandTest1's legacy-rented parcel): "🏝️ Your parcel parcel-c-00 / Manage your land / MANAGE" ✔
- Owned-by-other (`parcel-starter-00`): "🏝️ Claimed parcel parcel-starter-00 / Someone already holds this lot", info-only, no button ✔
- Boundary correctness: landing ~80 wu outside `parcel-c-00`'s footprint showed NO pill; crossing in showed it. Standing between parcels → nothing.
- Mode transitions: toggling Controlled→Autonomous with the pill visible cleared it instantly; toggling back (respawn at town center) left no stale pill.
- Console: no errors during the whole session (only the known world-stage warmup safety-fuse warning, unrelated).

Gate 7 residuals (honest):
- GUEST npc-mode walk-on NOT live-verified: guests cannot fast-travel ("Take control of your avatar to fast-travel") and footwork to the ring at guest walk speed is impractical in a session. The guest path differs only in the `useIsGuest()` copy branch + TalkToCharacterBar suppression (both code-reviewed; the talk bar was confirmed rendering in guest npc mode pre-parcel). Needs one real guest walk-on or a future dev teleport.
- Building-precedence live overlap is geometrically unreachable (parcels never overlap building zones), so the `nearLocation` suppression could not be triggered live; verified in code (gate ladder order) instead.

Gate 8 viewport sweep — NOT COMPLETABLE with this session's tooling: `resize_window` resizes the OS window but the profile runs ~70% browser zoom, so the CSS viewport never reaches phone widths, and no chrome-devtools `emulate` MCP was attached. Structural mitigations: the pill calls `useIsMobile()` itself and restates LocationHUD's exact mobile offset formula (character-identical, production-proven at these viewports). Safe-area math was ALWAYS un-provable in emulation (spec §8). NEEDS: founder real-device (iPad + phone) eyeball on a parcel.
