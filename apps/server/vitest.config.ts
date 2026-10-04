import { defineConfig } from "vitest/config";

// light-my-request's inject() defaults every request's Host header to
// "localhost:80". The token-less Host allowlist in app.ts compares that header
// against the configured port, so tests must run with PORT=80 or every
// token-less route test would be rejected as a rebound authority. One knob
// here keeps all test files consistent without per-file env pinning.
//
// The suite legitimately includes work that slows down under load: libvips
// background normalization, MCP stdio child-process handshakes, and real-socket
// suites whose beforeAll imports the full app module graph. Vitest's 5s/10s
// defaults are calibrated for light tests, and when the whole suite runs with
// one fork per core (libvips alone oversubscribes every core) those budgets
// break: a saturated 24-core machine reproduced four timeout failures that all
// pass instantly in isolation. The budgets below keep ~3x headroom over the
// worst timings observed under that saturation.
export default defineConfig({
  test: {
    env: {
      PORT: "80",
    },
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
