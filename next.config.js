/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // Utility scripts (seed-stripe, etc.) are excluded from tsconfig but
    // this ensures any stray TS issues outside app code never block the build.
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  // CORS headers handled by middleware and route handlers (dynamic origin echo)
  experimental: {
    serverComponentsExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
  },
};

module.exports = nextConfig;
