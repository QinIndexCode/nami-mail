import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Startup/shutdown timing and crash logging for the packaged app.
 *
 * Electron writes nothing to disk by default and the local service runs inside
 * this same process, so a field failure used to leave no evidence at all (pino
 * only ever reached stdout). Three bounded files land in userData:
 *
 * - `startup-timings.json` — the last launch's stage list, overwritten nightly;
 * - `startup-log.jsonl`    — every recorded stage across launches (append);
 * - `runtime-log.jsonl`    — crashes, unhandled rejections, renderer/child
 *                            terminations and mirrored console output.
 *
 * Every write is best-effort: diagnostics must never break boot, and a
 * read-only profile is not an error worth surfacing.
 */

export type StartupLogOrigin = "main" | "server" | "renderer";

export type StartupTiming = {
  stage: string;
  elapsedMs: number;
};

export const startupLogMaxLines = 2000;
export const runtimeLogMaxLines = 500;
export const runtimeLogMaxMessageChars = 512;

/**
 * Kill switch for appending (a packaged install that wants no diagnostic file
 * growth): `NAMI_MAIL_NO_STARTUP_LOG=1`. Read on every append so a value that
 * arrives later via nami-mail.env still takes effect; pruning is deliberately
 * NOT gated, so an old oversized file is trimmed back even when appends stop.
 */
export function isDesktopStartupLogDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NAMI_MAIL_NO_STARTUP_LOG === "1";
}

function appendBoundedLine(target: string | undefined, line: string): boolean {
  if (!target) return false;
  try {
    appendFileSync(target, `${line}\n`, "utf8");
    return true;
  } catch {
    // Log capture is best-effort; it must never break the app.
    return false;
  }
}

/** Trims a JSONL file to its trailing window; every line stands alone. */
function pruneBoundedFile(target: string | undefined, maxLines: number): void {
  if (!target) return;
  try {
    if (!existsSync(target)) return;
    const lines = readFileSync(target, "utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= maxLines) return;
    writeFileSync(target, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
  } catch {
    // Pruning is best-effort.
  }
}

export function safeStringifyLogValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatConsoleArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => (arg instanceof Error ? arg.message : typeof arg === "string" ? arg : safeStringifyLogValue(arg)))
    .join(" ");
}

export function serializeRuntimeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return { message: typeof value === "string" ? value : safeStringifyLogValue(value) };
}

export class DesktopDiagnostics {
  private readonly startedAt: number;
  private readonly startupTimings: StartupTiming[] = [];
  private startupTimingsPath: string | undefined;
  private startupLogPath: string | undefined;
  private runtimeLogPath: string | undefined;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
  }

  /** Wall-clock start of this process, for stage deltas recorded elsewhere. */
  get processStartedAt(): number {
    return this.startedAt;
  }

  /** Milliseconds since this process started. */
  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Points the three files at the user's data directory and bounds the old ones. */
  initialize(userDataPath: string): void {
    this.startupTimingsPath = path.join(userDataPath, "startup-timings.json");
    this.startupLogPath = path.join(userDataPath, "startup-log.jsonl");
    this.runtimeLogPath = path.join(userDataPath, "runtime-log.jsonl");
    pruneBoundedFile(this.runtimeLogPath, runtimeLogMaxLines);
  }

  appendStartupLog(stage: string, elapsedMs: number, origin: StartupLogOrigin = "main"): void {
    if (isDesktopStartupLogDisabled()) return;
    // Each line is self-contained: {"t":"..","ms":1234,"pid":"main","stage":".."}
    appendBoundedLine(this.startupLogPath, JSON.stringify({ t: new Date().toISOString(), ms: elapsedMs, pid: origin, stage }));
  }

  pruneStartupLog(): void {
    pruneBoundedFile(this.startupLogPath, startupLogMaxLines);
  }

  appendRuntimeLog(event: string, detail: Record<string, unknown> = {}): void {
    if (isDesktopStartupLogDisabled()) return;
    const message = typeof detail.message === "string" ? detail.message.slice(0, runtimeLogMaxMessageChars) : undefined;
    const stack = typeof detail.stack === "string" ? detail.stack.slice(0, runtimeLogMaxMessageChars) : undefined;
    appendBoundedLine(
      this.runtimeLogPath,
      JSON.stringify({
        t: new Date().toISOString(),
        event,
        ...detail,
        ...(message ? { message } : {}),
        ...(stack ? { stack } : {}),
      }),
    );
  }

  recordStartupTiming(stage: string, elapsedMs?: number): void {
    const value = elapsedMs ?? this.elapsedMs;
    this.startupTimings.push({ stage, elapsedMs: value });
    this.appendStartupLog(stage, value, "main");
    const target = this.startupTimingsPath;
    if (!target) return;
    try {
      writeFileSync(
        target,
        JSON.stringify({ startedAt: new Date(this.startedAt).toISOString(), timings: this.startupTimings }, null, 2),
        "utf8",
      );
    } catch {
      // Timing capture is best-effort; a read-only profile must not break boot.
    }
  }
}

export type EventLoopDelaySnapshot = {
  samples: number;
  maxMs: number;
  meanMs: number;
};

/**
 * Event-loop delay of this process, sampled every 10ms.
 *
 * A slow stage and a blocked main thread look identical from stage timings
 * alone: every stage after the block is late, and a relay that is alive but
 * never reaches `ready` from the caller's side can be either. This sampler
 * expects a tick every resolution and records how late it actually arrives, so
 * `maxMs` proves a blocked loop while stage timings stay small, and
 * `meanMs` separates one long block (high max, near-zero mean) from a loop
 * that is generally saturated (both high).
 *
 * Implemented with a self-rescheduled timer instead of
 * `perf_hooks.monitorEventLoopDelay` because the built-in histogram treats the
 * first tick after `reset()` as its baseline: a block that starts at the reset
 * moment — exactly the relay start window — would never be recorded. Here the
 * first deadline is set at `start()`/`reset()`, so that block is measured.
 *
 * Reported as named numbers rather than histogram buckets because both sinks
 * are flat text — `desktop-smoke.json` and the relay's one-line ready
 * diagnostic (mirrored into `runtime-log.jsonl`) — where buckets would make
 * runs harder to compare with grep.
 */
export class DesktopEventLoopDelayProbe {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expectedAtMs = 0;
  private samples = 0;
  private totalMs = 0;
  private maxMs = 0;

  /** Idempotent; safe to call before Electron is ready. Returns `this` for inline use. */
  start(): this {
    if (this.timer) return this;
    this.expectedAtMs = performance.now() + eventLoopDelayResolutionMs;
    this.schedule();
    return this;
  }

  /** Starts a fresh window; callers snapshot the previous one first. */
  reset(): void {
    this.samples = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.expectedAtMs = performance.now() + eventLoopDelayResolutionMs;
    if (!this.timer) this.schedule();
  }

  snapshot(): EventLoopDelaySnapshot {
    if (this.samples === 0) return { samples: 0, maxMs: 0, meanMs: 0 };
    return {
      samples: this.samples,
      maxMs: toDelayMilliseconds(this.maxMs),
      meanMs: toDelayMilliseconds(this.totalMs / this.samples),
    };
  }

  private schedule(): void {
    const timer = setTimeout(() => this.sample(), eventLoopDelayResolutionMs);
    // Diagnostics must never keep the app alive on their own.
    timer.unref();
    this.timer = timer;
  }

  private sample(): void {
    const now = performance.now();
    const delayMs = Math.max(0, now - this.expectedAtMs);
    this.samples += 1;
    this.totalMs += delayMs;
    this.maxMs = Math.max(this.maxMs, delayMs);
    // Count from the tick that actually happened, so a block is not double
    // counted by the ticks it displaced.
    this.expectedAtMs = now + eventLoopDelayResolutionMs;
    this.schedule();
  }
}

const eventLoopDelayResolutionMs = 10;

function toDelayMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 10) / 10;
}

/** Cumulative since boot: starts on module import, which is inside app startup. */
export const desktopEventLoopDelay = new DesktopEventLoopDelayProbe().start();

/** Reset around each relay start so its ready line covers only that window. */
export const desktopAgentStartEventLoopDelay = new DesktopEventLoopDelayProbe();
