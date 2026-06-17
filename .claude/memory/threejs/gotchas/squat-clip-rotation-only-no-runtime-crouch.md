# Squat clip is rotation-only — a rigid-body translate cannot synthesize a crouch

**Set 2026-06-17 (S2 jump-anim). Cost ~3 failed fix iterations + fabricated numbers.**

## The asset fact (verify, don't assume)
`_emotes.glb#squat` is an **in-place bake**: the raw `mixamorigHips.position` track is a **flat constant** (`Y=104.226`, 2 keyframes, ZERO descent). The crouch is entirely in the leg/spine ROTATIONS, and they are WEAK — headless-measured foot rise at the deepest pose is only **~0.019 VRM-m ≈ 2.3 wu** for a 270wu Milady, and the hips never lower.

## Three fixes that FAILED (and why)
1. **`getSquatGroundLift` (preserve a hip-Y descent + lift group):** descent is 0 → returns 0 every frame → complete no-op. The squat renders identical to the position-stripped version (still the "midair squat": knees bend with the pelvis pinned at standing height → feet pull UP toward the body).
2. **Procedural `group.position.y -= crouchDepth` + foot-replant:** CANCELS. Lowering a rigid body sinks the feet; replanting them to the floor lifts the body back by the same amount → net body drop = the clip's own foot-rise only. `SQUAT_CROUCH_VRM_M` is irrelevant. **You cannot synthesize a crouch by translating a rigid body** — a crouch is the pelvis moving toward the feet, which only comes from leg-bend (the clip) or a leg-IK solver.
3. (Implicit) any "lower the hips" runtime hack hits the same wall.

## What actually works (direction fix)
**Foot-grounding:** after `animator.update()` poses the rotation-only crouch, read the lowest foot/toe world-Y and `group.position.y -= (lowestFootY - effectiveFloorY)` to plant that foot on the floor. Because the knee-bend lifts the feet, this LOWERS the body so it settles toward the planted feet = squat DOWN (correct direction, no midair tuck). **Depth == the clip's knee-bend** (~2.3wu here = shallow). A visibly deeper squat needs a **re-baked squat clip** (knee-bend + real root descent) or leg-IK — NOT a runtime body translate.
- Read foot world-Y AFTER `update()` + `group.updateMatrixWorld(true)` (the 2026-05-22 foot-anchor read it BEFORE → stale matrixWorld → diverging feedback loop). `getFootWorldYMin()` uses `getNormalizedBoneNode('leftFoot'|'rightFoot'|'leftToes'|'rightToes')` + a module-scope scratch `Vector3` (no per-frame alloc).

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
