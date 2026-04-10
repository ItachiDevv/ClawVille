import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env.local') });

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
};

export default nextConfig;
