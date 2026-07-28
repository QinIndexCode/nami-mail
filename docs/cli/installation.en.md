# CLI Installation Status and Future Prerequisites

[Chinese](installation.md) | [Back to overview](README.en.md)

> **Current-build status: the CLI cannot be installed or started.** This Windows build ships no verifiable native SID-DACL named-pipe adapter and installs no `namimail` executable, PATH shim, headless AgentHost, Broker, or client-pairing UI. Do not run, copy, create, or configure `namimail`; it is not a supported entry point in the current release.

## What users can do today

Use the normal Nami Mail desktop UI for mail and settings. Node.js, `npm run dev`, a SQLite file, a Fastify service, or a guessed named pipe in a development checkout cannot substitute for external Agent IPC and cannot become a CLI/MCP fallback.

The installer's data-retention/deletion choice still applies only to desktop-app data; the current installer has no CLI shim to repair, copy, or remove.

## Future release prerequisites (non-executable contract)

Until an installed build ships and verifies a native Windows SID-DACL adapter, none of the following may be presented as available:

1. The installer provides a managed `namimail` executable and PATH shim.
2. `namimail version` reports a local version without reading mail data.
3. Only `namimail service start` may explicitly request a headless AgentHost; ordinary queries must never start Runtime implicitly.
4. CLI/MCP clients can pair independently in visible NamiMail UI and receive a read-only account scope.
5. Clients reach the host only through a current-user-SID-restricted named-pipe Broker; there is no HTTP, TCP, SQLite, filesystem, or renderer-token fallback.

The future pairing record must bind the client public key, host identity and public key, scopes, account scope, and a durable anti-replay counter. Private keys, public-key PEM, pairing records, pipe paths, and counters must never go into issues, terminal captures, shared repositories, or environment variables. Revocation must also happen in visible NamiMail UI.
