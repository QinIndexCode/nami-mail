# Architecture and Trust Boundaries
<!-- shipped-as: v0.6.0 -->

[简体中文](ARCHITECTURE.zh-CN.md) | [English](ARCHITECTURE.en.md)

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
        |
        +-- Agent runtime (tool registry, permissions, confirmations) and external MCP
```

The desktop window enables `contextIsolation`, disables `nodeIntegration`, and uses a sandboxed renderer. The access token is not written to a URL, the user-data directory, or ordinary configuration. The main process injects the header only for local `/api/*` requests through `session.webRequest.onBeforeSendHeaders`; the renderer never holds the token itself, and the main-frame check guards the desktop IPC channels. The renderer therefore cannot gain general Node.js or Electron capabilities through it.

## Component Responsibilities

| Location | Responsibility |
| --- | --- |
| `apps/web` | React UI, themes, mail reading/composition, account guidance, and local API client. |
| `apps/web/src/app/mailStore.ts` † | The single client-side store for the mail list's state: row-level state (read/flagged/moved/removed/restored) is owned here; the total is a server snapshot baseline plus small local adjustments (`nextMessageTotalForSnapshot`), and sidebar badges read the `stats` returned by `/api/stats`. Writers only say what changed about a mail instead of maintaining row state. |
| `apps/server` | Fastify routes, IMAP/SMTP, OAuth, provider discovery, sync, drafts/send queue, SQLite, and application-layer encryption; Agent service, tool execution, and permissions. |
| `apps/server/src/tasks/` † | The durable task layer: one `tasks` table, a per-account serial scheduler, and per-kind runners (`move`, `flags`, `undo`, `send`, `snooze`) that converge the locally committed target state to IMAP/SMTP, replacing the deleted `operation_queue`/`batch_jobs`; read-only progress is exposed as `/api/tasks` (`routes/tasks.ts`) and the `/api/batch-jobs` compatibility alias. |
| `apps/server/src/provider/` † | The only seam for IMAP/SMTP transport construction: every ImapFlow and Nodemailer instance is created through one factory, so tests and the desktop host can replace the network implementation without touching call sites. |
| `apps/server/src/folder-counts.ts` † | The single source of sidebar counts: per-folder and unified-inbox numbers derive from the current `messages` rows, replacing the deleted `folders.total`/`folders.unseen` columns. |
| `apps/server/src/db-schema.ts`, `apps/server/src/schema-migrations.ts` † | The two halves of the database shape: `db-schema.ts` is the complete DDL for a fresh database (including generated columns and the FTS/task SQL it composes), while `schema-migrations.ts` holds the old-database migrations that run idempotently in one transaction on every open. |
| `apps/server/src/database-encryption.ts` † | Whole-database encryption at rest: a copy of a plaintext database is converted with `PRAGMA rekey`, verified, then swapped in, covering the FTS shadow tables and the WAL; the image cache and custom background outside the database are sealed per file by `local-file-encryption.ts`, and `native-sqlite.ts` pins the driver to `better-sqlite3-multiple-ciphers`. |
| `apps/server/src/pending-sent.ts` † | The optimistic Sent row: an accepted send writes a local Sent placeholder first, sync claims that row by RFC Message-ID instead of inserting a duplicate, and an unsettled send retracts it. |
| Turn helpers under `apps/server/src/agent/` † | Helpers extracted from the run engine: `conversation-title.ts` (title derivation and the model `TITLE:` output protocol), `turn-payloads.ts` (per-turn outward payload projection), `tool-scope.ts` (tool account-scope normalization), and `openai-compatible-content.ts` (OpenAI-compatible content format). |
| `apps/desktop` | Electron lifecycle, single instance, tray, Windows notifications, DPAPI main key, preload IPC, update checks, and installer helper; Agent Broker, pairing, and the secure pipe. |
| `packages/agent-contracts` | Interface contracts shared by the Agent, CLI, and MCP (External Mail v1 tools, Broker protocol, error codes). |
| `packages/agent-core` | Agent session orchestration and tool-execution core. |
| `build` | Version-controlled brand resources, Windows installer resources, and default empty update-trust configuration. |
| `scripts` | Native SQLite loading verification, builds, installer smoke tests, and Release assets/release-policy validation. |

Entries marked † were added on the 2026-10 trunk and are not part of any release yet; the rest of this page describes released v0.5.1 behavior.

## Data and Process Boundaries

- The desktop local service binds only to the loopback address and a system-assigned port. The development service defaults to `127.0.0.1:3187`.
- The Windows desktop main key is protected for the current Windows user by Electron `safeStorage` using DPAPI. The main process passes the unwrapped key to the server only in memory while starting the local runtime.
- The server uses application-layer AES-256-GCM encryption for credentials, OAuth refresh tokens, sensitive mail payloads, the send queue, and outbound attachments. This is not whole-database SQLite encryption; see [Privacy and Local Data](PRIVACY.en.md) for plaintext metadata and threat boundaries. Whole-database encryption at rest is a trunk-only capability (the † rows above) that has not shipped yet; the rest of this section still describes v0.5.1's released behaviour.
- Mail content, attachment names, server responses, and OAuth callbacks are untrusted input. Changes to parsing, HTML display, attachment downloads, or callbacks must retain existing validation, sanitization, and size limits.
- † **Attachment visibility has exactly one definition (added on the 2026-10 trunk, not shipped with v0.5.1; the one-time metadata backfill for existing mail landed with the same change)**: a `multipart/related` inline part (`related: true` — an embedded body image, signature logo, or tracking pixel) is a body resource, not an attachment. `messages.has_attachments`, `attachment_kinds_json`, the Attachments view and sidebar count, filter rules, and the list paperclip must all derive from the same non-related metadata; the reader's attachment list is the reference implementation. The view and its count additionally collapse a message's per-folder copies into one row by the provider's stable message identity (`remote_id_lookup`), while an explicitly selected folder still shows that folder's own row; this folding rule does not change what counts as an attachment above.
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
