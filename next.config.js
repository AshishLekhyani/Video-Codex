/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["fluent-ffmpeg", "ffmpeg-static"],
  },
};

export default nextConfig;
