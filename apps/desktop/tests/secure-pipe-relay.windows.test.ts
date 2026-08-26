import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WindowsSidDaclPipeRelay } from "../src/agent/secure-pipe-relay.mts";

const scriptPath = fileURLToPath(new URL("../resources/nami-agent-pipe.ps1", import.meta.url));
const maximumResponseLength = 1_000_000;

async function requestPipe(pathname: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = "";
    const socket = net.createConnection(pathname);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("Timed out waiting for the secured pipe response."))), 10_000);
    timeout.unref?.();
    socket.once("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.length > maximumResponseLength) {
        finish(() => reject(new Error("The secured pipe response exceeded the test limit.")));
        return;
      }
      const lineEnd = received.indexOf("\n");
      if (lineEnd === -1) return;
      finish(() => resolve(received.slice(0, lineEnd).replace(/\r$/, "")));
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error("The secured pipe closed before its first response.")));
    });
  });
}

async function connectWithoutWriting(pathname: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

async function readPipeLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = "";
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("Timed out waiting for the stalled pipe response."))), 10_000);
    timeout.unref?.();
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const lineEnd = received.indexOf("\n");
      if (lineEnd !== -1) finish(() => resolve(received.slice(0, lineEnd).replace(/\r$/, "")));
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error("The stalled pipe closed before returning a timeout response.")));
    });
  });
}

async function requestPipeEventually(pathname: string, payload: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await requestPipe(pathname, payload);
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The secured pipe did not recover after a stalled client.");
}

test("Windows SID-DACL relay accepts its first request immediately after ready", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName: `nami-mail-relay-test-${randomBytes(12).toString("hex")}`,
    onRequest: async (payload) => JSON.stringify({ accepted: payload }),
  });
  try {
    const endpoint = await relay.start();
    assert.equal(relay.isLive(), true);
    const firstResponse = await requestPipe(endpoint.path, "first-request-after-ready");
    assert.deepEqual(JSON.parse(firstResponse), { accepted: "first-request-after-ready" });
    const secondResponse = await requestPipeEventually(endpoint.path, "second-request-after-ready");
    assert.deepEqual(JSON.parse(secondResponse), { accepted: "second-request-after-ready" });
  } finally {
    await relay.close();
  }
});

test("Windows SID-DACL relay recovers after a connected client stalls before sending a request", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName: `nami-mail-relay-stall-test-${randomBytes(12).toString("hex")}`,
    requestReadTimeoutMs: 250,
    onRequest: async (payload) => JSON.stringify({ accepted: payload }),
  });
  try {
    const endpoint = await relay.start();
    const stalledClient = await connectWithoutWriting(endpoint.path);
    const timeoutResponse = await readPipeLine(stalledClient);
    assert.deepEqual(JSON.parse(timeoutResponse), { type: "response", error: "request-timeout" });

    const response = await requestPipeEventually(endpoint.path, "request-after-stall");
    assert.deepEqual(JSON.parse(response), { accepted: "request-after-stall" });
  } finally {
    await relay.close();
  }
});
