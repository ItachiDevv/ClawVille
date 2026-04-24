'use client';

/**
 * SpectatorCamSelector — three-button camera-mode toggle for the
 * spectator overlay. Spec: frontend-spec.md §7.3 (Follow / Free / Action).
 *
 * Chunk #11 caveat: the underlying `<BumperShellsScene>` keeps a static
 * orthographic camera (Iris Xe perf invariant — see
 * `bumper-shells-config.ts` CAMERA_POSITION) and does NOT actually move
 * the camera based on the selected mode at this chunk. The selector is
 * still wired so spectators can EXPRESS their preference; the scene-side
 * camera follow / free-orbit / action-pick logic ships in a future
 * chunk paired with the 3da subagent. The label "(viewport stays fixed)"
 * makes that explicit so testers don't file bugs against the static cam.
 */

export type SpectatorCamMode = 'follow' | 'free' | 'action';

export interface SpectatorCamSelectorProps {
  mode: SpectatorCamMode;
  onChange: (next: SpectatorCamMode) => void;
  /** When true, hides the helper note explaining the camera stays static. */
  hideStaticNote?: boolean;
}

const MODES: ReadonlyArray<{
  id: SpectatorCamMode;
  label: string;
  glyph: string;
  hint: string;
}> = [
  { id: 'follow', label: 'Follow', glyph: '◎', hint: 'Track focused player' },
  { id: 'free',   label: 'Free',   glyph: '✦', hint: 'Orbit centroid'      },
  { id: 'action', label: 'Action', glyph: '⚔', hint: 'Server-picked target'},
];

export default function SpectatorCamSelector({
  mode,
  onChange,
  hideStaticNote = false,
}: SpectatorCamSelectorProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        pointerEvents: 'auto',
      }}
      role="radiogroup"
      aria-label="Spectator camera mode"
    >
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 3,
          borderRadius: 8,
          background: 'rgba(6, 13, 23, 0.85)',
          border: '1px solid rgba(0, 229, 255, 0.32)',
        }}
      >
        {MODES.map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-hud-interactive="true"
              onClick={() => {
                if (!active) onChange(m.id);
              }}
              title={m.hint}
              style={{
                flex: 1,
                minWidth: 70,
                padding: '6px 8px',
                background: active
                  ? 'linear-gradient(180deg, rgba(0, 229, 255, 0.22), rgba(0, 229, 255, 0.08))'
                  : 'transparent',
                border: active
                  ? '1px solid rgba(0, 229, 255, 0.6)'
                  : '1px solid transparent',
                borderRadius: 6,
                color: active ? '#e0f7ff' : 'rgba(226, 232, 240, 0.78)',
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                cursor: active ? 'default' : 'pointer',
                pointerEvents: 'auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                lineHeight: 1.05,
                boxShadow: active ? '0 0 10px rgba(0, 229, 255, 0.25)' : 'none',
                transition: 'background 120ms, box-shadow 120ms',
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }} aria-hidden>
                {m.glyph}
              </span>
              <span>{m.label}</span>
            </button>
          );
        })}
      </div>
      {!hideStaticNote && (
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 9,
            color: 'rgba(148, 163, 184, 0.7)',
            letterSpacing: '0.08em',
            textAlign: 'center',
          }}
        >
          (viewport stays fixed — chunk #12 wires camera motion)
        </span>
      )}
    </div>
  );
}
