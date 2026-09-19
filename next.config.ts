import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  serverExternalPackages: ["fluent-ffmpeg", "ffmpeg-static"],
};

export default nextConfig;
