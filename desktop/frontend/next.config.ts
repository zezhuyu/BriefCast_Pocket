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
    domains: ['your-backend.com', 'picsum.photos'],
    loader: 'custom',
    loaderFile: './src/utils/imageLoader.js',
  },
};

export default nextConfig;
