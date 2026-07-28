# MCP Client Configuration Status and Future Contract

[Chinese](configuration.md) | [Installation](installation.en.md) | [Examples](examples.en.md)

> **Current-build status: do not configure an MCP client.** The current Windows build has no `namimail` command, PATH shim, MCP stdio launcher, Broker, or pairing UI. The JSON shape and startup order below define only the contract after a verified SID-DACL native adapter ships; they cannot be pasted into a current IDE or MCP client.

## Future process declaration (not executable)

The released MCP client will use a managed `namimail` child process with the reserved `mcp start` argument. The client field may be named `mcpServers`, `servers`, or a graphical setting, but it will not accept `url`, `port`, `database`, `token`, `pipe`, mail credentials, or Provider API keys. Identity material must remain in paired Broker state and client secure storage.

## Future startup sequence (not executable)

1. A user opens NamiMail or explicitly requests AgentHost only through the supported service-start path.
2. The MCP client starts the reserved MCP stdio child process.
3. The client performs MCP initialization and `tools/list`.
4. The adapter connects only to a paired, current-user-SID-restricted Broker; the Broker constructs `mcp` caller context and exposes only allowed tools.

The released interface must still not auto-start a service, replace pairing with HTTP retries, or reuse stale schema, identity, or revoked-client state. After updates, account-scope changes, or revocation, clients must discover tools again.

## Future concurrency and timeout requirements

A client may keep one MCP child process and correlate responses with MCP SDK request IDs. After timeout it should cancel its local wait and honor a later `CANCELLED` or `UPDATE_IN_PROGRESS` result; it must not replay the same signed Broker frame. Retryable errors may use bounded backoff only.
