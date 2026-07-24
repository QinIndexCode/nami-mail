# Development Guide

[简体中文](DEVELOPMENT.md) | [English](DEVELOPMENT.en.md)

This guide is for contributors who build, test, or modify Nami Mail locally. The project primarily targets Windows desktop while retaining a local web-development workflow.

## Prerequisites

- Node.js 22.14.0 or later.
- Windows, required to build an NSIS installer and verify Electron paths.
- A test account and app-specific password/authorization code for real mail verification. Do not use a primary password or write credentials into code, tests, screenshots, or commits.

Install dependencies from the repository root:

```powershell
npm.cmd ci
```

Copy [`.env.example`](../.env.example) to `.env` and change only the development-service configuration you need. Installed builds read only limited OAuth public configuration from `nami-mail.env`; see the [README](../README.en.md#oauth-configuration) for the complete rules.

## Run Modes

| Purpose | Command | Notes |
| --- | --- | --- |
| Integrate the frontend and local service | `npm.cmd run dev` | Vite defaults to `127.0.0.1:5173`; the local API defaults to `127.0.0.1:3187`. |
| Run the built service | `npm.cmd run build` then `npm.cmd start` | Checks build output and the local static page. |
| Windows desktop app | `npm.cmd run dev:desktop` | Builds the app, verifies Electron's SQLite N-API loading path, and starts Electron. |
| Command-line Node SQLite verification | `npm.cmd run verify:node-sqlite` | Verifies that Node can load the shared Windows x64 N-API module at the repository root. |
| Electron SQLite verification | `npm.cmd run verify:electron-sqlite` | Verifies that Electron can load the same Windows x64 N-API module. |

The project loads `better-sqlite3` in both Node and Electron. Windows x64 v13 uses the `prebuilds/win32-x64.node` N-API prebuilt module, so a root binary no longer needs to be replaced for each ABI and no server ABI cache is created. Before command-line tests or services, use the project script to verify Node's actual loading path. Before running the desktop app or packaging, use `npm.cmd run verify:electron-sqlite` to verify Electron's actual loading path. Do not manually rebuild a module that overwrites the root module while an Electron app is open.

## Repository Layout

| Path | Responsibility |
| --- | --- |
| `apps/web` | React/Vite reading, composing, settings, and provider-guidance UI. |
| `apps/server` | Local Fastify API, IMAP/SMTP, OAuth, SQLite, sync, and encrypted-data handling. |
| `apps/desktop` | Electron main process, preload, local key protection, tray/single-instance behavior, and update boundaries. |
| `scripts` | Native-module verification, builds, installer smoke tests, and GitHub Release validation. |
| `build` | Version-controlled brand and Windows installer resources. |

Do not commit local runtime data or generated output. `data/`, `.env`, the legacy local build directories `release/` and `release-current/`, current versioned output `release-artifacts/`, `artifacts/`, `output/`, SQLite sidecar files, certificates, and key files are excluded by [`.gitignore`](../.gitignore). `build/` contains version-controlled brand assets, installer scripts, and the default empty update-trust configuration. It is source code and must not be excluded by a broad ignore rule.

## Validation Baseline

Run the tests closest to your change first, then run this complete baseline:

```powershell
npm.cmd run build:brand:check
npm.cmd run typecheck
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run build
npm.cmd run smoke:runtime
```

Real Windows installer validation also requires:

```powershell
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win
npm.cmd run smoke:installer
```

Installer smoke creates and removes an isolated installation directory. It refuses to run when an existing Nami Mail installation or process is present. It is not a substitute for testing an upgrade of live user data.

GitHub update releases use a versioned isolated directory so output from different builds cannot be mixed into one Release set:

```powershell
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win:github
```

The variable must be a repository-relative path. It does not replace the requirements in the [Release Guide](RELEASING.en.md) for a public repository, a trust root, and a real previous-version-to-new-version test.

## Change Principles

- Mail HTML, attachment names, server responses, and OAuth callbacks are untrusted input. Keep existing validation, sanitization, and loopback restrictions.
- Storage changes for credentials, refresh tokens, sensitive mail payloads, the send queue, or outbound attachments must preserve encryption and relational-data integrity. Do not log plaintext.
- The local API must serve only same-machine clients. Do not broaden its listen address, CORS origins, or Electron IPC capabilities without an explicit threat model and tests.
- For UI changes, validate desktop, narrow mobile-width windows, light and dark themes, keyboard focus, and selectable mail content.
- For dependency and packaging changes, check the Node ABI, Electron ABI, installation/uninstallation, single-instance behavior, and data-retention paths together.

See the [Contributing Guide](../CONTRIBUTING.en.md) for contribution and review requirements. See the [Release Guide](RELEASING.en.md) for release and signing, and [Architecture and Trust Boundaries](ARCHITECTURE.en.md) for process and data boundaries.
