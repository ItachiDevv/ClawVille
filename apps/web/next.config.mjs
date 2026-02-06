/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@legacyapp/shared',
    '@legacyapp/database',
    '@legacyapp/agent-runtime',
    '@legacyapp/agent-templates',
  ],
};

export default nextConfig;
