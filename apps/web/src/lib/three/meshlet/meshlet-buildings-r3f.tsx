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

/**
 * Render priority for the meshlet pass. Negative = runs BEFORE R3F's default
 * scene render (priority 0+). When ANY useFrame has a non-zero renderPriority,
 * R3F switches from "always auto-render scene at end of frame" to "manual" —
 * the highest-priority hook is expected to drive rendering. So with a single
 * negative-priority hook here, we ALSO need to render R3F's scene ourselves
 * after the rasterizer pass. See useFrame body for that explicit call.
 */
const MESHLET_RENDER_PRIORITY = -10;

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

        // Disable R3F's autoClear so the rasterizer's earlier-in-frame output
        // isn't cleared by R3F's later render pass. The rasterizer manages its
        // own framebuffer clearing internally.
        (renderer as any).autoClear = false;

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
    if (!readyRef.current || !rasterizerRef.current) {
      // While rasterizer is loading, still drive R3F's render (we suppressed
      // R3F's default render by claiming a renderPriority).
      state.gl.render(state.scene, state.camera);
      return;
    }
    try {
      // 1. Rasterizer pass — populates swap chain with building pixels
      rasterizerRef.current.render(
        state.camera as THREE.PerspectiveCamera,
        state.size.width,
        state.size.height,
      );
    } catch (err) {
      console.error('[MeshletBuildingsR3F] rasterizer render failed:', err);
    }
    // 2. R3F scene pass — terrain, NPCs, player VRM render on top of buildings.
    // autoClear=false is set in init so this doesn't wipe the rasterizer output.
    state.gl.render(state.scene, state.camera);
  }, MESHLET_RENDER_PRIORITY);

  // No DOM output — we live entirely inside R3F's render loop.
  return null;
}
