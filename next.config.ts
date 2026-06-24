import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ioredis uses Node.js TCP sockets and must not be bundled for edge/browser.
  // All routes that use Redis must run under the Node.js runtime.
  serverExternalPackages: ['ioredis'],
};

export default nextConfig;
