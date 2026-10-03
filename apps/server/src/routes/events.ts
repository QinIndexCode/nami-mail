import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

/**
 * Live SSE streams this process serves.
 *
 * Every connection is a hijacked socket held open for the life of the renderer,
 * and the only thing that used to retire one was a close event. That made the
 * subscriber count attacker-shaped: a client that opens streams and never
 * finishes the handshake keeps its slot forever. 32 is far above any real
 * deployment — a handful of browser tabs plus the desktop renderer — and low
 * enough that the per-connection resources (socket, buffer, heartbeat timer)
 * cannot be multiplied without bound. Connections past it are refused with 503
 * before the response is hijacked, so the client gets a real HTTP status it can
 * back off from instead of a stream that opens and then dies.
 */
export const maxEventStreams = 32;

/**
 * Unsent bytes tolerated on a single SSE connection before it is dropped.
 *
 * `write()` returning false means the socket could not take the frame; it does
 * not mean the bytes were dropped. A half-open peer (EventSource behind a
 * sleeping machine, a proxy that stopped reading) never drains that queue, so
 * without a ceiling the process grows one unbounded buffer per subscriber until
 * it is OOM-killed — taking SQLite, IMAP and the Agent with it. 4 MB is orders
 * of magnitude above a healthy connection's backlog and only a few seconds of
 * events, so a merely slow client recovers; a stalled one is disconnected and
 * the browser's EventSource reconnects on its own.
 */
export const maxPendingEventBytes = 4 * 1024 * 1024;

export type EventsRouteLimits = {
  /** Unsent-byte budget per connection; lowered by tests to avoid megabyte fixtures. */
  maxPendingBytes?: number;
  /** Concurrent stream ceiling; lowered by tests to make the refusal observable. */
  maxStreams?: number;
};

export type EventsRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
  limits?: EventsRouteLimits;
};

/**
 * Streams currently open, tracked here rather than read off `bus.listenerCount`:
 * the bus also carries non-connection subscribers (the desktop settings bridge
 * listens to `settings.changed` with no socket attached), so it cannot answer
 * "how many renderers are attached right now". A Set keyed by the raw response
 * makes the bookkeeping idempotent under the two close events a single socket
 * can raise.
 */
const activeStreams = new Set<ServerResponse>();

/**
 * Forcibly ends and destroys all active SSE response streams.
 * Must be called during server shutdown before fastify.close(),
 * because hijacked keep-alive streams otherwise prevent Node's
 * http.Server from draining and closing.
 */
export function closeActiveEventStreams(): void {
  for (const stream of activeStreams) {
    try {
      if (!stream.destroyed) {
        stream.end();
        stream.destroy();
      }
    } catch {
      // Ignore errors while closing sockets during shutdown
    }
  }
  activeStreams.clear();
}

export function registerEventsRoutes(app: FastifyInstance, deps: EventsRouteDeps): void {
  const { context, log } = deps;
  const pendingBudget = deps.limits?.maxPendingBytes ?? maxPendingEventBytes;
  const streamLimit = deps.limits?.maxStreams ?? maxEventStreams;

  // Server-originated mail events. The browser renderer (and the desktop
  // renderer via the same code path) keeps an EventSource open here so new
  // inbox mail can refresh the list immediately once the IDLE watcher or a
  // poll pass reports it — no waiting for the next poll tick.
  app.get("/api/events", async (request, reply) => {
    const bus = context.serverEvents;
    if (!bus) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.events_unavailable, message: "Server events are not available." });
    }
    // Checked before hijack, while a normal Fastify reply is still possible.
    if (activeStreams.size >= streamLimit) {
      return reply.code(503).send({
        ok: false,
        code: ROUTE_ERROR_CODES.events_overloaded,
        message: "Too many event stream connections are already open.",
      });
    }
    let deliveryStopped = false;
    const stopDelivery = () => { deliveryStopped = true; };
    request.raw.once("aborted", stopDelivery);
    reply.raw.once("close", stopDelivery);
    // A reset connection surfaces here as an error event; without a listener
    // it would take the whole process down instead of just this stream.
    request.raw.on("error", stopDelivery);
    reply.raw.on("error", stopDelivery);
    const responseSocket = reply.raw.socket;
    responseSocket?.once("close", stopDelivery);

    // Unsent bytes on this connection. `write` returns true when the socket
    // took the frame outright, which is the only proof that whatever was
    // queued before it has been flushed, so a true return clears the count.
    let pendingBytes = 0;
    const writeFrame = (frame: string): void => {
      if (deliveryStopped || reply.raw.destroyed) return;
      let accepted: boolean;
      try {
        accepted = reply.raw.write(frame);
      } catch {
        deliveryStopped = true;
        return;
      }
      if (accepted) {
        pendingBytes = 0;
        return;
      }
      pendingBytes += Buffer.byteLength(frame);
      if (pendingBytes <= pendingBudget) return;
      log.warn(
        { url: request.url, pendingBytes, pendingBudget },
        "Dropping an event stream client that stopped reading",
      );
      // close fires and runs cleanup, which unsubscribes and stops the beat.
      reply.raw.destroy();
    };

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-store, no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    activeStreams.add(reply.raw);
    const unsubscribe = bus.subscribe((event, serialized) => {
      // `serialized` is computed once per emit by the bus and shared by every
      // subscriber, so the frame below costs a write and a template, not a
      // JSON.stringify. A null frame means the event itself could not be
      // serialized; skipping it keeps the stream alive for the next one.
      if (serialized === null) return;
      // Named event per the WHATWG EventSource format: the `event:` field
      // is what lets clients subscribe with addEventListener("mail.received")
      // etc. Without it every frame is delivered as the default "message"
      // event and the named listeners never fire. The `type` key stays in
      // the payload as well; it is what the toast and unread-merge paths
      // switch on.
      writeFrame(`event: ${event.type}\ndata: ${serialized}\n\n`);
    });
    // Browsers ignore comment frames; the beat keeps middleboxes from timing
    // the silent stream out while no mail arrives.
    const heartbeat = setInterval(() => writeFrame(": ping\n\n"), 25_000);
    const cleanup = () => {
      activeStreams.delete(reply.raw);
      unsubscribe();
      clearInterval(heartbeat);
      request.raw.removeListener("aborted", stopDelivery);
      reply.raw.removeListener("close", stopDelivery);
      request.raw.removeListener("error", stopDelivery);
      reply.raw.removeListener("error", stopDelivery);
      responseSocket?.removeListener("close", stopDelivery);
      responseSocket?.removeListener("close", cleanup);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.once("close", cleanup);
    // A vanished client surfaces as a socket close; end the response so the
    // server does not hold the connection (and app.close()) open forever.
    responseSocket?.once("close", cleanup);
  });
}
