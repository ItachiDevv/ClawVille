// @ts-nocheck
/**
 * <MeshletBuildingsR3F /> — in-tree R3F component that runs the meshlet
 * rasterizer as a high-priority useFrame hook so it renders into R3F's OWN
 * WebGPU swap-chain texture BEFORE R3F's end-of-frame scene render.
 *
 * Why in-tree instead of layered canvases:
 *   The first Phase B attempt mounted a separate <canvas> with its own
 *   WebGPURenderer underneath R3F's canvas. That broke /game?meshlets=1 —
 *   R3F's canvas rendered nothing visible. Suspected cause: two competing
 *   WebGPU adapter requests on the same page, or DOM stacking semantics
 *   that put the meshlet layer on top of (rather than underneath) R3F.
 *
 *   The proper architecture is what the original Three.js example does:
 *   ONE renderer, ONE swap chain. Multiple render passes per frame all
 *   write to the same WebGPU texture; the browser presents that texture
 *   on the next vsync.
 *
 *   useFrame's renderPriority lets us order passes within a single R3F
 *   frame. We pick a NEGATIVE priority so we run BEFORE R3F's default
 *   render pass (priority 0). Order per frame:
 *     1. Our useFrame: rasterizer.render() → fills swap-chain with buildings
 *     2. R3F default: gl.render(scene, camera) → adds terrain/NPCs/etc on top
 *
 *   Because R3F's render uses autoClear=true by default, it would CLEAR
 *   the rasterizer's output before drawing. So we set autoClear=false in
 *   onCreated (one-time), and accept that the rasterizer itself owns the
 *   clear (it clears as part of its compute setup).
 *
 *   Caveat: setting autoClear=false means R3F's scene.background (sky color)
 *   only paints on the first frame. We compensate by setting scene.background
 *   to null and letting the rasterizer's quad-mesh clear color provide the
 *   default world background.
 */
'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { NaniteRasterizer } from '@/lib/three/experimental/nanite-rasterizer';
import { useMergedBuildingsAsset } from './use-merged-buildings-asset';
import { RING_BOUNDING_RADIUS } from './buildings-manifest';

// NOTE: do NOT use useFrame renderPriority here. Setting renderPriority on
// any useFrame call disables R3F's automatic end-of-frame scene render — and
// while we tried calling gl.render(scene,camera) ourselves, something about
// that path left the canvas blank (probably autoClear / depth interaction
// in the WebGPU backend). Instead we use default-priority useFrame and rely
// on autoClearColor=false (with autoClear & autoClearDepth still TRUE) so
// R3F's normal end-of-frame render preserves the rasterizer's color output
// but still clears depth so the scene renders correctly. The fact that all
// renders within a single rAF tick share the same WebGPU swap-chain texture
// means rasterizer pixels + R3F scene pixels coexist on the canvas.

export default function MeshletBuildingsR3F() {
  const { gl, scene, camera, size } = useThree();
  const { asset, state } = useMergedBuildingsAsset();
  const rasterizerRef = useRef<NaniteRasterizer | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!asset || !gl) return;
    let cancelled = false;

    (async () => {
      try {
        const renderer = gl as unknown as THREE.WebGPURenderer;

        // Guard: rasterizer's TSL compute uses WGSL pointer-atomic syntax that
        // CANNOT compile to GLSL. If the renderer fell back to WebGL2 (low-end
        // GPU detect, iOS Safari, no WebGPU adapter), bail out silently rather
        // than flooding console with hundreds of shader compile errors and
        // rendering nothing. ?meshlets=1 SHOULD also force-WebGPU via the
        // FORCE_WEBGPU_OVERRIDE check in World3DCanvas, but defense-in-depth.
        const isWebGPU = (renderer as any).isWebGPURenderer === true &&
                         (renderer as any).backend?.constructor?.name !== 'WebGLBackend';
        if (!isWebGPU) {
          console.warn('[MeshletBuildingsR3F] renderer is not WebGPU — skipping rasterizer init. The rasterizer requires WebGPU; the WebGL fallback path is not supported.');
          return;
        }

        // Preserve rasterizer color output across R3F's auto-render, but let
        // R3F still clear depth + stencil so its scene renders correctly. With
        // depth NOT preserved, the scene won't depth-test against buildings (so
        // VRMs always composite over buildings — known v1 limitation, fix in v2
        // by also preserving depth + doing a single depth clear ourselves).
        (renderer as any).autoClearColor = false;

        const r = new NaniteRasterizer(renderer, asset, {
          instanceCount: 1,
          staticInstanceData: new Float32Array([0, 0, 0, 1]),
          maxRasterSize: 16,
          instanceBoundingRadius: RING_BOUNDING_RADIUS,
          pixelErrorThreshold: 0, // force LOD 0 — proven 167 FPS in spike
        });
        await r.init();
        if (cancelled) {
          r.dispose();
          return;
        }
        rasterizerRef.current = r;
        readyRef.current = true;
      } catch (err) {
        console.error('[MeshletBuildingsR3F] init failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      rasterizerRef.current?.dispose();
      rasterizerRef.current = null;
    };
  }, [gl, asset]);

  useFrame((state) => {
    if (!readyRef.current || !rasterizerRef.current) return;
    try {
      // Rasterizer pass — populates swap chain color with building pixels.
      // R3F's end-of-frame auto-render then adds terrain/NPCs/player on top
      // (autoClearColor=false set in init so color is preserved; depth is
      // still cleared by autoClear so the scene depth-tests within itself).
      rasterizerRef.current.render(
        state.camera as THREE.PerspectiveCamera,
        state.size.width,
        state.size.height,
      );
    } catch (err) {
      console.error('[MeshletBuildingsR3F] rasterizer render failed:', err);
    }
  });

  // No DOM output — we live entirely inside R3F's render loop.
  return null;
}
