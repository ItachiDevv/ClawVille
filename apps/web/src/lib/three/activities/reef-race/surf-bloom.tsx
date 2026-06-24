'use client';

/**
 * surf-bloom.tsx — selective bloom post-process for the SURF ROAD neon glow.
 *
 * The neon rails + water crests (surf-ribbon.tsx) are emissive-bright
 * (toneMapped:false, colour ≈ #7af6ff). UnrealBloomPass with a brightness
 * THRESHOLD only blooms those bright pixels, leaving the darker water + void
 * untouched — a CHEAP selective glow that makes the ribbon read as a glowing
 * Rainbow-Road track floating in space.
 *
 * ─── Render-loop takeover (the R3F pattern) ──────────────────────────────────
 * Mounting an EffectComposer means WE drive the render. The canonical R3F way:
 *   useFrame(() => composer.render(), 1)
 * A POSITIVE priority makes R3F hand the render loop to us — it stops calling
 * its own `gl.render(scene, camera)` once any useFrame has priority > 0. So this
 * component fully replaces the default render with the composed (bloom) render.
 *
 * ─── Iris Xe budget ──────────────────────────────────────────────────────────
 * ONE extra pass (UnrealBloomPass), run at HALF the framebuffer resolution
 * (composer.setSize(w/2, h/2)) so the blur is cheap on the Iris Xe floor. Bloom
 * is the single post-process for the scene (0 → 1 pass). Strength/radius/
 * threshold are tuned conservatively (config BLOOM_*). If the floor dips below
 * 60 FPS this whole component can be removed with zero other changes (the rails
 * still render bright, just without the soft glow).
 *
 * NOTE: NO `OutputPass` after the bloom — the bloom output is written straight
 * to the screen; the RenderPass already produced an sRGB target via the
 * renderer's outputColorSpace. (If colours look washed, add OutputPass last.)
 *
 * Must be the LAST child in the scene tree so the composer captures everything.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
// three-stdlib is the repo's established, version-pinned source for jsm addons
// (the preview page imports OrbitControls from it). Using it for the
// postprocessing passes avoids any `three/examples/*` dual-three resolution
// ambiguity in this Bun workspace.
import { EffectComposer, RenderPass, UnrealBloomPass } from 'three-stdlib';

import { BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from './reef-race-config';
import { WATER_TUNING } from './reef-water-tuning';

export function SurfBloom() {
  const { gl, scene, camera, size } = useThree();

  // Hold the bloom pass so the per-frame loop can push the LIVE tuner values
  // (strength/radius/threshold) onto it. In prod (no tuner) WATER_TUNING stays at
  // the committed BLOOM_* defaults, so this writes the committed bloom each frame.
  const bloomRef = useRef<UnrealBloomPass | null>(null);

  // Build the composer once. Half-res bloom resolution for the Iris Xe budget.
  const composer = useMemo(() => {
    // EffectComposer is WebGLRenderer-only. The reef scene uses the plain
    // WebGLRenderer (import 'three', NOT 'three/webgpu') so this is safe; guard
    // anyway so a future WebGPU swap degrades gracefully (no bloom, no crash).
    if (!(gl as unknown as { isWebGLRenderer?: boolean }).isWebGLRenderer) {
      return null;
    }
    const c = new EffectComposer(gl as THREE.WebGLRenderer);
    c.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(size.width, size.height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    c.addPass(bloom);
    bloomRef.current = bloom;
    return c;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  // Keep the composer sized to the canvas (half-res internal for cheap blur).
  useEffect(() => {
    if (!composer) return;
    composer.setSize(size.width, size.height);
    // Half the device-pixel work on the bloom blur passes (cheap on Iris Xe).
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * 0.5);
    return () => {
      composer.dispose();
    };
  }, [composer, size.width, size.height]);

  // Positive priority → R3F yields the render loop to us; we render the composed
  // (bloom) frame instead of the default gl.render(scene, camera).
  useFrame(() => {
    const bloom = bloomRef.current;
    if (bloom) {
      // LIVE tuner: push current bloom params before rendering. UnrealBloomPass
      // reads these per-render, so no recompile needed.
      bloom.strength  = WATER_TUNING.bloomStrength;
      bloom.radius    = WATER_TUNING.bloomRadius;
      bloom.threshold = WATER_TUNING.bloomThreshold;
    }
    if (composer) composer.render();
    else gl.render(scene, camera); // graceful no-bloom fallback (e.g. WebGPU)
  }, 1);

  return null;
}
