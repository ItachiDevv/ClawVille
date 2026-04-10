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
  turbopack: {
    root: resolve(__dirname, '../..'),
  },
};

export default nextConfig;
