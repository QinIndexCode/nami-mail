# CLI Installation Status and Prerequisites

[Chinese](installation.zh-CN.md) | [Back to overview](README.en.md)

> **Current-build status: installed.** The 0.3.0 installer ships a managed `namimail` executable and registers a current-user PATH shim. The desktop main process starts the Broker and routes `--cli` invocations through it; the installer smoke test verifies the shim and a post-install MCP stdio session.

## What users can do today

After installing Nami Mail, run `namimail --help` from a terminal. Local commands (`version`, `help`) work without a running host. Read-only data commands require a running Agent host and a paired client profile with an approved account scope; run `namimail pair` and approve the request in the visible NamiMail window first.

Node.js, `npm run dev`, a SQLite file, a Fastify service, or a guessed named pipe in a development checkout cannot substitute for external Agent IPC and cannot become a CLI/MCP fallback.

The installer's data-retention/deletion choice applies only to desktop-app data; the installer registers a current-user PATH shim that the uninstaller removes.

## Release prerequisites

The installed build meets all of the following requirements:

1. The installer provides a managed `namimail` executable and PATH shim.
2. `namimail version` reports a local version without reading mail data.
3. Only `namimail service start` may explicitly request a headless AgentHost; ordinary queries never start Runtime implicitly.
4. CLI/MCP clients pair independently in visible NamiMail UI and receive a read-only account scope.
5. Clients reach the host only through a current-user-SID-restricted named-pipe Broker; there is no HTTP, TCP, SQLite, filesystem, or renderer-token fallback.

The pairing record binds the client public key, host identity and public key, scopes, account scope, and a durable anti-replay counter. Private keys, public-key PEM, pairing records, pipe paths, and counters must never go into issues, terminal captures, shared repositories, or environment variables. Revocation must also happen in visible NamiMail UI.
