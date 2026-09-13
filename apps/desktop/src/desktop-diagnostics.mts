import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
