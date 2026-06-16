import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Load sharp as a native external in route handlers (the /api/thumb proxy uses
  // it to transcode HEIC thumbnails — TikTok serves HEIC, which browsers can't
  // render — into browser-safe JPEG). Keeps the native binary out of the bundle.
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
