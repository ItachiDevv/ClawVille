/**
 * gpu-tier.ts — runtime detection of low-end (Intel-integrated) GPUs.
 *
 * Used to gate expensive overdraw effects (caustic plane, volumetric
 * light rays, post-process passes) so the same scene runs at 60+ FPS on
 * a discrete-GPU laptop AND on an Iris Xe ultrabook. Discrete GPUs keep
 * the full visuals; Intel-integrated GPUs skip the heavy passes.
 *
 * Detection:
 *   - WebGL fallback: WEBGL_debug_renderer_info + UNMASKED_RENDERER_WEBGL.
 *   - WebGPU: renderer.backend.adapter.info.{vendor,architecture}.
 *
 * Both paths look for "intel" / "iris" / "uhd graphics" in the renderer
 * string. Heuristic — false positives are acceptable (slightly less
 * pretty visuals) but false negatives are NOT (lag the user reported).
 *
 * Defaults to `false` (capable GPU) when detection fails so capable
 * machines never lose visuals. The cost of detection-failed-on-Intel is
 * the laggy baseline the user already has.
 */

import * as THREE from 'three';

const INTEL_PATTERNS = [
  /\bintel\b/i,
  /\biris\b/i,
  /\buhd graphics\b/i,
  /\bhd graphics\b/i,
  /\bgma\b/i, // very old Intel GMA
  /adreno/i,
  /mali/i,
  /powervr/i,
  /apple gpu/i,
];

function looksIntel(s: string | null | undefined): boolean {
  if (!s) return false;
  return INTEL_PATTERNS.some((re) => re.test(s));
}

/**
 * Probe the WebGL fallback for the unmasked renderer string. Returns null
 * if the extension isn't available (some browsers strip it for privacy).
 */
function probeWebGL(gl: any): string | null {
  try {
    const ctx: WebGL2RenderingContext | WebGLRenderingContext | undefined =
      typeof gl.getContext === 'function' ? gl.getContext() : gl.context;
    if (!ctx) return null;
    const ext = ctx.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return null;
    return ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe the WebGPU adapter info if the renderer is WebGPU-backed.
 * Returns null if not WebGPU or info isn't populated yet.
 */
function probeWebGPU(gl: any): string | null {
  try {
    const adapter = gl?.backend?.adapter;
    const info = adapter?.info;
    if (!info) return null;
    // info shape: { vendor, architecture, device, description }
    return [info.vendor, info.architecture, info.device, info.description]
      .filter(Boolean)
      .join(' ');
  } catch {
    return null;
  }
}

export interface GpuTierInfo {
  /** Raw renderer string (joined for WebGPU). May be null. */
  renderer: string | null;
  /** True when the GPU appears to be Intel-integrated. */
  isIntel: boolean;
  /** True when the renderer is WebGPU-backed (vs the WebGL2 fallback). */
  isWebGPU: boolean;
}

export function detectGpuTier(gl: THREE.WebGLRenderer | unknown): GpuTierInfo {
  const isWebGPU =
    !!(gl as any)?.backend && typeof (gl as any).backend === 'object';
  const renderer = isWebGPU ? probeWebGPU(gl) : probeWebGL(gl);
  return {
    renderer,
    isIntel: looksIntel(renderer),
    isWebGPU,
  };
}

/**
 * Synchronous one-shot probe for choosing initial quality before the renderer
 * exists. Keep this conservative: a false positive only softens visuals a bit,
 * while a false negative can leave integrated/mobile GPUs below the FPS target.
 */
export function detectLowEndGpuClass(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return true;

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : '';
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return looksIntel(renderer) || isTouch;
  } catch {
    return false;
  }
}
