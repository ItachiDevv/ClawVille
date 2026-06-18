# Squat clip is rotation-only — a rigid-body translate cannot synthesize a crouch

**Set 2026-06-17 (S2 jump-anim). Cost ~3 failed fix iterations + fabricated numbers.**

## The asset fact (verify, don't assume)
`_emotes.glb#squat` is an **in-place bake**: the raw `mixamorigHips.position` track is a **flat constant** (`Y=104.226`, 2 keyframes, ZERO descent). The crouch is entirely in the leg/spine ROTATIONS, and they are WEAK — headless-measured foot rise at the deepest pose is only **~0.019 VRM-m ≈ 2.3 wu** for a 270wu Milady, and the hips never lower.

## Three fixes that FAILED (and why)
1. **`getSquatGroundLift` (preserve a hip-Y descent + lift group):** descent is 0 → returns 0 every frame → complete no-op. The squat renders identical to the position-stripped version (still the "midair squat": knees bend with the pelvis pinned at standing height → feet pull UP toward the body).
2. **Procedural `group.position.y -= crouchDepth` + foot-replant:** CANCELS. Lowering a rigid body sinks the feet; replanting them to the floor lifts the body back by the same amount → net body drop = the clip's own foot-rise only. `SQUAT_CROUCH_VRM_M` is irrelevant. **You cannot synthesize a crouch by translating a rigid body** — a crouch is the pelvis moving toward the feet, which only comes from leg-bend (the clip) or a leg-IK solver.
3. (Implicit) any "lower the hips" runtime hack hits the same wall.

## What does NOT work — runtime foot-grounding ALSO failed (3rd dead end, 2026-06-18)
**Foot-grounding** (`group.position.y -= (getFootWorldYMin() - effectiveFloorY)` after update to plant the lowest foot) shipped to staging and **OSCILLATED ~per-frame between standing and half-sunk** (violent flicker). Codex review (thread 019ed912) corrected the mechanism: `group.updateMatrixWorld(true)` DOES refresh the normalized hierarchy (it's under `vrm.scene` under the group; `getWorldPosition` self-updates), so "stale read" was the WRONG diagnosis. Real faults: (1) `getFootWorldYMin()` reads the **NORMALIZED control rig** (`getNormalizedBoneNode`), not the **RAW skinned skeleton** the mesh actually renders from; (2) the animator monkey-patches `Skeleton.update` to a no-op + flushes manually, so a `group` transform applied AFTER that flush leaves the rendered skinning one phase out → oscillation. A "minimally correct" runtime version (read `getRawBoneNode`, re-flush skeletons after the group adjust) is possible but STILL only recovers the clip's ~2.3wu and adds fragility — **not worth it**.

## What actually works — RE-BAKE THE CLIP (the real fix)
Abandon runtime grounding entirely. Re-bake the `squat` Mixamo clip WITHOUT in-place (real hips-Y root descent + genuine knee flexion) → rebundle `_emotes.glb`, bumping `EMOTE_BUNDLE_VERSION` (vrm-character-animator.ts) AND `EMOTE_BUNDLE` (asset-preload-manifest.ts). `mixamo-retarget.ts` PRESERVES the hips-Y position track (zeros X/Z), so a clip with genuine root descent renders a true squat-down with NO runtime grounding. Keep `squat` OUT of `IN_PLACE_CLIPS`. **Interim until then:** squat-charge plays `'idle'` (avatar stands, movement still halted by `chargeMode`) — no glitch, no tuck.

## VERIFICATION PATTERN (this is the durable win) — headless VRM integration harness
You CAN parse + retarget + pose a VRM headlessly in bun, no browser, no GPU — use it to verify animation/grounding claims with REAL numbers instead of estimates:
```
// run from apps/web (so node_modules resolve)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { retargetMixamoClip } from './src/lib/three/mixamo-retarget.ts';      // imports only three + a type — clean standalone
import { computeVRMAvatarFit } from './src/lib/three/vrm-avatar-sizing.ts';
const l = new GLTFLoader(); l.register(p=>new VRMLoaderPlugin(p)); l.setMeshoptDecoder(MeshoptDecoder); // VRM+_emotes are meshopt
// parse VRM + _emotes from disk (readFileSync→ArrayBuffer→l.parse), retargetMixamoClip(emotes, vrm, 'squat'),
// new THREE.AnimationMixer(vrm.scene) + action.play() + mixer.setTime(t) + vrm.update?.(0) + scene.updateMatrixWorld(true),
// read bone world-Y from matrixWorld.elements[13] or getWorldPosition. Textures fail to load headless — harmless (skeleton/anim still pose).
```
Real `computeVRMAvatarFit(milady).scale ≈ 123` (NOT 270/1.6=168.75 — never assume native height = 1.6m).

## Process lesson
The 3da sub-agent (and its audit team) reported **fabricated** "verified" numbers (0.89→0.63 descent, 168.75 scale, "44wu lift") that the real asset contradicts — twice. NEVER relay an agent's grounding/animation numbers as verified; reproduce them with the headless harness. The hook-mandated "real testing" is what caught a no-op fix before it was signed off. See [[mixamo-retarget-rest-pose-transform]], [[pivot-not-at-feet-y-offset]].
