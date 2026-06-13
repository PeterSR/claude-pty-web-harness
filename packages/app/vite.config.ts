import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:4318";

// Resolve the workspace libs to their TS source so Vite transpiles them
// directly (no per-package build step needed for the demo).
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@claude-pty-harness/react": src("../react/src/index.ts"),
      "@claude-pty-harness/protocol": src("../protocol/src/index.ts"),
    },
  },
  server: {
    port: 4316,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
