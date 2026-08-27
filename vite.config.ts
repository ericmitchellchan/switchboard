import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  // Tailwind serves PROJECT SURFACES only (src/styles/surfaces.css — utilities
  // + theme, no preflight); the shell's own chrome stays hand-written CSS.
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    // 1620, not Tauri's default 1420 — 1420 collides with every other Tauri
    // project's dev server (see the port-in-use conflict during the SWIT
    // table-render debug session).
    port: 1620,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1621,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        pip: "pip.html",
      },
    },
  },
}));
