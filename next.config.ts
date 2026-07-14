import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // heic-convert + libheif-js load a WASM decoder at runtime; keep them external
  // so the bundler doesn't mangle the wasm file resolution in the serverless fn.
  serverExternalPackages: ["heic-convert", "libheif-js"],
};

export default nextConfig;
