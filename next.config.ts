import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // @react-pdf/renderer and its font/stream dependencies must stay CommonJS on the server.
  serverExternalPackages: ['@react-pdf/renderer', 'mongodb'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Content-Security-Policy is deliberately NOT set here. The admin iframe needs
          // `frame-ancestors` to name the shop, which is only known per-request (from the
          // `shop` query parameter), so middleware.ts owns that header. Two CSP headers
          // would be intersected by the browser and the stricter one would win.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]
  },
}

export default nextConfig
