import { recordApiTiming } from "./perfTelemetry";

/**
 * Renderer transport primitives shared by every api.ts endpoint: the error
 * shape they reject with, the bare fetch wrapper, and the two bounded request
 * paths (the fixed JSON budget and the payload-aware binary budget).
 *
 * These live outside api.ts for two reasons. The endpoint table there stays a
 * table, and — more importantly — the cancellation classification below is the
 * one place that decides "the user cancelled" versus "the service wedged", so
 * both bounded paths derive it from the same helper instead of re-deriving it
 * from `signal.reason`.
 */

export class ApiError extends Error {
  readonly llmAvailable?: boolean;
  /**
   * The machine-readable refusal a route sends beside its text, when it sends one.
   *
   * The batch-job undo is the caller that needs it: the route answers 409 with
   * `reason: "expired" | "already_undone" | …`, and a client that only had `code`
   * (the HTTP-level word) could not tell those apart. Kept a plain string so this
   * transport module does not have to know any endpoint's vocabulary; the caller
   * narrows it.
   */
  readonly reason?: string;
  constructor(message: string, readonly code?: string, readonly status?: number, llmAvailable?: boolean, reason?: string) {
    super(message);
    this.name = "ApiError";
    if (llmAvailable) this.llmAvailable = llmAvailable;
    if (reason) this.reason = reason;
  }
}

type ErrorResponse = {
  message?: string;
  code?: string;
  llmAvailable?: boolean;
  reason?: string;
};

/** One user-facing string per transport failure, shared by the JSON and the
 * binary path so a wedge reads identically wherever it is caught. */
export const LOCAL_SERVICE_UNREACHABLE_MESSAGE = "The Nami Mail local service could not be reached.";
export const LOCAL_SERVICE_TIMEOUT_MESSAGE = "The Nami Mail local service did not respond in time.";

export async function apiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorResponse;
  return new ApiError(
    body.message || "The request failed. Please try again later.",
    body.code,
    response.status,
    body.llmAvailable,
    typeof body.reason === "string" ? body.reason : undefined,
  );
}

export async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  // The desktop main process injects the local API token at the Electron
  // session level (webRequest) for /api/* requests, so the renderer never
  // reads or sends the token itself. Browser development has no token.
  try {
    // `init.signal` is part of the contract and rides along in the spread:
    // the streaming endpoints (agent messages, translation) and both bounded
    // paths below cancel through it.
    return await fetch(path, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    // Re-throw AbortError so callers can distinguish intentional cancellation
    // (user stopped, switched conversation, or component unmounted) from a real
    // local-service failure. The browser console may still log net::ERR_ABORTED
    // for aborted requests — that is expected and not actionable.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // The API is always local to Nami Mail. A renderer fetch failure is not a mailbox credential failure.
    throw new ApiError(LOCAL_SERVICE_UNREACHABLE_MESSAGE, "local_service_unavailable");
  }
}

/** One in-flight request's lifetime: a fixed budget plus the caller's own
 * cancellation, combined into the single signal that fetch actually sees. */
export type BoundedRequest = {
  /** What to hand to fetch — aborts on the caller's cancel or on the budget. */
  signal: AbortSignal;
  /**
   * True only when *our* budget fired. A caller-driven abort must never be
   * reported as a timeout, so this is a flag rather than a read of
   * `signal.reason`: a caller that aborts with a TimeoutError-shaped reason is
   * still a deliberate cancellation, not a wedge.
   */
  timedOut: () => boolean;
  /** Releases the timer and the listener. Always call from a finally. */
  dispose: () => void;
};

/**
 * Binds a request to `timeoutMs` (pass `null` for the unbounded streaming
 * endpoints, which manage their own lifetime through a caller's signal) while
 * still honouring a caller's `signal` — including one that was already
 * aborted before the fetch started.
 */
export function boundedRequest(timeoutMs: number | null, callerSignal?: AbortSignal | null): BoundedRequest {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(LOCAL_SERVICE_TIMEOUT_MESSAGE, "TimeoutError"));
    }, timeoutMs);
    timer.unref?.();
  }
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    // The caller already cancelled before the fetch started: honour it as an
    // AbortError instead of silently proceeding on our own signal.
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

/** How long a binary transfer may take before it counts as wedged. Binary
 * endpoints move whole files, so they deliberately do not share the JSON
 * budget: ComposeModal accepts a 10 MB attachment per file, which on a slow
 * link outlasts 30s easily, and the JSON timer turned an upload that had
 * already reached the server into a `local_service_timeout` failure.
 *
 * The wedge that budget guards against is real here too — the attachment
 * spinner, the compose close gate and the preview drawer all wait on these
 * requests, and a wedged service used to leave them waiting forever — so the
 * binary path keeps a bound instead of dropping the guard. A known payload
 * gets 60s plus 20s per megabyte; an unknown one (a download only learns its
 * length from the response) gets the whole cap, because there is nothing to
 * scale with and failing a large legitimate transfer is the worse error. */
const BINARY_BASE_TIMEOUT_MS = 60_000;
const BINARY_PER_MEGABYTE_MS = 20_000;
const BINARY_MAX_TIMEOUT_MS = 180_000;

/** Binary budget for a transfer of known size, or the full cap when the size
 * is unknown. */
export function binaryTimeoutMsFor(bytes?: number): number {
  if (bytes === undefined) return BINARY_MAX_TIMEOUT_MS;
  return Math.min(BINARY_MAX_TIMEOUT_MS, BINARY_BASE_TIMEOUT_MS + Math.ceil(Math.max(0, bytes) / (1024 * 1024)) * BINARY_PER_MEGABYTE_MS);
}

export type BinaryRequestOptions = {
  /** The caller's cancellation: a preview unmounted, a pane closed, a user
   * pressing stop. Forwarded to fetch, and never reported as a timeout. */
  signal?: AbortSignal;
  /** Overrides the payload-derived budget. */
  timeoutMs?: number;
};

/**
 * Runs one binary transfer end to end — response head *and* body — under the
 * binary budget. `read` receives the response and consumes whatever the
 * endpoint returns (a JSON envelope or a blob), so the bound also covers a body
 * that stalls mid-stream, which a head-only timer would not.
 */
export async function binaryTransfer<T>(
  path: string,
  init: RequestInit | undefined,
  read: (response: Response) => Promise<T>,
  options?: BinaryRequestOptions,
): Promise<T> {
  const bounded = boundedRequest(options?.timeoutMs ?? binaryTimeoutMsFor(), options?.signal);
  // Perf telemetry matches the JSON path: the wall time covers the transfer,
  // and a deliberate cancellation is not recorded (it is not jank data).
  const startedAt = performance.now();
  try {
    const response = await requestResponse(path, { ...init, signal: bounded.signal });
    const parsed = await read(response);
    recordApiTiming(path, performance.now() - startedAt, { status: response.status });
    return parsed;
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    if (!isAbort) {
      recordApiTiming(path, performance.now() - startedAt, {
        error: bounded.timedOut() ? "timeout" : (error instanceof Error ? error.name : "unknown"),
      });
    }
    if (bounded.timedOut()) throw new ApiError(LOCAL_SERVICE_TIMEOUT_MESSAGE, "local_service_timeout");
    throw error;
  } finally {
    bounded.dispose();
  }
}
