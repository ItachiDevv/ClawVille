import { useState, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { Leva, useControls, button, folder } from 'leva';
import DrumRig from './DrumRig';
import HybridRig from './HybridRig';
import PlanarRig from './PlanarRig';
import { mockSpinResult } from './constants';
import type { SpinResult } from './types';

type RigKey = 'drum' | 'hybrid' | 'planar';

export default function App() {
  const [reels, setReels] = useState<SpinResult['reels'] | null>(null);
  const [spinTrigger, setSpinTrigger] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);

  const triggerSpin = useCallback(() => {
    setIsSpinning(true);
    setSpinTrigger((t) => t + 1);
    // Server-result arrives ~600ms after the press in real gameplay.
    setTimeout(() => {
      const result = mockSpinResult();
      setReels(result.reels);
    }, 600);
  }, []);

  const handleReelsSettled = useCallback(() => {
    setIsSpinning(false);
  }, []);

  // ── Live controls — Leva GUI panel docked top-right ────────────────────────
  const { rig, cameraType, showFx } = useControls({
    'Rig variant': folder({
      rig: {
        value: 'planar' as RigKey,
        options: { 'Planar (polished)': 'planar', 'Drum (3D)': 'drum', Hybrid: 'hybrid' },
      },
      cameraType: {
        value: 'ortho' as 'ortho' | 'perspective',
        options: { Orthographic: 'ortho', Perspective: 'perspective' },
      },
      showFx: { value: true, label: 'Show FX overlays' },
    }),
    Action: folder({
      SPIN: button(() => triggerSpin()),
    }),
  });

  // Camera config differs per rig variant — values are tuned-out
  // starting points. Leva exposes the underlying knobs in the rig file.
  const cameraConfig = rig === 'drum'
    ? { ortho: { left: -5, right: 5, top: 2.8, bottom: -2.8 }, persp: { fov: 35, z: 9 } }
    : rig === 'hybrid'
      ? { ortho: { left: -5, right: 5, top: 2.8, bottom: -2.8 }, persp: { fov: 30, z: 9 } }
      : { ortho: { left: -6.2, right: 6.2, top: 3.2, bottom: -3.2 }, persp: { fov: 38, z: 6 } };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Header strip */}
      <header
        style={{
          height: 56,
          padding: '0 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(0,255,224,0.18)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, transparent 100%)',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 13,
          letterSpacing: '0.06em',
        }}
      >
        <div>
          <strong style={{ color: '#00d4ff' }}>CLAWVILLE</strong>{' '}
          <span style={{ color: '#fdf6e3aa' }}>SLOT RIG PLAYGROUND</span>
        </div>
        <div style={{ color: '#fdf6e3aa' }}>
          {rig.toUpperCase()} · {cameraType} · {isSpinning ? 'spinning…' : 'idle'}
        </div>
      </header>

      {/* Canvas + Leva controls */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <Canvas
          dpr={[0.75, 1.5]}
          gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
          frameloop="always"
        >
          {/* Background colour — sets the modal-feel */}
          <color attach="background" args={['#062e3b']} />

          {cameraType === 'ortho' ? (
            <OrthographicCamera
              makeDefault
              position={[0, 0, 10]}
              near={0.1}
              far={30}
              left={cameraConfig.ortho.left}
              right={cameraConfig.ortho.right}
              top={cameraConfig.ortho.top}
              bottom={cameraConfig.ortho.bottom}
            />
          ) : (
            <PerspectiveCamera
              makeDefault
              position={[0, 0, cameraConfig.persp.z]}
              fov={cameraConfig.persp.fov}
              near={0.1}
              far={30}
            />
          )}

          {/* Mount the selected rig — props mirror SlotReels3DProps so a winning
              variant can be lifted into apps/web with zero contract changes. */}
          {rig === 'drum' && (
            <DrumRig
              reels={reels}
              isSpinning={isSpinning}
              spinTrigger={spinTrigger}
              onReelsSettled={handleReelsSettled}
              showFx={showFx}
            />
          )}
          {rig === 'hybrid' && (
            <HybridRig
              reels={reels}
              isSpinning={isSpinning}
              spinTrigger={spinTrigger}
              onReelsSettled={handleReelsSettled}
              showFx={showFx}
            />
          )}
          {rig === 'planar' && (
            <PlanarRig
              reels={reels}
              isSpinning={isSpinning}
              spinTrigger={spinTrigger}
              onReelsSettled={handleReelsSettled}
              showFx={showFx}
              onSpinClick={triggerSpin}
            />
          )}
        </Canvas>

        {/* Leva control panel — top-right by default */}
        <Leva
          collapsed={false}
          oneLineLabels
          theme={{
            colors: {
              elevation1: '#0a3a4a',
              elevation2: '#062e3b',
              accent2: '#00d4ff',
            },
          }}
        />
      </div>

      {/* Footer hint */}
      <footer
        style={{
          height: 36,
          padding: '0 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11,
          color: '#fdf6e3aa',
          borderTop: '1px solid rgba(0,255,224,0.10)',
        }}
      >
        Press <strong style={{ color: '#00d4ff' }}>SPIN</strong> in the panel to trigger an animation.
        Mock results — visual iteration only.
      </footer>
    </div>
  );
}
