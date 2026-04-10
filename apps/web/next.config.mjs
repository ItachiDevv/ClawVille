import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env.local') });

// Content Security Policy `frame-ancestors` directive — controls who can
// embed clawville.world/* in an iframe. Needed for the @clawville/app-clawville
// Milady plugin to mount the game inside Milady's viewer shell.
//
// Origins allowed:
//   'self'                  — normal same-origin rendering
//   https://*.clawville.world — our own subdomains
//   http(s)://localhost:*   — Milady local dev, our own Next.js dev server
//   http(s)://127.0.0.1:*   — same, for non-DNS loopback
//   electrobun:             — Milady desktop app (Electrobun shell)
//   capacitor:              — Milady iOS/Android app (Capacitor shell)
//   tauri:                  — Tauri-based hosts (future)
//   app:                    — generic packaged app scheme
//   file:                   — Electrobun packaged builds on some platforms
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://*.clawville.world " +
  'http://localhost:* https://localhost:* ' +
  'http://127.0.0.1:* https://127.0.0.1:* ' +
  'electrobun: capacitor: tauri: app: file:';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@clawville/shared',
    '@clawville/database',
    '@clawville/agent-runtime',
    '@clawville/agent-templates',
  ],
  // @elizaos/core + plugins use runtime dynamic imports (hook handlers) that
  // can't be statically analyzed by Turbopack/webpack. Keep them external at
  // runtime instead of bundling into server routes.
  serverExternalPackages: [
    '@elizaos/core',
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-sql',
    '@elizaos/plugin-solana',
    '@anthropic-ai/sdk',
  ],
  turbopack: {
    root: resolve(__dirname, '../..'),
  },
  // Allow embedding in Milady's viewer shell — set CSP frame-ancestors on
  // every route, and explicitly do NOT set X-Frame-Options (which would
  // override the CSP and force DENY in older browsers).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: FRAME_ANCESTORS },
        ],
      },
    ];
  },
};

export default nextConfig;
