'use client';

import { useEffect, useState, useRef } from 'react';
import { getTopSpikes } from '@/lib/perf-tracker';

interface PerfStats {
  fps: number;
  /** Average frame time over the last sample window (ms). */
  frameAvg: number;
  /** WORST frame time in the last sample window (ms). Stutter signature. */
  frameMax: number;
  /** Number of long tasks (>50ms blocking on main thread) in last 1s. */
  longTasks: number;
  /** JS heap usage (Chrome only — undefined elsewhere). MB. */
  heapMB: number | null;
  draws: number;
  triangles: number;
  meshes: number;
  pipes: number;
  backend: string;
  /** Top named spike from perf-tracker (name + max ms in last second). */
  topSpike: { name: string; ms: number } | null;
  /** Rung-4 slice-C acceptance counters (vrm-loader → __W3D_PHASES):
   *  VRM parses that EXECUTED before the decorative release, split
   *  ambient/player. Acceptance: ambient 0, player ≤ 1. Null until the
   *  first parse stamps either key. */
  vrmPreReveal: { ambient: number; player: number } | null;
}

const INITIAL_STATS: PerfStats = {
  fps: 0,
  frameAvg: 0,
  frameMax: 0,
  longTasks: 0,
  heapMB: null,
  draws: 0,
  triangles: 0,
  meshes: 0,
  pipes: 0,
  backend: '—',
  topSpike: null,
  vrmPreReveal: null,
};

function fpsColor(fps: number): string {
  if (fps >= 45) return '#22c55e';
  if (fps >= 25) return '#eab308';
  return '#ef4444';
}

/**
 * Color frame max time. <16.7ms = 60fps target. >33ms = stutter visible.
 */
function frameMaxColor(ms: number): string {
  if (ms <= 17) return '#22c55e';
  if (ms <= 33) return '#eab308';
  return '#ef4444';
}

/**
 * Color long tasks. >5/sec = main thread blocked frequently.
 */
function longTaskColor(n: number): string {
  if (n === 0) return '#22c55e';
  if (n <= 3) return '#eab308';
  return '#ef4444';
}

/**
 * PerfHud — diagnostic overlay. Shows enough data to identify what kind of
 * perf problem you're looking at:
 *
 *   FPS              — display rate (rolling 500ms window)
 *   frameAvg         — average per-frame ms in the same window
 *   frameMax         — WORST frame in the window. If frameMax >> frameAvg → STUTTER
 *   longTasks        — main-thread tasks ≥50ms in the last 1s. Non-zero =
 *                      React reconciliation, GC pauses, or sync layout thrash
 *   heapMB           — JS heap (Chrome only). Watch for unbounded growth →
 *                      memory leak from per-frame allocations or unfreed refs
 *   draws / tris     — GPU work submitted per frame
 *   objs             — total mesh count in scene
 *   pipes            — unique shader pipelines/programs (high count = pipeline-state-bound)
 *   backend          — WebGL or WebGPU
 *
 * Reading recipe:
 *   - Low FPS, low frameMax (≈ 1000/fps), 0 longTasks → GPU-bound.
 *     Look at draws / tris / pipes / fragment shader cost.
 *   - Low FPS, frameMax >> frameAvg → STUTTER from periodic blocking.
 *     Look at longTasks count + when it spikes (camera move? NPC spawn?).
 *   - Low FPS + nonzero longTasks → main-thread is the bottleneck.
 *     Look at React reconciliation, useFrame allocations, or layout thrash.
 *   - heapMB climbing over time → memory leak. Look at allocations inside
 *     useFrame / scene.add without dispose.
 *
 * Dev/debug-only — show only when:
 *   - NODE_ENV !== 'production' (local + preview deploys), OR
 *   - URL has `?debug=1` / `?perf=1`
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

  // Long-task observer count, updated by PerformanceObserver in a ref so
  // the rAF loop can read + reset it each second without restarting the
  // observer.
  const longTaskCountRef = useRef(0);

  useEffect(() => {
    setEnabled(shouldRenderPerfHud());
  }, []);

  // PerformanceObserver: count main-thread tasks ≥50ms.
  useEffect(() => {
    if (!enabled) return;
    if (typeof PerformanceObserver === 'undefined') return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) longTaskCountRef.current++;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Some browsers throw on unknown entryTypes — ignore.
    }
    return () => observer?.disconnect();
  }, [enabled]);

  // rAF loop: count frames + per-frame durations, sample at 500ms cadence.
  useEffect(() => {
    if (!enabled) return;
    let rafId = 0;
    let lastSampleTime = performance.now();
    let lastFrameTime = performance.now();
    let frameCount = 0;
    let frameTimeSum = 0;
    let frameTimeMax = 0;
    // Long-task count over a SECOND (independent cadence from sample).
    let longTaskWindowStart = performance.now();

    const loop = (now: number) => {
      const dt = now - lastFrameTime;
      lastFrameTime = now;
      frameCount++;
      frameTimeSum += dt;
      if (dt > frameTimeMax) frameTimeMax = dt;

      if (now - lastSampleTime >= 500) {
        const elapsed = now - lastSampleTime;
        const fps = Math.round((frameCount * 1000) / elapsed);
        const frameAvg = frameCount > 0 ? frameTimeSum / frameCount : 0;
        const frameMax = frameTimeMax;

        // Reset long-task counter every 1s so the displayed number is
        // "long tasks per second", not "long tasks since page load".
        const longTasks = longTaskCountRef.current;
        if (now - longTaskWindowStart >= 1000) {
          longTaskCountRef.current = 0;
          longTaskWindowStart = now;
        }

        const heapMB =
          typeof (performance as any).memory?.usedJSHeapSize === 'number'
            ? Math.round(
                (performance as any).memory.usedJSHeapSize / (1024 * 1024),
              )
            : null;

        const state = (window as unknown as { __W3D?: any }).__W3D;
        let meshes = 0;
        let draws = 0;
        let triangles = 0;
        let pipes = 0;
        let backend = '—';
        if (state?.gl) {
          const gl = state.gl;
          const info = gl.info?.render;
          try {
            state.scene?.traverse?.((obj: { isMesh?: boolean }) => {
              if (obj?.isMesh) meshes++;
            });
          } catch {
            // ignore — scene might be mid-mutation
          }
          // 2026-05-11 — HUD was reading the wrong paths.
          // Three.js WebGPU exposes per-frame draws at `info.render.drawCalls`,
          // NOT `info.render.calls` (which is the cumulative renderer.render()
          // invocation count and grows forever). Fall back to `calls` only for
          // the legacy WebGL renderer where that's actually the right field.
          draws = (info as any)?.drawCalls ?? info?.calls ?? 0;
          triangles = info?.triangles ?? 0;
          // Pipeline cache for WebGPU lives at renderer._pipelines.caches (Map).
          // WebGL renderer uses gl.info.programs (array). Neither used to be
          // exposed via gl.info.render.pipelines — that path is always
          // undefined so the HUD has been showing 0 since launch.
          pipes =
            (gl as any)?._pipelines?.caches?.size ??
            (gl.info?.programs?.length ?? 0);
          backend = gl.isWebGPURenderer ? 'WebGPU' : 'WebGL';
        }

        // Pull the worst named spike from the rolling-window tracker.
        const spikes = getTopSpikes(1);
        const topSpike = spikes.length > 0
          ? { name: spikes[0].name, ms: Math.round(spikes[0].maxMs * 10) / 10 }
          : null;

        // Slice-C acceptance counters — stamped by vrm-loader into
        // __W3D_PHASES. Settled by reveal time; cheap to re-read each sample.
        let vrmPreReveal: PerfStats['vrmPreReveal'] = null;
        try {
          const phases = (window as any).__W3D_PHASES;
          const ambient = phases?.vrmPreRevealAmbientParses;
          const player = phases?.vrmPreRevealPlayerParses;
          if (typeof ambient === 'number' || typeof player === 'number') {
            vrmPreReveal = {
              ambient: typeof ambient === 'number' ? ambient : 0,
              player: typeof player === 'number' ? player : 0,
            };
          }
        } catch {
          // telemetry read never breaks the HUD
        }

        setStats({
          fps,
          frameAvg: Math.round(frameAvg * 10) / 10,
          frameMax: Math.round(frameMax * 10) / 10,
          longTasks,
          heapMB,
          draws,
          triangles,
          meshes,
          pipes,
          backend,
          topSpike,
          vrmPreReveal,
        });

        lastSampleTime = now;
        frameCount = 0;
        frameTimeSum = 0;
        frameTimeMax = 0;
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
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
      <span title="Average frame time in last 500ms window">
        <span style={{ color: '#fff' }}>{stats.frameAvg.toFixed(1)}</span>
        <span style={{ color: '#64748b' }}>/</span>
        <span style={{ color: frameMaxColor(stats.frameMax), fontWeight: 'bold' }}>
          {stats.frameMax.toFixed(1)}
        </span>
        <span style={{ color: '#64748b' }}> ms</span>
      </span>
      <span style={{ color: '#334155' }}>·</span>
      <span title="Main-thread tasks ≥50ms in last second (stutter / GC / reconcile pauses)">
        <span style={{ color: longTaskColor(stats.longTasks), fontWeight: 'bold' }}>
          {stats.longTasks}
        </span>{' '}
        lt/s
      </span>
      {stats.heapMB !== null && (
        <>
          <span style={{ color: '#334155' }}>·</span>
          <span title="JS heap MB (Chrome only)">
            <span style={{ color: '#fff' }}>{stats.heapMB}</span> MB
          </span>
        </>
      )}
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
      {stats.topSpike && (
        <>
          <span style={{ color: '#334155' }}>·</span>
          <span
            title="Top named spike captured by perf-tracker (measureSpike wraps in code)"
            style={{ color: frameMaxColor(stats.topSpike.ms) }}
          >
            <span style={{ fontWeight: 'bold' }}>{stats.topSpike.ms}</span>
            <span style={{ color: '#64748b' }}> ms</span>{' '}
            <span style={{ color: '#94a3b8' }}>{stats.topSpike.name}</span>
          </span>
        </>
      )}
      {stats.vrmPreReveal && (
        <>
          <span style={{ color: '#334155' }}>·</span>
          <span title="VRM parses executed BEFORE the decorative release (rung-4 slice-C acceptance: ambient 0 / player ≤1)">
            <span
              style={{
                color: stats.vrmPreReveal.ambient === 0 ? '#22c55e' : '#ef4444',
                fontWeight: 'bold',
              }}
            >
              {stats.vrmPreReveal.ambient}a
            </span>
            <span style={{ color: '#64748b' }}>/</span>
            <span
              style={{
                color: stats.vrmPreReveal.player <= 1 ? '#22c55e' : '#ef4444',
                fontWeight: 'bold',
              }}
            >
              {stats.vrmPreReveal.player}p
            </span>{' '}
            <span style={{ color: '#64748b' }}>vrm-pre</span>
          </span>
        </>
      )}
    </div>
  );
}
