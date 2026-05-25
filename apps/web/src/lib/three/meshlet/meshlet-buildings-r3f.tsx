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

        // v1.7 architecture: R3F renders the FULL scene first (sky + terrain +
        // NPCs + player + everything else) as normal — autoClear, scene
        // background, all default. Then our useFrame runs at HIGH renderPriority
        // (after R3F's auto-render is disabled), manually drives R3F's render
        // FIRST, then overlays the rasterizer LAST with transparent non-hit
        // pixels (alpha=0) so the R3F scene shows through where no building
        // is drawn. This is the cleanest compositing model and also means both
        // renders use the SAME camera state at the SAME instant in the rAF
        // tick → no 1-frame building-position lag during rotation.

        console.log('[MeshletBuildingsR3F] init complete — backend:',
          (renderer as any).backend?.constructor?.name,
          'isWebGPU:', (renderer as any).isWebGPURenderer);

        const _sc = (asset as any).sourceColors;
        if (_sc) {
          const colorPreview: string[] = [];
          for (let i = 0; i < _sc.length / 3; i++) {
            colorPreview.push(`#${i}: ${_sc[i*3].toFixed(2)},${_sc[i*3+1].toFixed(2)},${_sc[i*3+2].toFixed(2)}`);
          }
          console.log('[MeshletBuildingsR3F] sourceColors in asset:', colorPreview.join(' | '));
        } else {
          console.warn('[MeshletBuildingsR3F] asset has no sourceColors field!');
        }
        const r = new NaniteRasterizer(renderer, asset, {
          instanceCount: 1,
          staticInstanceData: new Float32Array([0, 0, 0, 1]),
          maxRasterSize: 16,
          instanceBoundingRadius: RING_BOUNDING_RADIUS,
          pixelErrorThreshold: 0, // force LOD 0 — proven 167 FPS in spike
          // v3: real textured rendering. The asset's textureArray is sampled
          // per-fragment at layer=sourceId (encoded in meshletId's high bits).
          materialMode: 1,
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

  // v1.8: HIGH renderPriority (10) — disables R3F's auto-render. We then
  // manually drive: 1) R3F scene first (with autoClear=true to clear+render),
  // 2) rasterizer overlay second WITH autoClear=false so its internal
  // quadMesh.render() doesn't wipe the scene we just rendered.
  const frameCountRef = useRef(0);
  useFrame((state) => {
    // 1. R3F scene — autoClear=true (default) clears swap chain then renders
    //    sky + terrain + NPCs + player + everything else.
    state.gl.render(state.scene, state.camera);

    // 2. Meshlet rasterizer overlay (transparent where no building drawn).
    //    MUST set autoClear=false before this — otherwise the rasterizer's
    //    internal quadMesh.render(renderer) call uses the renderer's current
    //    autoClear (true), which clears the framebuffer BEFORE drawing the
    //    transparent quad → wipes everything we just rendered.
    if (!readyRef.current || !rasterizerRef.current) return;
    frameCountRef.current += 1;
    const logThisFrame = frameCountRef.current === 1 ||
                         frameCountRef.current === 60 ||
                         frameCountRef.current === 300;
    const _prevAutoClear = (state.gl as any).autoClear;
    (state.gl as any).autoClear = false;
    try {
      rasterizerRef.current.render(
        state.camera as THREE.PerspectiveCamera,
        state.size.width,
        state.size.height,
      );
      if (logThisFrame) console.log('[MeshletBuildingsR3F] frame', frameCountRef.current, 'rasterizer overlay OK');
    } catch (err) {
      console.error('[MeshletBuildingsR3F] rasterizer render failed:', err);
    } finally {
      (state.gl as any).autoClear = _prevAutoClear;
    }
  }, 10);

  // No DOM output — we live entirely inside R3F's render loop.
  return null;
}
