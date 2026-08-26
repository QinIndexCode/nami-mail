import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
  define: {
    __NAMI_APP_VERSION__: JSON.stringify(appVersion.version),
  },
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3187",
    },
  },
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Rolldown only accepts the function form. React is the only heavy
        // third-party group in the initial import graph; the rest (pdf.js,
        // jszip, mammoth, react-markdown, dialogs) is already code-split into
        // on-demand chunks. Keeping it separate gives the entry chunk a
        // stable, rarely-changed counterpart.
        manualChunks(id) {
          if (/[\\/]node_modules\/(react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
        },
      },
    },
  },
});
