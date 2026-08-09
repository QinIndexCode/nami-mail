# MCP Client Configuration

[Chinese](configuration.zh-CN.md) | [Installation](installation.en.md) | [Examples](examples.en.md)

> **Current-build status: configure an MCP client.** The 0.3.0 installer ships the `namimail` command and PATH shim, and `namimail mcp start` runs the MCP stdio bridge against a paired, running Agent host. The JSON below can be pasted into a current IDE or MCP client.

## Process declaration

The MCP client launches `namimail mcp start` as a managed child process through `cmd.exe`. The client field may be named `mcpServers`, `servers`, or a graphical setting, but it must not accept `url`, `port`, `database`, `token`, `pipe`, mail credentials, or Provider API keys. Identity material must remain in paired Broker state and client secure storage.

```json
{
  "mcpServers": {
    "namimail": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "namimail mcp start"]
    }
  }
}
```

## Startup sequence

1. A user opens NamiMail or explicitly requests AgentHost through `namimail service start`, then pairs the client profile with `namimail pair` and approves it in the visible window.
2. The MCP client starts the MCP stdio child process with the command above.
3. The client performs MCP initialization (protocol version `2025-03-26`, serverInfo name `NamiMail`) and `tools/list`.
4. The stdio adapter connects only to a paired, current-user-SID-restricted Broker; the Broker constructs `mcp` caller context and exposes only allowed tools.

The interface must not auto-start a service, replace pairing with HTTP retries, or reuse stale schema, identity, or revoked-client state. After updates, account-scope changes, or revocation, clients must discover tools again.

## Concurrency and timeout requirements

A client may keep one MCP child process and correlate responses with MCP SDK request IDs. After timeout it should cancel its local wait and honor a later `CANCELLED` or `UPDATE_IN_PROGRESS` result; it must not replay the same signed Broker frame. Retryable errors may use bounded backoff only.
