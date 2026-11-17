import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requestPipe as brokerRequestPipe } from "../src/agent/broker-pipe.mts";
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
    "param([string]$PipeName, [int]$RequestReadTimeoutMilliseconds, [int]$ParentResponseTimeoutMilliseconds)",
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("A client that arrives while an exchange is in flight connects and is served next", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  let signalInFlight!: () => void;
  const inFlightStarted = new Promise<void>((resolve) => { signalInFlight = resolve; });
  let releaseInFlight!: () => void;
  const inFlightReleased = new Promise<void>((resolve) => { releaseInFlight = resolve; });
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName: `nami-mail-relay-inflight-test-${randomBytes(12).toString("hex")}`,
    onRequest: async (payload) => {
      if (payload === "in-flight") {
        signalInFlight();
        await inFlightReleased;
      }
      return JSON.stringify({ accepted: payload });
    },
  });
  try {
    const endpoint = await relay.start();
    const inFlight = requestPipe(endpoint.path, "in-flight");
    await inFlightStarted;
    // No retry helper here: this connection has to succeed while the first
    // exchange is still running, which is only possible because the second
    // instance is built before the first one is released.
    const queued = await connectWithoutWriting(endpoint.path);
    queued.write("queued-while-busy\n");
    releaseInFlight();
    const [inFlightResponse, queuedResponse] = await Promise.all([inFlight, readPipeLine(queued)]);
    assert.deepEqual(JSON.parse(inFlightResponse), { accepted: "in-flight" });
    assert.deepEqual(JSON.parse(queuedResponse), { accepted: "queued-while-busy" });

    const after = await requestPipe(endpoint.path, "after-queued-exchange");
    assert.deepEqual(JSON.parse(after), { accepted: "after-queued-exchange" });
  } finally {
    await relay.close();
  }
});

test("Stalled clients cannot hold both instances: each is reclaimed within the read timeout", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName: `nami-mail-relay-two-stalls-test-${randomBytes(12).toString("hex")}`,
    requestReadTimeoutMs: 300,
    onRequest: async (payload) => JSON.stringify({ accepted: payload }),
  });
  try {
    const endpoint = await relay.start();
    const stalled = await Promise.all([
      connectWithoutWriting(endpoint.path),
      connectWithoutWriting(endpoint.path),
    ]);
    const replies = await Promise.all(stalled.map((socket) => readPipeLine(socket)));
    for (const reply of replies) {
      assert.deepEqual(JSON.parse(reply), { type: "response", error: "request-timeout" });
    }

    const response = await requestPipe(endpoint.path, "after-two-stalled-clients");
    assert.deepEqual(JSON.parse(response), { accepted: "after-two-stalled-clients" });
  } finally {
    await relay.close();
  }
});

test("A silent parent fails within the response ceiling without wedging the relay", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const parentResponseTimeoutMs = 300;
  const pipeName = `nami-mail-relay-parent-timeout-test-${randomBytes(12).toString("hex")}`;
  const hung = new Map<string, () => void>();
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName,
    parentResponseTimeoutMs,
    onRequest: async (payload) => {
      if (payload.startsWith("hang-")) {
        await new Promise<void>((resolve) => { hung.set(payload, resolve); });
      }
      return JSON.stringify({ accepted: payload });
    },
  });
  try {
    const endpoint = await relay.start();
    // Two rounds: each timeout releases its instance, and the pre-built spare
    // is what serves the next client while the replacement is built.
    for (const round of ["first", "second"]) {
      const startedAt = Date.now();
      const timeoutResponse = await requestPipe(endpoint.path, `hang-${round}`);
      const elapsedMs = Date.now() - startedAt;
      assert.deepEqual(JSON.parse(timeoutResponse), { type: "response", error: "parent-timeout" });
      assert.ok(elapsedMs >= parentResponseTimeoutMs - 50, `The parent wait ended after ${elapsedMs}ms, before its ${parentResponseTimeoutMs}ms ceiling.`);
      assert.ok(elapsedMs < 5_000, `The parent wait took ${elapsedMs}ms instead of failing at its ${parentResponseTimeoutMs}ms ceiling.`);

      // A late answer names the exchange that already failed: releasing it here
      // must not deliver it to the next client.
      hung.get(`hang-${round}`)?.();
      const after = await requestPipeEventually(endpoint.path, `after-${round}`);
      assert.deepEqual(JSON.parse(after), { accepted: `after-${round}` });
    }
    assert.equal(relay.isLive(), true);
  } finally {
    await relay.close();
  }
  assert.deepEqual(await waitForNoRelayProcess(pipeName), []);
});

test("The client reports a relay parent-timeout frame as a retryable host failure", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const pathname = `\\\\.\\pipe\\nami-mail-relay-protocol-test-${randomBytes(12).toString("hex")}`;
  // The relay's own error frame carries no signed payload, so it must be
  // rejected as a transport failure instead of reaching response verification.
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(`${JSON.stringify({ type: "response", error: "parent-timeout" })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pathname, resolve);
  });
  try {
    await assert.rejects(brokerRequestPipe(pathname, "probe"), (error: unknown) => {
      const failure = error as { code?: string; retryable?: boolean; message?: string };
      assert.equal(failure.code, "HOST_UNAVAILABLE");
      assert.equal(failure.retryable, true);
      assert.match(String(failure.message), /did not respond in time/);
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Every rebuilt instance carries the first instance's security descriptor", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const stderrLines: string[] = [];
  const relay = new WindowsSidDaclPipeRelay({
    scriptPath,
    pipeName: `nami-mail-relay-dacl-test-${randomBytes(12).toString("hex")}`,
    onStderr: (line) => { stderrLines.push(line); },
    onRequest: async (payload) => JSON.stringify({ accepted: payload }),
  });
  try {
    const endpoint = await relay.start();
    // Each exchange builds a fresh instance, so six rounds compare six
    // descriptors against the one that was verified at startup.
    for (let index = 0; index < 6; index += 1) {
      const response = await requestPipe(endpoint.path, `dacl-round-${index}`);
      assert.deepEqual(JSON.parse(response), { accepted: `dacl-round-${index}` });
    }
    assert.deepEqual(stderrLines.filter((line) => /security descriptor/i.test(line)), []);
    assert.equal(relay.isLive(), true);
  } finally {
    await relay.close();
  }
});

test("A pre-built instance with a different descriptor stops the relay instead of serving it", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-relay-dacl-mismatch-"));
  const pipeName = `nami-mail-relay-dacl-mismatch-test-${randomBytes(12).toString("hex")}`;
  try {
    const original = await fs.readFile(scriptPath, "utf8");
    const tampered = original.replace(
      "$expectedSddl = Get-PipeSddl -Pipe $pipe",
      "$expectedSddl = 'O:BAG:BAD:(A;;GA;;;SY)'",
    );
    assert.notEqual(tampered, original, "The tampered copy must change the reference descriptor.");
    const tamperedScript = path.join(directory, "nami-agent-pipe-mismatch.ps1");
    await fs.writeFile(tamperedScript, tampered, "utf8");

    const stderrLines: string[] = [];
    const relay = new WindowsSidDaclPipeRelay({
      scriptPath: tamperedScript,
      pipeName,
      onStderr: (line) => { stderrLines.push(line); },
      onRequest: async () => "{}",
    });
    const endpoint = await relay.start();
    assert.equal(endpoint.pipeName, pipeName);
    assert.equal(
      await waitFor(() => stderrLines.some((line) => /security descriptor changed between instances/.test(line))),
      true,
      `expected a descriptor mismatch report, saw ${JSON.stringify(stderrLines)}`,
    );
    assert.equal(
      await waitFor(() => !relay.isLive()),
      true,
      "the relay must stop instead of serving an instance it could not verify",
    );
    assert.equal(await expectMissingPipe(`\\\\.\\pipe\\${pipeName}`), "ENOENT");
    await relay.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
