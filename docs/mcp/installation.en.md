# MCP Installation Status and Future Prerequisites

[Chinese](installation.md) | [Configuration](configuration.en.md)

> **Current-build status: MCP cannot be installed, configured, or started.** This Windows build has no verifiable native SID-DACL named-pipe adapter and no `namimail` executable, PATH shim, Broker, headless AgentHost, or client-pairing UI. Do not paste this document's process declaration into an IDE or other MCP client.

## What users can do today

MCP is not an npm package, network service, database file, or a service that can be started from this checkout in the current release. Use the normal Nami Mail desktop UI. Do not run server source, provide a database path, configure `http://127.0.0.1`, or substitute a default Node named pipe for secured IPC.

## Future release prerequisites (non-executable contract)

MCP may be released only after an installed build ships and verifies a native Windows SID-DACL adapter, subject to these requirements:

1. The installer provides a managed `namimail` command and PATH shim.
2. A user may open normal NamiMail or use only the reserved `service start` command to explicitly request AgentHost; queries and MCP itself must never start Runtime implicitly.
3. Every MCP client obtains an independent Ed25519 pairing and read-only account scope in visible NamiMail UI.
4. The MCP child process uses stdio only and can connect only to a paired, current-user-SID-restricted named-pipe Broker.
5. There is no HTTP, TCP, database-file, file-URI, environment-token, or other fallback channel.

Future client private keys must remain in client secure storage. Broker-persisted pairing material will include the client public key, host public key and ID, scopes, and anti-replay counter; revocation must occur in visible NamiMail UI.
