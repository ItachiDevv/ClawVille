/**
 * Single source of the browser-origin allowlist used by both CORS and the
 * world-presence WebSocket upgrade gate.
 *
 * The raw startsWith checks intentionally preserve the prior CORS callback's
 * behavior, including accepting values such as `http://localhost:evil.com`.
 */
export function resolveAllowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim());
}

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (resolveAllowedOrigins().includes(origin)) return true;
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  if (origin === 'electrobun://localhost') return true;
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'tauri://localhost') return true;
  if (origin === 'app://localhost') return true;
  return false;
}
