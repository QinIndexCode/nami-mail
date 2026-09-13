import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";

export type EventsRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerEventsRoutes(app: FastifyInstance, deps: EventsRouteDeps): void {
  const { context, log } = deps;

  // Server-originated mail events. The browser renderer (and the desktop
  // renderer via the same code path) keeps an EventSource open here so new
  // inbox mail can refresh the list immediately once the IDLE watcher or a
  // poll pass reports it — no waiting for the next poll tick.
  app.get("/api/events", async (request, reply) => {
    const bus = context.serverEvents;
    if (!bus) {
      return reply.code(404).send({ ok: false, code: "events_unavailable", message: "Server events are not available." });
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
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-store, no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    const unsubscribe = bus.subscribe((event) => {
      if (deliveryStopped || reply.raw.destroyed) return;
      try {
        // Named event per the WHATWG EventSource format: the `event:` field
        // is what lets clients subscribe with addEventListener("mail.received")
        // etc. Without it every frame is delivered as the default "message"
        // event and the named listeners never fire. The `type` key stays in
        // the payload as well; it is what the toast and unread-merge paths
        // switch on.
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        deliveryStopped = true;
      }
    });
    // Browsers ignore comment frames; the beat keeps middleboxes from timing
    // the silent stream out while no mail arrives.
    const heartbeat = setInterval(() => {
      if (deliveryStopped || reply.raw.destroyed) return;
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        deliveryStopped = true;
      }
    }, 25_000);
    const cleanup = () => {
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
