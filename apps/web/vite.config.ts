import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// The attachment preview resolves pdf.js's CMaps/fonts/ICC profiles/wasm
// decoders from `public/pdfjs/`, staged by scripts/copy-pdfjs-assets.mjs. The
// guard below needs the installed version; fail config loading with an
// actionable message instead of a bare ENOENT when node_modules is incomplete.
function readPdfjsVersion(): string {
  for (const candidate of ["../../node_modules/pdfjs-dist/package.json", "../node_modules/pdfjs-dist/package.json"]) {
    try {
      return (JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      // Try the next hoisting layout.
    }
  }
  throw new Error("找不到 pdfjs-dist：先运行 npm install");
}

const pdfjsVersion = readPdfjsVersion();

// The splash logo ships inline as a data URL so the app page's splash paints
// the logo on its very first frame: an async <img src> re-fetches it after
// the desktop's native splash hands over, and the logo visibly blinks off and
// back on (install-test feedback).
const splashLogoDataUrl = `data:image/png;base64,${readFileSync(new URL("./public/splash-logo.png", import.meta.url)).toString("base64")}`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "nami-splash-logo-inline",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html.replace("__NAMI_SPLASH_LOGO_SRC__", splashLogoDataUrl);
        },
      },
    },
    {
      // npm scripts stage the pdf.js assets before building, but a bare
      // `npx vite build` bypasses them. Without this guard the build succeeds
      // and the packaged app 404s every CMap/wasm request at render time, which
      // is exactly the failure mode that is painful to diagnose. `apply: build`
      // keeps dev/test runs unaffected.
      name: "nami-pdfjs-assets-guard",
      apply: "build",
      buildStart() {
        let manifestVersion: string | undefined;
        try {
          const manifest = JSON.parse(readFileSync(new URL("./public/pdfjs/manifest.json", import.meta.url), "utf8")) as { version?: string };
          manifestVersion = manifest.version;
        } catch {
          manifestVersion = undefined;
        }
        if (manifestVersion !== pdfjsVersion) {
          throw new Error("pdfjs 资产缺失：先运行 npm run assets:pdfjs");
        }
      },
    },
  ],
  test: {
    setupFiles: ["./src/test-setup.ts"],
    // Heavy suites (overlayStacking CSS census, AgentWorkspace integration)
    // take 8-12s per file even on an idle machine; the 5s default testTimeout
    // turns any CPU oversubscription (builds, other test runs) into flaky
    // timeouts. Mirrors apps/server/vitest.config.ts: the ceiling only widens
    // the pass window, it does not weaken any assertion.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
  define: {
    __NAMI_APP_VERSION__: JSON.stringify(appVersion.version),
  },
  server: {
    strictPort: true,
    proxy: {
      "/api": {
        // NAMI_API_PORT lets the real-chain e2e run point the browser at an
        // isolated server (see playwright.real.config.ts) instead of whatever
        // happens to be on 3187 — which, during development, is the developer's
        // own mailbox. Tests must never read or mutate real local data.
        target: `http://127.0.0.1:${process.env.NAMI_API_PORT ?? "3187"}`,
        // The local API's token-less Host allowlist (apps/server/src/app.ts,
        // isTrustedTokenlessHost) only accepts this server's own loopback
        // authorities on the configured port (127.0.0.1:3187). http-proxy
        // forwards the browser's Host header untouched by default, so the
        // dev server's own authority (localhost:5173) reached the guard and
        // every /api call came back 403 under `npm run dev`. changeOrigin
        // rewrites Host to the target origin, which is exactly what the
        // allowlist expects.
        changeOrigin: true,
      },
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
