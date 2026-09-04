import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `fileURLToPath`, not `.pathname` — this repo's own directory name has spaces and an "&",
    // and `.pathname` leaves those percent-encoded (e.g. "%20"), which Vite's resolver then
    // can't turn back into a real filesystem path.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
