import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env.local') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@elizapets/shared',
    '@elizapets/database',
    '@elizapets/agent-runtime',
    '@elizapets/agent-templates',
  ],
};

export default nextConfig;
