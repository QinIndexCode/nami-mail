import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { AppBoundary } from "./ErrorBoundary";
import { installPerfTelemetry } from "./perfTelemetry";
import "./styles.css";

// Startup instrumentation. The desktop host forwards "[nami-startup]" console
// messages into its startup-log.jsonl with a single monotonic clock, so the
// renderer milestones can be correlated with the main-process and server ones.
// In a plain browser these lines are harmless debug output.
console.log("[nami-startup] renderer-bundle-start");

// Renderer performance telemetry: only slow operations (>50ms main-thread
// tasks, slow spans/api/commits) are recorded. `window.__namiPerf.report()`
// prints an aggregated summary for jank analysis.
installPerfTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <AppBoundary>
        <App />
      </AppBoundary>
    </I18nProvider>
  </StrictMode>,
);

window.requestAnimationFrame(() => console.log("[nami-startup] renderer-first-frame"));
