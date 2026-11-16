import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopAgentBrokerHost } from "../src/agent/desktop-broker.mts";
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

async function listRelayProcesses(marker: string): Promise<number[]> {
  // Exclude the query itself: its own command line contains the marker.
  const command = `$self = $PID; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  const output = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  return output.trim().split(/\r?\n/).filter(Boolean).map(Number);
}

async function waitForNoRelayProcess(marker: string): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  let remaining = await listRelayProcesses(marker);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = await listRelayProcesses(marker);
  }
  return remaining;
}

/** Resolves with the connect error code, or rejects when the pipe still accepts clients. */
async function expectMissingPipe(pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The failed relay's named pipe still exists."));
    }, 2_000);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("The failed relay's named pipe still accepts connections."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(error.code ?? "unknown");
    });
  });
}

test("A failed relay start leaves no relay process or pipe, and host.close() is idempotent", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-relay-failure-"));
  const pipeName = `nami-mail-relay-failure-test-${randomBytes(12).toString("hex")}`;
  const badScript = path.join(directory, "bad-ready.ps1");
  // Reports ready for a pipe name other than the one it was asked to serve, so
  // start() fails on validation after the process is already running.
  await fs.writeFile(badScript, [
    "param([string]$PipeName, [int]$RequestReadTimeoutMilliseconds)",
    "$message = @{ type = 'ready'; pipeName = 'unexpected-pipe'; path = '\\\\.\\pipe\\unexpected-pipe'; ownerSid = 'S-1-5-21-1-2-3-1001'; daclProtected = $true; ownerOnly = $true; accessRuleCount = 1 } | ConvertTo-Json -Compress",
    "[Console]::Out.WriteLine($message)",
    "[Console]::Out.Flush()",
    "Start-Sleep -Seconds 60",
  ].join("\n"), "utf8");
  try {
    const relay = new WindowsSidDaclPipeRelay({
      scriptPath: badScript,
      pipeName,
      onRequest: async () => "{}",
    });
    await assert.rejects(relay.start(), /Agent pipe/);
    assert.deepEqual(await waitForNoRelayProcess(pipeName), []);
    assert.equal(await expectMissingPipe(`\\\\.\\pipe\\${pipeName}`), "ENOENT");
    await relay.close();
    await relay.close();
    assert.equal(relay.isLive(), false);

    // The same failure through the host: close() must be idempotent and leave
    // no PowerShell relay behind either.
    const host = new DesktopAgentBrokerHost({
      userDataPath: path.join(directory, "host"),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
      scriptPath: badScript,
      invokeExternalAgentTool: async () => { throw new Error("unused"); },
    });
    await assert.rejects(host.start(), /Agent pipe/);
    await Promise.all([host.close(), host.close()]);
    await host.close();
    assert.deepEqual(await waitForNoRelayProcess(badScript), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
