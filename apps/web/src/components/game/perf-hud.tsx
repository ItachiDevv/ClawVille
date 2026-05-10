'use client';

import { useEffect, useState } from 'react';

interface PerfStats {
  fps: number;
  draws: number;
  triangles: number;
  meshes: number;
  pipes: number;
  backend: string;
}

const INITIAL_STATS: PerfStats = {
  fps: 0,
  draws: 0,
  triangles: 0,
  meshes: 0,
  pipes: 0,
  backend: '—',
};

function fpsColor(fps: number): string {
  if (fps >= 45) return '#22c55e'; // green — smooth
  if (fps >= 25) return '#eab308'; // yellow — playable
  return '#ef4444'; // red — slow
}

/**
 * PerfHud — floating perf counter styled after the 3dref "Low Poly Builder"
 * HUD. Reads from the R3F state that World3DCanvas.onCreated exposes on
 * window.__W3D and samples at 2 Hz so the numbers are stable enough to read
 * while still updating often enough to reflect cuts we're making.
 *
 * FPS is computed from a rolling requestAnimationFrame counter so it reflects
 * what the display is actually showing. Draw calls + triangles come straight
 * from gl.info.render, which Three.js resets per-frame when info.autoReset is
 * on (the default).
 *
 * Observational only — never calls state.advance() or state.invalidate(), so
 * it can't interfere with R3F's native render loop.
 */
/**
 * Dev/debug-only — the HUD covers ~30% of mobile real estate and leaks
 * internal triangle/draw counts to end users. Show only when:
 *   - NODE_ENV !== 'production' (local + preview deploys), OR
 *   - URL has `?debug=1` / `?perf=1` (prod opt-in for shareable diagnostic).
 */
function shouldRenderPerfHud(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === '1' || params.get('perf') === '1';
}

export default function PerfHud() {
  const [enabled, setEnabled] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);

  // Resolve the dev/debug gate after mount — `window` isn't available
  // during SSR, and we don't want hydration mismatches.
  useEffect(() => {
    setEnabled(shouldRenderPerfHud());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let rafId = 0;
    let lastSampleTime = performance.now();
    let frameCount = 0;

    const loop = (now: number) => {
      frameCount++;
      if (now - lastSampleTime >= 500) {
        const state = (window as unknown as { __W3D?: any }).__W3D;
        const elapsed = now - lastSampleTime;
        const fps = Math.round((frameCount * 1000) / elapsed);

        if (state?.gl) {
          const gl = state.gl;
          const info = gl.info?.render;
          let meshes = 0;
          try {
            state.scene?.traverse?.((obj: { isMesh?: boolean }) => {
              if (obj?.isMesh) meshes++;
            });
          } catch {
            // ignore — scene might be mid-mutation
          }
          // Pipeline/program count: WebGL exposes programs array; WebGPU exposes
          // info.render.pipelines (numeric). High pipeline counts (>80) indicate
          // too many unique shader variants — diagnostic for A2 WebGL vs WebGPU comparison.
          const pipes: number =
            (gl.info?.render as any)?.pipelines ??
            (gl.info?.programs?.length) ??
            0;
          setStats({
            fps,
            draws: info?.calls ?? 0,
            triangles: info?.triangles ?? 0,
            meshes,
            pipes,
            backend: gl.isWebGPURenderer ? 'WebGPU' : 'WebGL',
          });
        } else {
          setStats((s) => ({ ...s, fps }));
        }
        lastSampleTime = now;
        frameCount = 0;
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      // Anchor top-left + allow wrap so FPS is always visible on mobile
      // (was top-4 right-20 + nowrap → bar overflowed left off-screen on
      // narrow viewports, hiding the FPS readout).
      className="fixed top-1 left-1 z-50 pointer-events-none select-none"
      style={{
        background: 'rgba(10, 22, 40, 0.85)',
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(56, 189, 248, 0.3)',
        borderRadius: 10,
        padding: '4px 10px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11,
        color: '#94a3b8',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 8px',
        maxWidth: 'calc(100vw - 8px)',
      }}
    >
      <span>
        <span style={{ color: fpsColor(stats.fps), fontWeight: 'bold' }}>
          {stats.fps}
        </span>{' '}
        FPS
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span>
        <span style={{ color: '#fff' }}>{stats.draws}</span> draws
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span>
        <span style={{ color: '#fff' }}>
          {(stats.triangles / 1000).toFixed(stats.triangles < 10_000 ? 1 : 0)}k
        </span>{' '}
        tris
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span>
        <span style={{ color: '#fff' }}>{stats.meshes}</span> objs
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span>
        <span style={{ color: '#fff' }}>{stats.pipes}</span> pipes
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span style={{ color: '#64748b' }}>{stats.backend}</span>
    </div>
  );
}
