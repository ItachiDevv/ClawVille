'use client';

/**
 * ReefPhysicsTunerPanel — dat.GUI-style live editor for the surf DRIVING FEEL.
 *
 * DEV TOOL, mounted only on /preview/reef-race-v2?mode=drive alongside <ReefFreeDrive/>.
 * Sliders write the `REEF_PHYSICS_TUNING` singleton in place; the sandbox's fixed-step
 * prediction loop reads it every tick, so handling/drift/whip changes are LIVE while you
 * drive. "Copy values" dumps the dialed config to bake into reef-race-config.ts.
 *
 * Plain DOM overlay (not in the Canvas) — no render-loop cost.
 */

import { useCallback, useState } from 'react';
import {
  REEF_PHYSICS_TUNING,
  REEF_PHYSICS_DEFAULTS,
  resetReefPhysics,
  snapshotReefPhysics,
  type ReefPhysicsTuning,
} from '@/lib/three/activities/reef-race/reef-physics-tuning';

type Key = keyof ReefPhysicsTuning;
interface Def { key: Key; label: string; min: number; max: number; step: number; }

const HANDLING: Def[] = [
  { key: 'maxSpeed', label: 'Max speed', min: 100, max: 1200, step: 10 },
  { key: 'maxAccel', label: 'Acceleration', min: 200, max: 6000, step: 50 },
  { key: 'turnRate', label: 'Turn rate', min: 0.5, max: 6, step: 0.05 },
  { key: 'turnSpeedFalloff', label: 'Turn falloff', min: 0, max: 0.9, step: 0.01 },
  { key: 'forwardDrag', label: 'Forward drag', min: 0.95, max: 1, step: 0.001 },
  { key: 'lateralGrip', label: 'Lateral grip', min: 0.5, max: 1, step: 0.005 },
  { key: 'airborneSteerMult', label: 'Airborne steer', min: 0, max: 1, step: 0.01 },
  { key: 'boostMult', label: 'Boost mult', min: 1, max: 2.5, step: 0.01 },
];
const DRIFT: Def[] = [
  { key: 'driftTick1', label: 'Spark 1 (ticks)', min: 2, max: 30, step: 1 },
  { key: 'driftTick2', label: 'Spark 2 (ticks)', min: 5, max: 50, step: 1 },
  { key: 'driftTick3', label: 'Spark 3 (ticks)', min: 10, max: 80, step: 1 },
  { key: 'driftMinSpeedFrac', label: 'Min speed frac', min: 0, max: 0.6, step: 0.01 },
  { key: 'driftBoost1', label: 'Boost ×1', min: 1, max: 2.5, step: 0.01 },
  { key: 'driftBoost2', label: 'Boost ×2', min: 1, max: 2.5, step: 0.01 },
  { key: 'driftBoost3', label: 'Boost ×3', min: 1, max: 2.5, step: 0.01 },
  { key: 'driftBoostTicks', label: 'Boost dur (ticks)', min: 5, max: 120, step: 1 },
];
const WHIP: Def[] = [
  { key: 'whipSelfImpulse', label: 'Self recoil', min: 0, max: 400, step: 10 },
  { key: 'whipBumpImpulse', label: 'Bump force', min: 0, max: 900, step: 10 },
  { key: 'whipReach', label: 'Reach (wu)', min: 50, max: 600, step: 10 },
  { key: 'whipCooldownTicks', label: 'Cooldown (ticks)', min: 4, max: 90, step: 1 },
  { key: 'whipSwingTicks', label: 'Swing (ticks)', min: 2, max: 40, step: 1 },
];
const TRACK: Def[] = [
  { key: 'offtrackMargin', label: 'Off-track margin', min: 0, max: 800, step: 20 },
];
const VIEW: Def[] = [
  { key: 'kartScale', label: 'Board scale', min: 20, max: 220, step: 5 },
  { key: 'rideHeight', label: 'Ride height', min: -40, max: 100, step: 2 },
  { key: 'camBack', label: 'Cam back', min: 150, max: 1200, step: 20 },
  { key: 'camUp', label: 'Cam height', min: 100, max: 1300, step: 20 },
  { key: 'camAhead', label: 'Cam ahead', min: 0, max: 800, step: 20 },
];

const panelStyle: React.CSSProperties = {
  position: 'absolute', top: 12, right: 12, width: 270, maxHeight: 'calc(100vh - 24px)',
  overflowY: 'auto', background: 'rgba(4,10,22,0.86)', color: '#bfe8ff', fontFamily: 'monospace',
  fontSize: 12, padding: '10px 12px', borderRadius: 6, zIndex: 30, userSelect: 'none', border: '1px solid #1c3a55',
};
const sectionHdr: React.CSSProperties = { color: '#6fb4d6', fontSize: 11, letterSpacing: 1, margin: '10px 0 4px', borderTop: '1px solid #1c3a55', paddingTop: 6 };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 };
const rowLabel: React.CSSProperties = { flex: '0 0 104px', color: '#9cc7dd' };
const valStyle: React.CSSProperties = { flex: '0 0 46px', textAlign: 'right', fontWeight: 'bold' };
const btnStyle: React.CSSProperties = { background: '#0e2a4a', color: '#bfe8ff', border: '1px solid #3a8fd0', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer', marginRight: 4, marginTop: 4 };

function Slider({ def, onChange }: { def: Def; onChange: (k: Key, v: number) => void }) {
  const value = REEF_PHYSICS_TUNING[def.key];
  const atDefault = Math.abs(value - REEF_PHYSICS_DEFAULTS[def.key]) < 1e-9;
  const decimals = def.step < 0.1 ? (def.step < 0.01 ? 3 : 2) : 0;
  return (
    <div style={rowStyle}>
      <span style={rowLabel}>{def.label}</span>
      <input
        type="range" min={def.min} max={def.max} step={def.step} value={value}
        onChange={(e) => onChange(def.key, parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: atDefault ? '#3a8fd0' : '#ffb454' }}
      />
      <span style={{ ...valStyle, color: atDefault ? '#fff' : '#ffb454' }}>{value.toFixed(decimals)}</span>
    </div>
  );
}

export function ReefPhysicsTunerPanel() {
  const [open, setOpen] = useState(true);
  const [, tick] = useState(0);
  const refresh = useCallback(() => tick((n) => n + 1), []);
  const set = useCallback((k: Key, v: number) => { REEF_PHYSICS_TUNING[k] = v; refresh(); }, [refresh]);
  const onCopy = useCallback(() => {
    const text = snapshotReefPhysics();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
    // eslint-disable-next-line no-console
    console.log('[reef physics tuning]\n' + text);
  }, []);

  if (!open) {
    return <button style={{ ...panelStyle, width: 'auto', cursor: 'pointer' }} onClick={() => setOpen(true)}>◧ Physics Tuner</button>;
  }
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold', fontSize: 13, color: '#fff', letterSpacing: 1 }}>PHYSICS TUNER</span>
        <button style={{ ...btnStyle, marginTop: 0, padding: '2px 7px' }} onClick={() => setOpen(false)} title="Collapse">✕</button>
      </div>
      <div style={{ color: '#789', fontSize: 10, marginTop: 2 }}>
        A/D steer · auto-thrust · S brake · Shift drift · Space whip. Default = canonical; orange = changed.
      </div>
      <div style={sectionHdr}>HANDLING</div>
      {HANDLING.map((d) => <Slider key={d.key} def={d} onChange={set} />)}
      <div style={sectionHdr}>DRIFT MINI-TURBO</div>
      {DRIFT.map((d) => <Slider key={d.key} def={d} onChange={set} />)}
      <div style={sectionHdr}>BOARD-WHIP</div>
      {WHIP.map((d) => <Slider key={d.key} def={d} onChange={set} />)}
      <div style={sectionHdr}>TRACK</div>
      {TRACK.map((d) => <Slider key={d.key} def={d} onChange={set} />)}
      <div style={sectionHdr}>VIEW (board + camera)</div>
      {VIEW.map((d) => <Slider key={d.key} def={d} onChange={set} />)}
      <div style={sectionHdr}>PRESETS</div>
      <div>
        <button style={btnStyle} onClick={() => { resetReefPhysics(); refresh(); }} title="Restore canonical reef-race-config values">Reset</button>
        <button style={btnStyle} onClick={onCopy} title="Copy current values to clipboard + console">Copy values</button>
      </div>
    </div>
  );
}
