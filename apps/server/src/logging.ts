/**
 * Structured logging for background work that runs outside a Fastify request.
 *
 * The sync, IDLE, outbox and auto-reply pipelines live in modules that are also
 * unit-tested on their own, so they cannot take a Fastify logger as a
 * parameter. This facade is pointed at the live pino logger once the app is
 * built and otherwise emits the same JSONL shape (`level`/`time`/`msg`) to
 * stderr. That keeps `console.*` out of the server while making every
 * background failure greppable next to the request logs — and keeps a log line
 * from ever breaking a background pass.
 *
 * Errors are merged under `err`, the only key Fastify's default pino serializer
 * turns into a full stack trace.
 */

export type ServerLogger = {
  info: (meta: object, message: string, error?: unknown) => void;
  warn: (meta: object, message: string, error?: unknown) => void;
  error: (meta: object, message: string, error?: unknown) => void;
};

/** The subset a pino/Fastify logger already satisfies. */
export type ServerLogSink = {
  info: (meta: object, message: string) => void;
  warn: (meta: object, message: string) => void;
  error: (meta: object, message: string) => void;
};

let sink: ServerLogSink | undefined;

export function setServerLogger(logger: ServerLogSink | undefined): void {
  sink = logger;
}

/** pino's level numbers, so the fallback lines sort with real pino output. */
const fallbackLevels = { info: 30, warn: 40, error: 50 } as const;

function writeFallback(level: keyof typeof fallbackLevels, meta: object, message: string): void {
  try {
    process.stderr.write(`${JSON.stringify({ level: fallbackLevels[level], time: Date.now(), ...meta, msg: message })}\n`);
  } catch {
    // A failed log line must never break the caller.
  }
}

function emit(level: keyof typeof fallbackLevels, meta: object, message: string, error?: unknown): void {
  const payload = error === undefined ? meta : { ...meta, err: error };
  if (sink) sink[level](payload, message);
  else writeFallback(level, payload, message);
}

export const serverLog: ServerLogger = {
  info: (meta, message, error) => emit("info", meta, message, error),
  warn: (meta, message, error) => emit("warn", meta, message, error),
  error: (meta, message, error) => emit("error", meta, message, error),
};
