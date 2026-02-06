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
