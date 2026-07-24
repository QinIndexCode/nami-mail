# Architecture and Trust Boundaries

[简体中文](ARCHITECTURE.md) | [English](ARCHITECTURE.en.md)

This guide is for contributors and maintainers. It describes Nami Mail's current local runtime structure, process boundaries, and principal trust assumptions. It is a code guide, not a replacement for [Privacy and Local Data](PRIVACY.en.md), the [Security Policy](../SECURITY.en.md), or the [Windows Release Guide](RELEASING.en.md).

## Runtime Structure

Nami Mail does not operate a project-hosted mail service. The Windows installed build uses Electron to start a Fastify runtime that serves only the local window. Web development mode starts the same frontend and local service directly.

```text
React / Vite UI
        |
        | Desktop build: restricted preload IPC
        v
Electron main process
        |
        | Per-start local API access token
        v
Fastify local service (127.0.0.1; dynamic port for desktop)
        |                         |
        |                         +-- SQLite and encrypted-data directory
        |
        +-- IMAP / SMTP / DNS / OAuth providers
```

The desktop window enables `contextIsolation`, disables `nodeIntegration`, and uses a sandboxed renderer. The access token is not written to a URL, the user-data directory, or ordinary configuration. The main process gives the page local API request headers through restricted preload IPC only after verifying that the caller is the local main frame of the current main window. The renderer can therefore use it only for local `/api/*` requests; it cannot gain general Node.js or Electron capabilities through it.

## Component Responsibilities

| Location | Responsibility |
| --- | --- |
| `apps/web` | React UI, themes, mail reading/composition, account guidance, and local API client. |
| `apps/server` | Fastify routes, IMAP/SMTP, OAuth, provider discovery, sync, drafts/send queue, SQLite, and application-layer encryption. |
| `apps/desktop` | Electron lifecycle, single instance, tray, Windows notifications, DPAPI main key, preload IPC, update checks, and installer helper. |
| `build` | Version-controlled brand resources, Windows installer resources, and default empty update-trust configuration. |
| `scripts` | Native SQLite loading verification, builds, installer smoke tests, and Release assets/release-policy validation. |

## Data and Process Boundaries

- The desktop local service binds only to the loopback address and a system-assigned port. The development service defaults to `127.0.0.1:3187`.
- The Windows desktop main key is protected for the current Windows user by Electron `safeStorage` using DPAPI. The main process passes the unwrapped key to the server only in memory while starting the local runtime.
- The server uses application-layer AES-256-GCM encryption for credentials, OAuth refresh tokens, sensitive mail payloads, the send queue, and outbound attachments. This is not whole-database SQLite encryption; see [Privacy and Local Data](PRIVACY.en.md) for plaintext metadata and threat boundaries.
- Mail content, attachment names, server responses, and OAuth callbacks are untrusted input. Changes to parsing, HTML display, attachment downloads, or callbacks must retain existing validation, sanitization, and size limits.
- Electron uses a single-instance lock. Opening the application again restores and focuses the existing window instead of starting another local service, database, or sync task.

## Updates and Closing

Production Windows releases obtain ZIP update packages from public GitHub Releases. The update path establishes trust through the Authenticode identity of the current installer or an embedded Ed25519 public key; it does not accept arbitrary download URLs. See the [Release Guide](RELEASING.en.md) for assets, signing requirements, cache cleanup, failure recovery, and real previous-version-to-new-version validation.

When closing a window, the user can choose to exit or minimize to the tray. When minimized to the tray, the local service continues syncing and can show notifications. Before exit or update, the local service must be stopped so SQLite, sync, and the send queue cannot be accessed concurrently during installation.

## Change Rules

1. For UI changes, validate desktop, narrow windows, light and dark themes, focus order, and selectable mail content.
2. For server protocol or data changes, validate network/TLS error classification, idempotency, migration compatibility, and that sensitive data does not become plaintext at rest.
3. For Electron changes, validate single-instance behavior, tray behavior, closing behavior, safe shutdown before update, and SQLite loading paths in both the Node and Electron runtimes.
4. For release or update changes, validate asset integrity, the signing trust root, and the real installed path. Unit tests or a draft Release cannot replace real online upgrade acceptance.

See the [Development Guide](DEVELOPMENT.en.md) for development commands and the validation baseline, and the [Contributing Guide](../CONTRIBUTING.en.md) for collaboration rules.
