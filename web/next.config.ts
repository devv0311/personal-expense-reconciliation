import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // web/ is a standalone package with its own lockfile inside the parent repo (ADR-0042) — pin
  // the workspace root here so Turbopack doesn't guess between the two lockfiles it finds.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
