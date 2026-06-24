'use client';

/**
 * ReefWaterTunerPanel — a dat.GUI-style live editor for the SURF ROAD water shader.
 *
 * DEV TOOL, mounted only on /preview/reef-race-v2. Sliders/toggles/colour pickers
 * write the `WATER_TUNING` singleton (`reef-water-tuning.ts`) in place; the water
 * shader + bloom pass read it every frame, so changes are LIVE with no recompile
 * and no Canvas re-render. Pair it with the preview's frame-time meter to find the
 * "no visual downgrade in frame time" sweet spot on the real Iris-Xe GPU.
 *
 * The "v1 baseline" button strips every round-2 feature (caustics/spray/mist/sets +
 * v1 palette + v1 amplitude) so you can A/B the committed round 2 against the
 * signed-off v1 and read the frame-time delta directly. "Copy values" dumps the
 * current config to the clipboard so the tuned numbers can be baked into the shader.
 *
 * This is a plain DOM overlay (NOT inside the Canvas) — it never touches the render
 * loop except through the singleton, and it carries no Iris-Xe draw cost.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  WATER_TUNING,
  applyV1Baseline,
  resetToRound2,
  snapshotTuning,
  type WaterTuningScalars,
} from '@/lib/three/activities/reef-race/reef-water-tuning';

type ScalarKey = keyof WaterTuningScalars;
type ColorKey = 'colorDeep' | 'colorShallow' | 'colorFoam' | 'skyHorizon' | 'skyZenith' | 'sunColor';

interface SliderDef {
  key: ScalarKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

// Round-2 feature-cost knobs (0 disables → instant frame-time A/B per feature).
const FEATURE_SLIDERS: SliderDef[] = [
  { key: 'waveAmp', label: 'Wave amplitude', min: 0, max: 2, step: 0.01 },
  { key: 'setStrength', label: 'Set envelope', min: 0, max: 1, step: 0.01 },
  { key: 'microAmt', label: 'Micro-normal', min: 0, max: 2, step: 0.01 },
  { key: 'causticAmt', label: 'Caustics', min: 0, max: 2, step: 0.01 },
  { key: 'sprayAmt', label: 'Crest spray', min: 0, max: 2, step: 0.01 },
  { key: 'mistAmt', label: 'Drifting mist', min: 0, max: 2, step: 0.01 },
  { key: 'foamAmt', label: 'Foam / whitecaps', min: 0, max: 2, step: 0.01 },
  { key: 'sunIntensity', label: 'Sun glint', min: 0, max: 2, step: 0.01 },
];

const BLOOM_SLIDERS: SliderDef[] = [
  { key: 'bloomStrength', label: 'Bloom strength', min: 0, max: 2, step: 0.01 },
  { key: 'bloomRadius', label: 'Bloom radius', min: 0, max: 1, step: 0.01 },
  { key: 'bloomThreshold', label: 'Bloom threshold', min: 0, max: 1, step: 0.01 },
];

const COLOR_ROWS: { key: ColorKey; label: string }[] = [
  { key: 'colorDeep', label: 'Deep' },
  { key: 'colorShallow', label: 'Shallow' },
  { key: 'colorFoam', label: 'Foam' },
  { key: 'skyHorizon', label: 'Sky horizon' },
  { key: 'skyZenith', label: 'Sky zenith' },
  { key: 'sunColor', label: 'Sun' },
];

// ─── styles (match the preview overlay idiom) ────────────────────────────────
const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 280,
  maxHeight: 'calc(100vh - 24px)',
  overflowY: 'auto',
  background: 'rgba(4,10,22,0.86)',
  color: '#bfe8ff',
  fontFamily: 'monospace',
  fontSize: 12,
  padding: '10px 12px',
  borderRadius: 6,
  zIndex: 30,
  userSelect: 'none',
  border: '1px solid #1c3a55',
};
const sectionHdr: React.CSSProperties = {
  color: '#6fb4d6',
  fontSize: 11,
  letterSpacing: 1,
  margin: '10px 0 4px',
  borderTop: '1px solid #1c3a55',
  paddingTop: 6,
};
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 };
const rowLabel: React.CSSProperties = { flex: '0 0 96px', color: '#9cc7dd' };
const valStyle: React.CSSProperties = { flex: '0 0 38px', textAlign: 'right', color: '#fff', fontWeight: 'bold' };
const btnStyle: React.CSSProperties = {
  background: '#0e2a4a',
  color: '#bfe8ff',
  border: '1px solid #3a8fd0',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 11,
  cursor: 'pointer',
  marginRight: 4,
  marginTop: 4,
};

function Slider({
  def,
  value,
  onChange,
}: {
  def: SliderDef;
  value: number;
  onChange: (k: ScalarKey, v: number) => void;
}) {
  const atDefault = Math.abs(value - 1) < 1e-6;
  return (
    <div style={rowStyle}>
      <span style={rowLabel}>{def.label}</span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(def.key, parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: atDefault ? '#3a8fd0' : '#ffb454' }}
      />
      <span style={{ ...valStyle, color: atDefault ? '#fff' : '#ffb454' }}>{value.toFixed(2)}</span>
    </div>
  );
}

export function ReefWaterTunerPanel() {
  const [open, setOpen] = useState(true);
  // `tick` forces a re-read of WATER_TUNING into the displayed controls after a
  // mutation (slider drag OR a preset button). The singleton is the source of
  // truth; React state here is display-only.
  const [, forceTick] = useState(0);
  const refresh = useCallback(() => forceTick((n) => n + 1), []);

  // WATER_TUNING is a SHARED module singleton the prod reef scene also reads. Reset
  // it to the committed round-2 defaults on mount (start clean even if a prior
  // preview visit in this same tab left it dirty) AND on unmount (so a same-tab SPA
  // nav from /preview to the prod game can't carry tuned values into prod water).
  // Codex review #5: closes the preview→prod singleton-leak path.
  useEffect(() => {
    resetToRound2();
    refresh();
    return () => resetToRound2();
  }, [refresh]);

  const setScalar = useCallback(
    (k: ScalarKey, v: number) => {
      WATER_TUNING[k] = v;
      refresh();
    },
    [refresh],
  );

  const setColor = useCallback(
    (k: ColorKey, hex: string) => {
      WATER_TUNING[k].set(hex);
      refresh();
    },
    [refresh],
  );

  const onCopy = useCallback(() => {
    const text = snapshotTuning();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    // Always log too, in case clipboard is blocked in the preview context.
    // eslint-disable-next-line no-console
    console.log('[reef water tuning]\n' + text);
  }, []);

  if (!open) {
    return (
      <button style={{ ...panelStyle, width: 'auto', cursor: 'pointer' }} onClick={() => setOpen(true)}>
        ◧ Water Tuner
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold', fontSize: 13, color: '#fff', letterSpacing: 1 }}>WATER TUNER</span>
        <button
          style={{ ...btnStyle, marginTop: 0, padding: '2px 7px' }}
          onClick={() => setOpen(false)}
          title="Collapse"
        >
          ✕
        </button>
      </div>
      <div style={{ color: '#456', fontSize: 10, marginTop: 2 }}>
        Live — watch Frame time (left). 1.00 = committed; orange = changed.
      </div>

      <div style={sectionHdr}>ROUND-2 FEATURES (0 = off)</div>
      {FEATURE_SLIDERS.map((d) => (
        <Slider key={d.key} def={d} value={WATER_TUNING[d.key]} onChange={setScalar} />
      ))}

      <div style={sectionHdr}>BLOOM</div>
      {BLOOM_SLIDERS.map((d) => (
        <Slider key={d.key} def={d} value={WATER_TUNING[d.key]} onChange={setScalar} />
      ))}

      <div style={sectionHdr}>COLOURS</div>
      {COLOR_ROWS.map(({ key, label }) => (
        <div key={key} style={rowStyle}>
          <span style={rowLabel}>{label}</span>
          <input
            type="color"
            value={'#' + WATER_TUNING[key].getHexString()}
            onChange={(e) => setColor(key, e.target.value)}
            style={{ flex: 1, height: 20, background: 'none', border: 'none', cursor: 'pointer' }}
          />
          <span style={{ ...valStyle, flex: '0 0 64px', color: '#9cc7dd' }}>
            #{WATER_TUNING[key].getHexString()}
          </span>
        </div>
      ))}

      <div style={sectionHdr}>PRESETS</div>
      <div>
        <button
          style={{ ...btnStyle, background: '#3a1e1e', borderColor: '#a05858' }}
          onClick={() => {
            applyV1Baseline();
            refresh();
          }}
          title="Strip all round-2 features → signed-off v1 water (A/B the frame-time delta)"
        >
          v1 baseline
        </button>
        <button
          style={btnStyle}
          onClick={() => {
            resetToRound2();
            refresh();
          }}
          title="Restore the committed round-2 look"
        >
          Reset → round 2
        </button>
        <button style={btnStyle} onClick={onCopy} title="Copy current values to clipboard + console">
          Copy values
        </button>
      </div>
    </div>
  );
}
