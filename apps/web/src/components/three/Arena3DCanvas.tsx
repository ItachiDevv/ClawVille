'use client';

import World3DCanvas from './World3DCanvas';

/**
 * Arena 3D Canvas — spectator-only view with free camera and combat FX.
 * Thin wrapper around the shared World3DCanvas.
 */
export default function Arena3DCanvas() {
  return <World3DCanvas mode="arena" />;
}
