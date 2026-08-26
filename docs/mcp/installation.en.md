# MCP Installation Status and Prerequisites

[Chinese](installation.zh-CN.md) | [Configuration](configuration.en.md)

> **Current-build status: installed and startable.** The 0.3.0 installer ships the native SID-DACL named-pipe Broker, the `namimail` executable, a PATH shim, the headless AgentHost service mode, and the client-pairing UI. The process declaration below can be pasted into an IDE or other MCP client.

## What users can do today

MCP is not an npm package, network service, or database file. After installing Nami Mail, keep an Agent host running (open the desktop app or run `namimail service start`), pair the client profile with `namimail pair` and approve it in the visible window, then configure the MCP client with the stdio command in [Configuration](configuration.en.md). Do not run server source, provide a database path, configure `http://127.0.0.1`, or substitute a default Node named pipe for secured IPC.

## Release prerequisites

The installed build meets all of the following requirements:

1. The installer provides a managed `namimail` command and PATH shim.
2. A user may open normal NamiMail or use only the `service start` command to explicitly request AgentHost; queries and MCP itself never start Runtime implicitly.
3. Every MCP client obtains an independent Ed25519 pairing and read-only account scope in visible NamiMail UI.
4. The MCP child process uses stdio only and can connect only to a paired, current-user-SID-restricted named-pipe Broker.
5. There is no HTTP, TCP, database-file, file-URI, environment-token, or other fallback channel.

Client private keys must remain in client secure storage. Broker-persisted pairing material includes the client public key, host public key and ID, scopes, and anti-replay counter; revocation must occur in visible NamiMail UI.
