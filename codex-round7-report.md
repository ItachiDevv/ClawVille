# Hold'em table-room Round 7 — seat geometry repair + all-avatar seating

Date: 2026-07-20
Branch: `feat/cove-3d-holdem`
Base: `5abbe0ee65d89fb6efdbe1182fdd50e033fa68a6`
Scope: local implementation and local evidence only; nothing pushed.

## Outcome

Round 7 restages the five opponent seats around one authoritative body/stool/card anchor set, corrects the 2× stool-scale error, lowers the complete felt-relative presentation, and adds a registry-aware seating dispatcher for all 28 selectable avatar keys. The final forced-camera orbit and 56-image roster matrix show separated seats, visible upper silhouettes, stool contact, and no table/self intersection in the reviewed views.

## Root cause and fix by founder item

### R7a — stools at 2× intended size

Root cause: stools were cloned with `FURNITURE_SCALE=2.9` while their authored layout and all seat constants use `S=1.45`. Their measured disc top therefore landed at y=104, above both the y=91.64 table rim and y≈51 hips.

Fix: `STOOL_SCALE=S=1.45`. The live audit measures all five stool tops at y=52; normal seated hips measure y=51.1 and the Hermes fallback pins hips to y=52.

### R7b — heads and shoulders below the felt

Root cause: the full table visual remained at its source top y=91.64 while seated heads/shoulders were y≈88/y≈81.

Fix: preserve the 2.9× table footprint but translate the whole table visual by `TABLE_VISUAL_Y=70−91.64=-21.64`. `TABLE_TOP_Y=70` now drives cards, badges, camera eye/look and audit targets. Final measured normal shoulders/heads are y=81.2/y=88.1; Hermes is y=88.6/y=94.2. The rail therefore lands at lower chest/elbow level in player and side views. Dealer model, pose and floor grounding were not changed.

### R7c — neighbor interpenetration

Root cause: split figure/chair anchors left adjacent bodies only about 45–56wu apart and let downstream consumers drift.

Fix: a single `roomSeat()` source now supplies body, stool, card and badge coordinates and derives yaw toward the table origin. Centers are:

| Seat | Basis × 1.45 | World center |
|---|---:|---:|
| 1 | `(-58,-42)` | `(-84.10,-60.90)` |
| 2 | `(-103,-4)` | `(-149.35,-5.80)` |
| 3 | `(-87,50)` | `(-126.15,72.50)` |
| 4 | `(58,-42)` | `(84.10,-60.90)` |
| 5 | `(103,-4)` | `(149.35,-5.80)` |

Minimum adjacent center distance is 80.8wu (seats 2↔3), above the requested ≈70wu floor. Front, side and wide orbit captures show no neighboring meshes touching.

### R7d — Hermes oblique breakup

Diagnosis: this was not transparent draw order. The native Hermes seated GLB's baked skinned coat/dress and limbs deform into the breakup at the low oblique angle; direct `cove_*` retargeting on the scale-100 family also produces unstable leg geometry.

Fix: retire the native special mesh in this room. Hermes female, Hermes male and Tekk now use their registry VRM, a clean sampled `sit_idle_m` upper body, verified normalized upper/lower-leg bends, and raw-hip pinning to y=52. This is the least-broken deterministic pose for this pass. Front and side matrix captures show clean continuous silhouettes; the default Hermes female measures a 10.5° torso pitch with head and shoulders clear of the rail.

### R7e — card prop clipping

Fix: peek cards are 0.72× the old width/height, the fan midpoint moves 4wu tableward and 2.5wu upward from the sampled hand midpoint, pair gap is 0.34 card widths, fan roll is ±9° and pitch is −8°. The local-only `?seatCards=1` audit switch forces the normal sampled hand props without mutating controller state. Final seat-1 and seat-4 orbit close-ups show both fans between/above the palms rather than through fingers.

### R7f — every-avatar seating

- `avatar_type='glb'` uses `RiglessPerchFigure`: KTX2-aware loading, `SkeletonUtils.clone`, registry scale as the baseline, per-model 42–116wu visible bounds, 2–7wu outward bias, table-facing native +Z, and contact compensation for padded jellyfish/seahorse bounds. It adds no animation and no `useFrame` work.
- Milady and Hatcher VRMs retain frozen `cove_peek|think|watch|rest` poses.
- Hermes/Tekk use the scale-100 manual seated fallback described above.
- Chibi `cove_*` retargeting was caught by the first matrix as a full-body horizontal fold. Both chibis now use their upright idle upper body plus normalized seated legs at `CHIBI_TARGET_HEIGHT=120`, with hips pinned to the disc.
- Dev/local override: `/cove/table?seatModels=lobster,sweet_crab,hermitcrab,octopus,lobster_plush`. Up to five comma-separated `MODEL_REGISTRY` keys are accepted. Missing/invalid slots fall back to the production seat model. It is ignored on a non-local production host.
- Audit helper: `bun scripts/seat-roster-audit.ts` captures all selectable keys. Optional CLI keys allow a focused recapture, for example `bun scripts/seat-roster-audit.ts seahorse`.

## Chosen constants

| Constant | Value | Reason |
|---|---:|---|
| `FURNITURE_SCALE` | 2.9 | Preserve accepted table footprint |
| `S` / `STOOL_SCALE` | 1.45 | Authored layout basis; stool disc y=52 |
| `TABLE_TOP_Y` | 70 | Lower-chest/elbow rail; shoulders clear |
| `TABLE_VISUAL_Y` | −21.64 | Moves source top 91.64 to y=70 |
| `WORLD_AVATAR_HEIGHT` | 160 | Existing shared humanoid target |
| `CHIBI_TARGET_HEIGHT` | 120 | Natural chibi proportion while clearing rail |
| Minimum adjacent gap | 80.8wu | Exceeds ≈70wu acceptance floor |
| Rigless bounds | 42–50wu general; seahorse 108–116wu | Compensate radically different source proportions |
| Peek fan scale/offset | 0.72×; +4wu tableward; +2.5wu Y | Clear fingers/palms |
| Production camera | eye `[0,128,-150]`, look `[0,82,113.1]`, FOV 68 | Derived from y=70 felt relationship |

## Full selectable-avatar roster matrix

Verdict `PASS` means both named captures were reviewed together for readable table-facing silhouette, stool contact, rail/table clearance and self clipping. Neighbor clearance is additionally proven by the non-isolated five-seat orbit captures. Hatcher entries are selectable registry keys currently backed by the corresponding Milady assets and were still captured independently.

| Registry key | Front capture | Side capture | Verdict |
|---|---|---|---|
| `lobster` | `scripts/r7-roster-lobster-front.png` | `scripts/r7-roster-lobster-side.png` | PASS |
| `sweet_crab` | `scripts/r7-roster-sweet_crab-front.png` | `scripts/r7-roster-sweet_crab-side.png` | PASS |
| `lobster_plush` | `scripts/r7-roster-lobster_plush-front.png` | `scripts/r7-roster-lobster_plush-side.png` | PASS |
| `hermitcrab` | `scripts/r7-roster-hermitcrab-front.png` | `scripts/r7-roster-hermitcrab-side.png` | PASS |
| `jellyfish` | `scripts/r7-roster-jellyfish-front.png` | `scripts/r7-roster-jellyfish-side.png` | PASS |
| `octopus` | `scripts/r7-roster-octopus-front.png` | `scripts/r7-roster-octopus-side.png` | PASS |
| `seahorse` | `scripts/r7-roster-seahorse-front.png` | `scripts/r7-roster-seahorse-side.png` | PASS |
| `milady_official_1` | `scripts/r7-roster-milady_official_1-front.png` | `scripts/r7-roster-milady_official_1-side.png` | PASS |
| `milady_official_2` | `scripts/r7-roster-milady_official_2-front.png` | `scripts/r7-roster-milady_official_2-side.png` | PASS |
| `milady_official_3` | `scripts/r7-roster-milady_official_3-front.png` | `scripts/r7-roster-milady_official_3-side.png` | PASS |
| `milady_official_4` | `scripts/r7-roster-milady_official_4-front.png` | `scripts/r7-roster-milady_official_4-side.png` | PASS |
| `milady_official_5` | `scripts/r7-roster-milady_official_5-front.png` | `scripts/r7-roster-milady_official_5-side.png` | PASS |
| `milady_official_6` | `scripts/r7-roster-milady_official_6-front.png` | `scripts/r7-roster-milady_official_6-side.png` | PASS |
| `milady_official_7` | `scripts/r7-roster-milady_official_7-front.png` | `scripts/r7-roster-milady_official_7-side.png` | PASS |
| `milady_official_8` | `scripts/r7-roster-milady_official_8-front.png` | `scripts/r7-roster-milady_official_8-side.png` | PASS |
| `hermes_female` | `scripts/r7-roster-hermes_female-front.png` | `scripts/r7-roster-hermes_female-side.png` | PASS |
| `hermes_male` | `scripts/r7-roster-hermes_male-front.png` | `scripts/r7-roster-hermes_male-side.png` | PASS |
| `tekk` | `scripts/r7-roster-tekk-front.png` | `scripts/r7-roster-tekk-side.png` | PASS |
| `eliza_chibi` | `scripts/r7-roster-eliza_chibi-front.png` | `scripts/r7-roster-eliza_chibi-side.png` | PASS |
| `milady_chibi` | `scripts/r7-roster-milady_chibi-front.png` | `scripts/r7-roster-milady_chibi-side.png` | PASS |
| `hatcher_1` | `scripts/r7-roster-hatcher_1-front.png` | `scripts/r7-roster-hatcher_1-side.png` | PASS |
| `hatcher_2` | `scripts/r7-roster-hatcher_2-front.png` | `scripts/r7-roster-hatcher_2-side.png` | PASS |
| `hatcher_3` | `scripts/r7-roster-hatcher_3-front.png` | `scripts/r7-roster-hatcher_3-side.png` | PASS |
| `hatcher_4` | `scripts/r7-roster-hatcher_4-front.png` | `scripts/r7-roster-hatcher_4-side.png` | PASS |
| `hatcher_5` | `scripts/r7-roster-hatcher_5-front.png` | `scripts/r7-roster-hatcher_5-side.png` | PASS |
| `hatcher_6` | `scripts/r7-roster-hatcher_6-front.png` | `scripts/r7-roster-hatcher_6-side.png` | PASS |
| `hatcher_7` | `scripts/r7-roster-hatcher_7-front.png` | `scripts/r7-roster-hatcher_7-side.png` | PASS |
| `hatcher_8` | `scripts/r7-roster-hatcher_8-front.png` | `scripts/r7-roster-hatcher_8-side.png` | PASS |

## Additional screenshot list

Orbit close-ups: `scripts/audit-seat1-front.png`, `scripts/audit-seat1-side.png`, `scripts/audit-seat1-34high.png`, `scripts/audit-seat2-front.png`, `scripts/audit-seat2-side.png`, `scripts/audit-seat2-34high.png`, `scripts/audit-seat3-front.png`, `scripts/audit-seat3-side.png`, `scripts/audit-seat3-34high.png`, `scripts/audit-seat4-front.png`, `scripts/audit-seat4-side.png`, `scripts/audit-seat4-34high.png`, `scripts/audit-seat5-front.png`, `scripts/audit-seat5-side.png`, `scripts/audit-seat5-34high.png`.

Wide relationship views: `scripts/audit-wide-player-side.png`, `scripts/audit-wide-dealer-side.png`.

The 56 roster images are listed individually in the matrix above.

## Verification

| Check | Result |
|---|---|
| `bun run build` (repo root) | PASS — 9/9 packages |
| `apps/api: bunx tsc --noEmit --pretty false` | PASS — 0 errors |
| `apps/web: bunx tsc --noEmit --pretty false` | Expected baseline — 12 errors, none in Round-7 files |
| `apps/web: bun test` | Expected baseline — 52 pass / 4 verifier fixture failures |
| Cold restart `:3001` via `serve-3001.cmd` | PASS — HTTP 200 |
| `bun scripts/seat-orbit-audit.ts` | PASS — five stools, y=52 tops, y=70 rim, 80.8wu minimum arc |
| `bun scripts/seat-roster-audit.ts` | PASS — 28 selectable keys / 56 captures |
| Browser route/snapshot | PASS — `/cove/table`, Back to Cove + DEAL present |
| Browser runtime errors | 0 page errors; existing Three deprecation/compiler warnings and unauthenticated quest 401 warning remain |

## Structural calls and boundaries

- Target-seat isolation in roster captures removes visual ambiguity; the ordinary five-seat orbit remains the evidence for neighbor clearance.
- Non-humanoids are judged by readable upper silhouette rather than literal humanoid shoulders.
- Rigless profiles are data constants, not registry mutations; no world-avatar scale or animation behavior changes outside this room.
- `holdem-controller.ts`, wire shapes, dealer model/pose, API routes, agent action surface, settlement and vCLAW money paths are untouched.
- No Drei `Text`/`Billboard`, no `InstancedMesh+ShaderMaterial`, and no per-frame allocation were added.
- No deployment, staging mutation or push was performed.

## Unverifiable here

- No founder sign-off is claimed; this report and the local screenshots need the founder's eyes.
- Real-device Iris Xe behavior was not independently hardware-profiled in this pass. The production bundle rendered locally without page errors, and the implementation avoids the project's known Iris Xe hazards.
- The pre-existing room-shell black openings and Three/WebGL warnings visible in captures are outside Round 7.

PARITY: display-only restage. Human and connected/hosted-agent avatar selections use the same registry dispatch; settlement, agent API actions and vCLAW binding are unchanged.
