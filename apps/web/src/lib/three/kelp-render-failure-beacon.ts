/**
 * Field-diagnostics beacon for kelp realm render failures.
 *
 * Every silent-void lane the realm can hit reports itself to
 * POST /api/kelp/render-failure (alert-only, anonymous, rate-limited
 * server-side) right before recovery UI shows or the page reloads, so the
 * team learns WHICH lane a field failure was — with the GPU renderer string —
 * instead of receiving an information-free black-screen screenshot.
 *
 * navigator.sendBeacon is preferred because three of the lanes reload the
 * page immediately after reporting; fetch(keepalive) is the fallback.
 */

export type KelpRenderFailureLane =
  | 'chunk-load-failed'
  | 'renderer-init-failed'
  | 'webgpu-unhealthy'
  | 'canvas-not-adopted'
  | 'device-lost';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

let reportedLanes: Set<string> | null = null;

function probeGpuString(): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as
      | WebGLRenderingContext
      | null;
    if (!gl) return 'no-webgl-context';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : '(unmasked renderer unavailable)';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer.slice(0, 240);
  } catch {
    return undefined;
  }
}

export function reportKelpRenderFailure(
  lane: KelpRenderFailureLane,
  detail?: string,
  backend?: 'webgpu' | 'webgl' | 'unknown',
): void {
  if (typeof window === 'undefined') return;
  reportedLanes ??= new Set();
  if (reportedLanes.has(lane)) return;
  reportedLanes.add(lane);
  try {
    const body = JSON.stringify({
      lane,
      detail: detail?.slice(0, 600),
      gpu: probeGpuString(),
      backend,
    });
    const url = `${API_BASE}/api/kelp/render-failure`;
    const sent = navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }));
    if (!sent) {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // Diagnostics must never break the page they diagnose.
  }
}

export function describeErrorForBeacon(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error).slice(0, 300);
}
