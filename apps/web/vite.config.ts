import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __NAMI_APP_VERSION__: JSON.stringify(appVersion.version),
  },
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3187",
    },
  },
  build: {
    sourcemap: true,
  },
});
