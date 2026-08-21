import { looksIntel } from './gpu-tier';

export type DeviceClass =
  | 'phone'
  | 'tablet'
  | 'desktop-low'
  | 'desktop-capable';

const DEVICE_CLASS_OVERRIDE_VALUES: ReadonlySet<DeviceClass> = new Set([
  'phone',
  'tablet',
  'desktop-low',
  'desktop-capable',
]);

function readDeviceClassOverride(): DeviceClass | null {
  try {
    const override = new URLSearchParams(window.location.search).get(
      'devclass',
    );
    return override !== null &&
      DEVICE_CLASS_OVERRIDE_VALUES.has(override as DeviceClass)
      ? (override as DeviceClass)
      : null;
  } catch {
    return null;
  }
}

function probeWebGlRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  } catch {
    return '';
  }
}

export function detectDeviceClass(): DeviceClass {
  if (typeof window === 'undefined') return 'desktop-capable';

  const override = readDeviceClassOverride();
  if (override) return override;

  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const hasMultipleTouchPoints =
    typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  const isTouch = coarsePointer || hasMultipleTouchPoints;

  if (isTouch) {
    const shortestScreenSide = Math.min(
      window.screen.width,
      window.screen.height,
    );
    return shortestScreenSide < 768 ? 'phone' : 'tablet';
  }

  return looksIntel(probeWebGlRenderer())
    ? 'desktop-low'
    : 'desktop-capable';
}

export interface WorldDeviceProfile {
  readonly shadows: boolean;
  readonly fpsCap: number | null;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly cameraFar: number;
  readonly npcLodFarDistSq: number;
  readonly springBoneLodOffset: number;
  readonly activeFullRateNpcMixers: number | null;
  readonly landKitMaxVisibleChunks: number;
  readonly landKitMaxDraws: number;
  readonly landKitMaxTriangles: number;
  readonly residentMountDistSq: number;
  readonly residentUnmountDistSq: number;
  readonly dprRange: readonly [number, number];
  readonly ambientGroundCover: boolean;
  readonly initialQualityTier: 0 | 1;
}

const PHONE_PROFILE: WorldDeviceProfile = {
  shadows: false,
  fpsCap: 30,
  fogNear: 2_600,
  fogFar: 6_000,
  // The world backdrop is scene.background (no enclosing dome). Its only
  // world-scale plane is fog-enabled terrain, so clipping after full fog does
  // not expose the moving dark-dome band caused by a far plane inside a shell.
  cameraFar: 6_400,
  npcLodFarDistSq: 2_600 * 2_600,
  springBoneLodOffset: 1,
  activeFullRateNpcMixers: 8,
  landKitMaxVisibleChunks: 2,
  landKitMaxDraws: 30,
  landKitMaxTriangles: 120_000,
  residentMountDistSq: 3_200 * 3_200,
  residentUnmountDistSq: 3_800 * 3_800,
  dprRange: [0.55, 0.7],
  ambientGroundCover: false,
  initialQualityTier: 1,
};

const TABLET_PROFILE: WorldDeviceProfile = {
  shadows: false,
  fpsCap: null,
  fogNear: 5_000,
  fogFar: 10_500,
  cameraFar: 11_500,
  npcLodFarDistSq: 3_600 * 3_600,
  springBoneLodOffset: 0,
  activeFullRateNpcMixers: null,
  landKitMaxVisibleChunks: 3,
  landKitMaxDraws: 60,
  landKitMaxTriangles: 250_000,
  residentMountDistSq: 4_600 * 4_600,
  residentUnmountDistSq: 5_200 * 5_200,
  dprRange: [0.55, 0.7],
  ambientGroundCover: false,
  initialQualityTier: 1,
};

const DESKTOP_LOW_PROFILE: WorldDeviceProfile = {
  shadows: true,
  fpsCap: null,
  fogNear: 5_000,
  fogFar: 10_500,
  cameraFar: 11_500,
  npcLodFarDistSq: 5_000 * 5_000,
  springBoneLodOffset: 0,
  activeFullRateNpcMixers: null,
  landKitMaxVisibleChunks: 4,
  landKitMaxDraws: 60,
  landKitMaxTriangles: 250_000,
  residentMountDistSq: 4_600 * 4_600,
  residentUnmountDistSq: 5_200 * 5_200,
  dprRange: [0.55, 0.7],
  ambientGroundCover: true,
  initialQualityTier: 1,
};

const DESKTOP_CAPABLE_PROFILE: WorldDeviceProfile = {
  ...DESKTOP_LOW_PROFILE,
  dprRange: [0.75, 1],
  initialQualityTier: 0,
};

export const WORLD_DEVICE_PROFILE: Readonly<
  Record<DeviceClass, WorldDeviceProfile>
> = {
  phone: PHONE_PROFILE,
  tablet: TABLET_PROFILE,
  'desktop-low': DESKTOP_LOW_PROFILE,
  'desktop-capable': DESKTOP_CAPABLE_PROFILE,
};

export const WORLD_DEVICE_CLASS = detectDeviceClass();
export const CURRENT_WORLD_DEVICE_PROFILE =
  WORLD_DEVICE_PROFILE[WORLD_DEVICE_CLASS];
