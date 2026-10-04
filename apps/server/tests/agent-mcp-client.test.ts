import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClientError, McpStdioClient, isSafeJsonValue, maxJsonDepth, probeMcpServer } from "../src/agent/mcp-client.js";
import { setServerLogger } from "../src/logging.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

function transport(overrides: { requestTimeoutMs?: number; env?: Record<string, string> } = {}) {
  return {
    command: process.execPath,
    args: [fixturePath],
    requestTimeoutMs: overrides.requestTimeoutMs ?? 15_000,
    connectTimeoutMs: 10_000,
    ...(overrides.env ? { env: overrides.env } : {}),
  };
}

type LoggedCall = { meta: object; message: string };

/** Captures the module's warn channel for the duration of one test. */
function captureWarnings(): LoggedCall[] {
  const logged: LoggedCall[] = [];
  setServerLogger({
    info: () => {},
    warn: (meta, message) => { logged.push({ meta, message }); },
    error: () => {},
  });
  return logged;
}

describe("McpStdioClient", () => {
  it("performs the initialize handshake and discovers tools", async () => {
    const client = new McpStdioClient(transport());
    try {
      const capabilities = await client.connect();
      expect(capabilities.serverInfo).toEqual({ name: "mock-mcp-server", version: "1.0.0" });
      expect(capabilities.tools.map((tool) => tool.name).sort()).toEqual(["add", "delete_file", "echo_env", "get_weather", "send_note", "slow"]);
      const weather = capabilities.tools.find((tool) => tool.name === "get_weather");
      expect(weather?.annotations?.readOnlyHint).toBe(true);
      const note = capabilities.tools.find((tool) => tool.name === "send_note");
      expect(note?.annotations?.destructiveHint).toBe(true);
    } finally {
      client.close();
    }
  });

  it("calls a tool and returns its text content", async () => {
    const client = new McpStdioClient(transport());
    try {
      await client.connect();
      const result = await client.callTool("get_weather", { city: "Tokyo" });
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toBe("Weather in Tokyo: sunny");
    } finally {
      client.close();
    }
  });

  it("surfaces isError results and structured content", async () => {
    const client = new McpStdioClient(transport());
    try {
      await client.connect();
      const failure = await client.callTool("send_note", { text: "hello" });
      expect(failure.isError).toBe(true);
      expect(failure.content[0]?.text).toContain("rejected");
      const add = await client.callTool("add", { a: 2, b: 3 });
      expect(add.isError).toBe(false);
      expect(add.structuredContent).toEqual({ sum: 5 });
    } finally {
      client.close();
    }
  });

  it("rejects a slow request when its timeout expires", async () => {
    const client = new McpStdioClient(transport({ requestTimeoutMs: 300 }));
    try {
      await client.connect();
      const promise = client.callTool("slow", { delayMs: 5_000 });
      await expect(promise).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    } finally {
      client.close();
    }
  });

  it("cancels an in-flight request when the caller aborts", async () => {
    const client = new McpStdioClient(transport());
    try {
      await client.connect();
      const controller = new AbortController();
      const promise = client.callTool("slow", { delayMs: 5_000 }, { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    } finally {
      client.close();
    }
  });

  it("rejects pending requests when the server process exits", async () => {
    const client = new McpStdioClient(transport({ env: { MOCK_MCP_EXIT_AFTER_INIT: "1" } }));
    await expect(client.connect()).rejects.toBeInstanceOf(McpClientError);
    expect(client.isConnected).toBe(false);
    client.close();
  });

  it("rejects calls before the client connects", async () => {
    const client = new McpStdioClient(transport());
    await expect(client.callTool("get_weather", { city: "X" })).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    client.close();
  });

  it("does not inherit local API tokens or mail service details from process.env", async () => {
    const sensitive: Record<string, string> = {
      NAMI_MAIL_LOCAL_API_TOKEN: "inherited-token",
      NAMI_MAIL_AGENT_SECRET: "inherited-agent-secret",
      DATABASE_PATH: "C:\\data\\mail.db",
      MASTER_KEY_PATH: "C:\\data\\master.key",
      HOST: "127.0.0.99",
      PORT: "9999",
      WEB_DIST_PATH: "C:\\app\\dist",
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(sensitive)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const client = new McpStdioClient(transport());
      try {
        await client.connect();
        const result = await client.callTool("echo_env", { keys: [...Object.keys(sensitive), "PATH"] });
        expect(result.isError).toBe(false);
        const values = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, string | null>;
        for (const key of Object.keys(sensitive)) {
          expect(values[key]).toBeNull();
        }
        // Ordinary variables are still inherited.
        expect(values.PATH).toBe(process.env.PATH ?? null);
      } finally {
        client.close();
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("still forwards explicitly configured transport.env variables", async () => {
    const previous = process.env.NAMI_MAIL_LOCAL_API_TOKEN;
    process.env.NAMI_MAIL_LOCAL_API_TOKEN = "inherited-token";
    try {
      const client = new McpStdioClient(transport({ env: { NAMI_MAIL_LOCAL_API_TOKEN: "explicit-token" } }));
      try {
        await client.connect();
        const result = await client.callTool("echo_env", { keys: ["NAMI_MAIL_LOCAL_API_TOKEN"] });
        expect(result.isError).toBe(false);
        const values = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, string | null>;
        expect(values.NAMI_MAIL_LOCAL_API_TOKEN).toBe("explicit-token");
      } finally {
        client.close();
      }
    } finally {
      if (previous === undefined) delete process.env.NAMI_MAIL_LOCAL_API_TOKEN;
      else process.env.NAMI_MAIL_LOCAL_API_TOKEN = previous;
    }
  });
});

describe("MCP stdio resource bounds", () => {
  afterEach(() => {
    setServerLogger(undefined);
  });

  // The reviewed reproduction: a ~65 KB JSON-RPC line nested thousands of
  // levels deep. Walking that shape used to raise
  // `RangeError: Maximum call stack size exceeded` inside the readline 'line'
  // callback, where it escaped straight to uncaughtException — killing SQLite,
  // IMAP, the Agent and the HTTP API with it.
  it("drops a pathologically nested line without letting anything escape the line handler", async () => {
    const logged = captureWarnings();
    const client = new McpStdioClient(transport({ env: { MOCK_MCP_DEEP_LINE: "1" } }));
    try {
      await client.connect();
      // The fixture interleaves the deep frame with a normal answer, so one
      // round-trip proves both halves: the frame was dropped and the response
      // it shared a batch of stdout with still landed.
      const deep = await client.callTool("deep", {});
      expect(deep.isError).toBe(false);
      expect(deep.content[0]?.text).toBe("deep");

      await vi.waitFor(() => {
        expect(logged.map((call) => call.message)).toContain("Dropped an MCP stdio line nested past the accepted JSON depth");
      }, { timeout: 10_000 });
      expect(logged.find((call) => call.message.includes("nested past"))?.meta).toMatchObject({ reason: "depth" });

      // …and the connection is still usable afterwards.
      expect(client.isConnected).toBe(true);
      const weather = await client.callTool("get_weather", { city: "Tokyo" });
      expect(weather.content[0]?.text).toBe("Weather in Tokyo: sunny");
    } finally {
      client.close();
    }
  });

  // readline has no line-length limit of its own, so the byte budget has to be
  // applied before readline ever assembles a line: a server that never writes
  // a newline otherwise makes it concatenate until Node throws
  // `RangeError: Invalid string length` from inside its own emit stack.
  it("tears the connection down when the server floods stdout without ever terminating a line", async () => {
    const logged = captureWarnings();
    const client = new McpStdioClient(transport({ env: { MOCK_MCP_FLOOD: "1" }, requestTimeoutMs: 20_000 }));
    try {
      await client.connect();
      await expect(client.callTool("flood", {})).rejects.toMatchObject({ code: "CLOSED" });
      expect(client.isConnected).toBe(false);
      expect(client.isAlive).toBe(false);

      const floodWarning = logged.find((call) => call.message.includes("stdout byte budget"));
      expect(floodWarning?.meta).toMatchObject({ reason: "line" });
    } finally {
      client.close();
    }
  });

  // The catch around the line handler is the last line of defence: it is what
  // keeps any future validator change from turning a peer's input into an
  // uncaughtException. Stubbing the body reproduces the failure mode exactly
  // (a RangeError raised while the line is being validated) without depending
  // on the depth bound below to have already stopped it.
  it("contains any exception raised while a line is being dispatched", () => {
    const logged = captureWarnings();
    const client = new McpStdioClient(transport());
    const boundary = client as unknown as {
      handleLine(line: string): void;
      dispatchLine(line: string): void;
    };
    boundary.dispatchLine = () => { throw new RangeError("Maximum call stack size exceeded"); };

    expect(() => boundary.handleLine('{"jsonrpc":"2.0","id":1,"result":{}}')).not.toThrow();
    expect(logged.map((call) => call.message)).toContain("Dropped an MCP stdio line that failed validation");
  });

  it("bounds JSON nesting depth in the value walk", () => {
    const nest = (levels: number): unknown => {
      let value: unknown = "leaf";
      for (let level = 0; level < levels; level += 1) value = [value];
      return value;
    };

    expect(isSafeJsonValue(nest(maxJsonDepth))).toBe(true);
    expect(isSafeJsonValue(nest(maxJsonDepth + 1))).toBe(false);

    // The reviewed payload depth: rejected without a stack overflow.
    expect(() => isSafeJsonValue(nest(50_000))).not.toThrow();
    expect(isSafeJsonValue(nest(50_000))).toBe(false);

    // The pre-existing rejections still hold.
    expect(isSafeJsonValue(JSON.parse('{"__proto__": {"polluted": true}}'))).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isSafeJsonValue(cycle)).toBe(false);
    expect(isSafeJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeJsonValue({ city: "Tokyo", nested: { list: [1, "two", null, true] } })).toBe(true);
  });
});

describe("probeMcpServer", () => {
  it("reports a successful probe with discovered tools", async () => {
    const result = await probeMcpServer(transport());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolCount).toBe(6);
      expect(result.toolNames).toContain("get_weather");
      expect(result.capabilities.serverInfo.name).toBe("mock-mcp-server");
    }
  });

  it("reports a failed probe for a missing command", async () => {
    const result = await probeMcpServer({
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/does-not-exist.mjs", import.meta.url))],
      connectTimeoutMs: 2_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
