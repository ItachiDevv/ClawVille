'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useNpcStream } from '@/hooks/use-npc-stream';
import {
  DEFAULT_WORLD_PERF_FLAGS,
  getCurrentPerfAudit,
  type PerfSceneAudit,
  type WorldPerfFlags,
} from '@/lib/three/PerfAudit';

const World3DCanvas = dynamic(() => import('@/components/three/World3DCanvas'), {
  ssr: false,
  loading: () => null,
});

function NpcStreamBridge() {
  useNpcStream();
  return null;
}

type TestId =
  | 'baseline'
  | 'labels-off'
  | 'npcs-off'
  | 'shadows-off'
  | 'fx-off'
  | 'resident-proxies'
  | 'post-off'
  | 'static-only';

interface TestResult {
  id: TestId;
  label: string;
  fps: number;
  delta: number;
  audit: PerfSceneAudit | null;
}

const TESTS: Array<{ id: TestId; label: string; flags: WorldPerfFlags }> = [
  { id: 'baseline', label: 'Baseline: everything on', flags: { ...DEFAULT_WORLD_PERF_FLAGS } },
  { id: 'labels-off', label: 'Test A: labels off', flags: { ...DEFAULT_WORLD_PERF_FLAGS, labels: false } },
  { id: 'npcs-off', label: 'Test B: NPCs off', flags: { ...DEFAULT_WORLD_PERF_FLAGS, npcs: false } },
  { id: 'shadows-off', label: 'Test C: shadows off', flags: { ...DEFAULT_WORLD_PERF_FLAGS, shadows: false } },
  {
    id: 'fx-off',
    label: 'Test D: decorative FX off',
    flags: { ...DEFAULT_WORLD_PERF_FLAGS, groundCover: false, activityFx: false },
  },
  {
    id: 'resident-proxies',
    label: 'Test E: far resident proxies',
    flags: { ...DEFAULT_WORLD_PERF_FLAGS, labels: false, residentDetail: false },
  },
  { id: 'post-off', label: 'Test F: postprocessing off', flags: { ...DEFAULT_WORLD_PERF_FLAGS, postprocessing: false } },
  {
    id: 'static-only',
    label: 'Test G: static world only',
    flags: {
      ...DEFAULT_WORLD_PERF_FLAGS,
      labels: false,
      npcs: false,
      waterFogParticles: false,
      groundCover: false,
      activityFx: false,
      residentDetail: false,
      staticWorldOnly: true,
      uiOverlay: false,
    },
  },
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sampleFps(durationMs: number): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    let start = 0;
    let raf = 0;
    const tick = (now: number) => {
      if (start === 0) start = now;
      frames++;
      if (now - start >= durationMs) {
        cancelAnimationFrame(raf);
        resolve(Math.round((frames * 1000) / (now - start)));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function FlagToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-200">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-cyan-400"
      />
    </label>
  );
}

export default function PerfPage() {
  const [flags, setFlags] = useState<WorldPerfFlags>({ ...DEFAULT_WORLD_PERF_FLAGS });
  const [audit, setAudit] = useState<PerfSceneAudit | null>(null);
  const [currentFps, setCurrentFps] = useState(0);
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Waiting for scene...');
  const latestFlagsRef = useRef(flags);
  const useLiveNpcStream =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('stream') === '1';

  latestFlagsRef.current = flags;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let count = 0;
    const tick = (now: number) => {
      count++;
      if (now - last >= 750) {
        setCurrentFps(Math.round((count * 1000) / (now - last)));
        count = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const next = getCurrentPerfAudit();
      if (next) {
        setAudit(next);
        (window as any).__CV_PERF_AUDIT = next;
        setStatus('Scene audit live');
      }
    }, 750);
    return () => window.clearInterval(interval);
  }, []);

  const setFlag = useCallback(<K extends keyof WorldPerfFlags>(key: K, value: WorldPerfFlags[K]) => {
    setFlags((prev) => {
      const next = { ...prev, [key]: value };
      if (key !== 'staticWorldOnly' && value === true && prev.staticWorldOnly) {
        next.staticWorldOnly = false;
      }
      return next;
    });
  }, []);

  const runTests = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResults([]);
    const original = latestFlagsRef.current;
    const measured: TestResult[] = [];
    let baselineFps = 0;

    for (const test of TESTS) {
      setStatus(`${test.label}: settling`);
      setFlags(test.flags);
      await wait(1800);
      setStatus(`${test.label}: sampling FPS`);
      const fps = await sampleFps(3000);
      const sceneAudit = getCurrentPerfAudit();
      if (test.id === 'baseline') baselineFps = fps;
      measured.push({
        id: test.id,
        label: test.label,
        fps,
        delta: test.id === 'baseline' ? 0 : fps - baselineFps,
        audit: sceneAudit,
      });
      setResults([...measured]);
    }

    setFlags(original);
    setStatus('Done. Restored manual toggles.');
    setRunning(false);
  }, [running]);

  const totals = audit?.totals;
  const renderer = audit?.renderer;
  const uiVisible = flags.uiOverlay || running;
  const targetRows = useMemo(() => [
    { label: 'Draw calls', current: renderer?.draws ?? 0, target: '< 100' },
    { label: 'Visible objs', current: totals?.visibleObjectCount ?? 0, target: '< 180' },
    { label: 'Triangles', current: renderer?.triangles ?? totals?.triangleCount ?? 0, target: 'track only' },
    { label: 'Labels', current: totals?.labelCount ?? 0, target: 'off in Test A' },
    { label: 'Label renders/sec', current: Math.round(totals?.labelReactRendersPerSec ?? 0), target: 'near 0 stable' },
  ], [renderer?.draws, renderer?.triangles, totals]);

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#061520] text-slate-100">
      {useLiveNpcStream && <NpcStreamBridge />}
      <World3DCanvas mode="game" perfFlags={flags} />

      {!uiVisible && (
        <button
          className="fixed right-3 top-3 z-50 rounded border border-cyan-400/50 bg-slate-950/80 px-3 py-2 text-xs text-cyan-200"
          onClick={() => setFlag('uiOverlay', true)}
        >
          Show perf UI
        </button>
      )}

      {uiVisible && (
        <section className="fixed left-3 top-3 z-50 flex max-h-[calc(100vh-24px)] w-[min(760px,calc(100vw-24px))] flex-col gap-3 overflow-y-auto rounded border border-cyan-400/30 bg-slate-950/90 p-4 text-xs shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-cyan-100">ClawVille Perf Audit</h1>
              <p className="mt-1 text-slate-400">
                {status} · current rAF {currentFps} FPS · renderer {renderer?.backend ?? '-'} · NPC stream {useLiveNpcStream ? 'live' : 'demo'}
              </p>
            </div>
            <button
              onClick={runTests}
              disabled={running}
              className="rounded bg-cyan-500 px-3 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Running...' : 'Run A-G'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <FlagToggle label="1. labels" checked={flags.labels} onChange={(v) => setFlag('labels', v)} />
            <FlagToggle label="2. NPCs" checked={flags.npcs} onChange={(v) => setFlag('npcs', v)} />
            <FlagToggle label="3. shadows" checked={flags.shadows} onChange={(v) => setFlag('shadows', v)} />
            <FlagToggle label="4. postprocessing" checked={flags.postprocessing} onChange={(v) => setFlag('postprocessing', v)} />
            <FlagToggle label="5. fog" checked={flags.waterFogParticles} onChange={(v) => setFlag('waterFogParticles', v)} />
            <FlagToggle label="6. ground cover" checked={flags.groundCover} onChange={(v) => setFlag('groundCover', v)} />
            <FlagToggle label="7. activity FX" checked={flags.activityFx} onChange={(v) => setFlag('activityFx', v)} />
            <FlagToggle label="8. resident detail" checked={flags.residentDetail} onChange={(v) => setFlag('residentDetail', v)} />
            <FlagToggle label="9. static world only" checked={flags.staticWorldOnly} onChange={(v) => setFlag('staticWorldOnly', v)} />
            <FlagToggle label="10. UI overlay" checked={flags.uiOverlay} onChange={(v) => setFlag('uiOverlay', v)} />
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {targetRows.map((row) => (
              <div key={row.label} className="rounded border border-slate-800 bg-slate-900/75 p-2">
                <div className="text-slate-400">{row.label}</div>
                <div className="mt-1 text-lg font-semibold text-white">{formatK(row.current)}</div>
                <div className="text-slate-500">target {row.target}</div>
              </div>
            ))}
          </div>

          {results.length > 0 && (
            <div className="rounded border border-slate-800">
              <div className="border-b border-slate-800 px-3 py-2 font-semibold text-slate-200">FPS Delta Tests</div>
              <table className="w-full border-collapse text-left">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Test</th>
                    <th className="px-3 py-2">FPS</th>
                    <th className="px-3 py-2">Delta</th>
                    <th className="px-3 py-2">Draws</th>
                    <th className="px-3 py-2">Objs</th>
                    <th className="px-3 py-2">Labels</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row) => (
                    <tr key={row.id} className="border-t border-slate-900">
                      <td className="px-3 py-2 text-slate-200">{row.label}</td>
                      <td className="px-3 py-2 text-white">{row.fps}</td>
                      <td className={row.delta >= 0 ? 'px-3 py-2 text-emerald-300' : 'px-3 py-2 text-red-300'}>
                        {row.id === 'baseline' ? '-' : `${row.delta >= 0 ? '+' : ''}${row.delta}`}
                      </td>
                      <td className="px-3 py-2">{row.audit?.renderer.draws ?? '-'}</td>
                      <td className="px-3 py-2">{row.audit?.totals.visibleObjectCount ?? '-'}</td>
                      <td className="px-3 py-2">{row.audit?.totals.labelCount ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {audit && (
            <>
              <div className="rounded border border-slate-800">
                <div className="border-b border-slate-800 px-3 py-2 font-semibold text-slate-200">Scene Chunks</div>
                <table className="w-full border-collapse text-left">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Chunk</th>
                      <th className="px-3 py-2">Draws</th>
                      <th className="px-3 py-2">Meshes</th>
                      <th className="px-3 py-2">Materials</th>
                      <th className="px-3 py-2">Textures</th>
                      <th className="px-3 py-2">Tris</th>
                      <th className="px-3 py-2">Skinned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.chunks.map((chunk) => (
                      <tr key={chunk.name} className="border-t border-slate-900">
                        <td className="px-3 py-2 text-slate-200">{chunk.name}</td>
                        <td className="px-3 py-2">{chunk.draws}</td>
                        <td className="px-3 py-2">{chunk.meshCount}</td>
                        <td className="px-3 py-2">{chunk.materialCount}</td>
                        <td className="px-3 py-2">{chunk.textureCount}</td>
                        <td className="px-3 py-2">{formatK(chunk.triangleCount)}</td>
                        <td className="px-3 py-2">{chunk.skinnedMeshCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="rounded border border-slate-800">
                <div className="border-b border-slate-800 px-3 py-2 font-semibold text-slate-200">
                  Top 20 Objects by Tris / Materials / Draws
                </div>
                <table className="w-full border-collapse text-left">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Object</th>
                      <th className="px-3 py-2">Chunk</th>
                      <th className="px-3 py-2">Draws</th>
                      <th className="px-3 py-2">Materials</th>
                      <th className="px-3 py-2">Textures</th>
                      <th className="px-3 py-2">Tris</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.topObjects.map((obj) => (
                      <tr key={obj.uuid} className="border-t border-slate-900">
                        <td className="max-w-[280px] truncate px-3 py-2 text-slate-200" title={obj.path}>
                          {obj.name}
                        </td>
                        <td className="px-3 py-2">{obj.chunk}</td>
                        <td className="px-3 py-2">{obj.draws}</td>
                        <td className="px-3 py-2">{obj.materialCount}</td>
                        <td className="px-3 py-2">{obj.textureCount}</td>
                        <td className="px-3 py-2">{formatK(obj.triangleCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
