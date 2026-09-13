/**
 * Renderer performance telemetry.
 *
 * Records *only* operations whose measured duration exceeds a threshold, so a
 * normal session produces no output and a janky one leaves a trail of exactly
 * the frames that hurt. Every record lands in a bounded in-memory ring and on
 * the console with the `[nami-perf]` prefix (the desktop startup-log pipeline
 * already forwards prefixed renderer console lines, so the entries survive
 * into a log file for post-mortem analysis).
 *
 * Sinks:
 * - `beginSpan`/`trackSpan` — custom operation spans (list merge, optimistic
 *   batch apply, …). The suspected main-thread jank points.
 * - `markInterval` — the gap between two firings of the same mark name (e.g.
 *   how far apart two refresh passes landed). "操作间隔超过阈值" detection.
 * - `recordApiTiming` — one server round-trip (wired into api.ts `request`).
 * - `recordCommit` — a React commit (wired via <Profiler> around the list).
 * - `observeLongTasks` — the browser's own long-task observer (main thread
 *   blocked >50ms, whatever the cause).
 *
 * `window.__namiPerf` exposes the ring, a formatted report and the thresholds
 * at runtime; see `installPerfTelemetry`.
 */

export type PerfEntryKind = "slow-span" | "slow-interval" | "slow-api" | "slow-commit" | "long-task";

export type PerfEntry = {
  /** Epoch ms — correlate against other logs. */
  at: number;
  kind: PerfEntryKind;
  name: string;
  ms: number;
  detail?: Record<string, unknown>;
};

export type PerfThresholds = {
  /** Custom operation spans (merge, optimistic apply, …). */
  spanMs: number;
  /** Gap between consecutive marks of the same name. */
  intervalMs: number;
  /** One server round-trip. */
  apiMs: number;
  /** One React commit (actualDuration). */
  commitMs: number;
};

export const DEFAULT_PERF_THRESHOLDS: PerfThresholds = {
  spanMs: 200,
  intervalMs: 5_000,
  apiMs: 500,
  commitMs: 100,
};

/** Bounded so an unattended janky session cannot grow the heap. */
const RING_SIZE = 300;

let thresholds: PerfThresholds = { ...DEFAULT_PERF_THRESHOLDS };
let enabled = true;
const ring: PerfEntry[] = [];
const lastMarkAt = new Map<string, number>();

export function configurePerfTelemetry(next: Partial<PerfThresholds>): void {
  thresholds = { ...thresholds, ...next };
}

export function setPerfTelemetryEnabled(next: boolean): void {
  enabled = next;
}

export function perfEntries(): readonly PerfEntry[] {
  return ring;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function record(entry: PerfEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  // Round for readability; the raw entry keeps the exact value.
  const ms = Math.round(entry.ms * 10) / 10;
  console.info(`[nami-perf] ${entry.kind} ${entry.name} ${ms}ms`, entry.detail ?? "");
}

export type SpanFinisher = (detail?: Record<string, unknown>) => number;

/**
 * Starts a span; call the returned finisher when the operation ends. The
 * finisher returns the measured duration and records a `slow-span` entry when
 * it exceeded `spanMs`. Forgetting to call the finisher only loses one sample.
 */
export function beginSpan(name: string): SpanFinisher {
  const startedAt = monotonicNow();
  return (detail?: Record<string, unknown>) => {
    const ms = monotonicNow() - startedAt;
    if (enabled && ms >= thresholds.spanMs) {
      record({ at: Date.now(), kind: "slow-span", name, ms, detail });
    }
    return ms;
  };
}

/** Sync sugar over beginSpan for one-shot measurements. */
export function trackSpan<T>(name: string, fn: () => T, detail?: Record<string, unknown>): T {
  const finish = beginSpan(name);
  try {
    return fn();
  } finally {
    finish(detail);
  }
}

/**
 * Records a `slow-interval` entry when the gap since the previous mark with
 * the same name exceeded `intervalMs` — the "operations whose *interval* is
 * off" detector. The first firing of a name never records (there is no
 * baseline to compare against).
 */
export function markInterval(name: string, detail?: Record<string, unknown>): void {
  if (!enabled) return;
  const now = Date.now();
  const previous = lastMarkAt.get(name);
  lastMarkAt.set(name, now);
  if (previous === undefined) return;
  const ms = now - previous;
  if (ms >= thresholds.intervalMs) {
    record({ at: now, kind: "slow-interval", name, ms, detail });
  }
}

/** Wired into api.ts `request`; records round-trips over `apiMs`. */
export function recordApiTiming(path: string, ms: number, outcome: { status: number } | { error: string }): void {
  if (!enabled || ms < thresholds.apiMs) return;
  const detail = "status" in outcome
    ? { status: outcome.status }
    : { error: outcome.error };
  record({ at: Date.now(), kind: "slow-api", name: path, ms, detail });
}

/** React <Profiler onRender> sink; records commits over `commitMs`. */
export function recordCommit(id: string, actualDuration: number, phase: string): void {
  if (!enabled || actualDuration < thresholds.commitMs) return;
  record({ at: Date.now(), kind: "slow-commit", name: id, ms: actualDuration, detail: { phase } });
}

let longTaskObserver: PerformanceObserver | null = null;

/**
 * Observes main-thread long tasks (>50ms, the platform's own threshold).
 * Safe to call in environments without PerformanceObserver (jsdom tests):
 * it becomes a no-op there.
 */
export function observeLongTasks(): void {
  if (longTaskObserver || typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Longtask entries carry attribution, but the DOM typings only model
        // the base PerformanceEntry — read it best-effort through a narrow cast.
        const attribution = (entry as PerformanceEntry & { attribution?: Array<{ containerName?: string }> }).attribution;
        record({
          at: Date.now(),
          kind: "long-task",
          name: entry.name || "longtask",
          ms: entry.duration,
          detail: {
            container: attribution?.[0]?.containerName ?? undefined,
          },
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    longTaskObserver = observer;
  } catch {
    // Engine without longtask support — the other sinks still apply.
  }
}

/** Human-readable aggregation: count / max / avg per (kind, name). */
export function formatPerfReport(entries: readonly PerfEntry[] = ring): string {
  if (!entries.length) return "[nami-perf] no slow operations recorded";
  const groups = new Map<string, { kind: PerfEntryKind; count: number; total: number; max: number; last: PerfEntry }>();
  for (const entry of entries) {
    const key = `${entry.kind} ${entry.name}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.total += entry.ms;
      group.max = Math.max(group.max, entry.ms);
      group.last = entry;
    } else {
      groups.set(key, { kind: entry.kind, count: 1, total: entry.ms, max: entry.ms, last: entry });
    }
  }
  const lines = [...groups.entries()]
    .sort((left, right) => right[1].total - left[1].total)
    .map(([key, group]) => {
      const avg = Math.round(group.total / group.count);
      return `${key} — ×${group.count} max ${Math.round(group.max)}ms avg ${avg}ms (last ${new Date(group.last.at).toISOString()})`;
    });
  return [`[nami-perf] ${entries.length} slow operation(s):`, ...lines.map((line) => `  ${line}`)].join("\n");
}

export type PerfTelemetryHandle = {
  entries: () => readonly PerfEntry[];
  report: () => string;
  clear: () => void;
  thresholds: (next?: Partial<PerfThresholds>) => PerfThresholds;
  setEnabled: (next: boolean) => void;
};

/** Installs the long-task observer and the `window.__namiPerf` debug handle. */
export function installPerfTelemetry(): void {
  observeLongTasks();
  const target = globalThis as typeof globalThis & { __namiPerf?: PerfTelemetryHandle };
  target.__namiPerf ??= {
    entries: perfEntries,
    report: () => formatPerfReport(),
    clear: () => {
      ring.length = 0;
      lastMarkAt.clear();
    },
    thresholds: (next?: Partial<PerfThresholds>) => {
      if (next) configurePerfTelemetry(next);
      return thresholds;
    },
    setEnabled: setPerfTelemetryEnabled,
  };
}
