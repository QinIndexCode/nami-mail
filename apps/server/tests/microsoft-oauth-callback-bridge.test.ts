import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo, ListenOptions } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeMicrosoftOAuthCallbackBridge,
  createMicrosoftOAuthCallbackBridge,
  MICROSOFT_OAUTH_CALLBACK_PATH,
} from "../src/runtime.js";

const servers: Server[] = [];

function listen(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function requestBridge(port: number, method: string, path: string, host = "untrusted.example"): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "::1",
      family: 6,
      headers: { host },
      method,
      path,
      port,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server).catch(() => undefined)));
});

describe("Microsoft OAuth IPv6 callback bridge", () => {
  it("uses the main IPv4 port while forwarding only the exact GET callback without trusting Host", async () => {
    const ipv4Listener = createServer((_request, response) => response.end("main listener"));
    servers.push(ipv4Listener);
    await listen(ipv4Listener, { host: "127.0.0.1", port: 0 });
    const address = ipv4Listener.address() as AddressInfo;

    const inject = vi.fn(async () => ({
      statusCode: 200,
      headers: {
        "content-security-policy": "default-src 'none'",
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["must-not-leak"],
      },
      body: "callback complete",
    }));
    const app = {
      inject,
      log: { warn: vi.fn() },
    } as unknown as FastifyInstance;
    const bridge = await createMicrosoftOAuthCallbackBridge(app, address.port);
    servers.push(bridge);

    const accepted = await requestBridge(
      address.port,
      "GET",
      `${MICROSOFT_OAUTH_CALLBACK_PATH}?code=accepted&state=state-value`,
    );
    const wrongPath = await requestBridge(address.port, "GET", "/api/oauth/google/callback?code=ignored");
    const wrongMethod = await requestBridge(address.port, "POST", MICROSOFT_OAUTH_CALLBACK_PATH);

    expect(accepted).toMatchObject({ statusCode: 200, body: "callback complete" });
    expect(accepted.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(accepted.headers["set-cookie"]).toBeUndefined();
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith({
      method: "GET",
      url: `${MICROSOFT_OAUTH_CALLBACK_PATH}?code=accepted&state=state-value`,
    });
    expect(wrongPath).toMatchObject({ statusCode: 404, body: "Not Found" });
    expect(wrongMethod).toMatchObject({ statusCode: 405, body: "Method Not Allowed" });
    expect(wrongMethod.headers.allow).toBe("GET");

    await closeMicrosoftOAuthCallbackBridge(bridge);
    expect(bridge.listening).toBe(false);
  });
});
