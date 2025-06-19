import type { NextConfig } from "next";
import dotenv from "dotenv";

dotenv.config();

const nextConfig: NextConfig = {
  // typescript: {
  //   ignoreBuildErrors: true,
  // },

  output: process.env.EXPORT_MODE === 'true' ? 'export' : 'standalone',
  trailingSlash: process.env.EXPORT_MODE === 'true' ? true : false,
  images: {
    domains: ['your-backend.com'],
    loader: 'custom',
    loaderFile: './src/utils/imageLoader.js',
  },
  async rewrites() {
    if (process.env.EXPORT_MODE === 'true') {
      return []
    }
    return [
      {
        source: '/api/:path*',
        destination: process.env.BACKEND_URL + '/:path*',
      }
    ]
  }
};

export default nextConfig;
