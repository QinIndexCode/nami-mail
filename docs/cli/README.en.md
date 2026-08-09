# NamiMail CLI

[Chinese](README.zh-CN.md) | [Installation](installation.en.md) | [Commands](commands.en.md) | [Output](output-schema.en.md) | [Permissions](permissions.en.md) | [Examples](examples.en.md) | [Troubleshooting](troubleshooting.en.md)

> **Current-build status: available.** The 0.3.0 installer ships a managed `namimail` executable and registers a current-user PATH shim. The desktop main process starts a secured Windows named-pipe Broker and routes `--cli` invocations through it; the installer smoke test also verifies a post-install MCP stdio session that reports exactly fifteen tools (eight read-only and seven write). Data commands require a running, paired Agent host. Experimental local NLLB-200 translation remains separate and opt-in through the UI.

NamiMail CLI documents the native automation contract for the Windows desktop application. External calls are read-only by default; the desktop settings can raise the CLI permission to "confirm before operations" (`send-confirmed`) or "fully automatic" (`full-access`) — see [Permissions](permissions.en.md).

The CLI never opens SQLite, never holds the DPAPI-unwrapped master key, never reuses a renderer token, and never falls back to loopback HTTP/TCP. Every request other than local `version` reaches a running `AgentHost` through a paired named-pipe Broker restricted to the current Windows user SID.

## Documentation scope

| Topic | Purpose |
| --- | --- |
| [Installation](installation.en.md) | Windows installation, explicit host startup, and pairing prerequisites. |
| [Commands](commands.en.md) | The implemented v1 commands and the write commands rejected by default (only when the CLI permission is read-only). |
| [Parameters](parameters.en.md) | Shared options, types, and parsing rules. |
| [Output](output-schema.en.md) | Stable JSON envelope, JSONL, errors, and exit codes. |
| [Permissions](permissions.en.md) | Scopes, account boundaries, confirmations, and audit. |
| [Agent integration](agent-integration.en.md) | Calling rules for scripts, IDE Agents, and automation. |
| [Examples](examples.en.md) | Copyable read-only workflows. |
| [Troubleshooting](troubleshooting.en.md) | Host, update, pairing, and provider/network failures. |

## v1 boundary

- The current release target is Windows. This documentation makes no macOS or Linux CLI promise.
- `namimail service start` explicitly starts the packaged headless AgentHost, and `namimail mcp start` starts the MCP stdio bridge. Both are implemented in the 0.3.0 build. Neither starts Runtime implicitly.
- The eight external read commands (`accounts list`, `folders list`, `messages list`, `mail summarize`, `messages get`, `messages batch-get`, `threads get`, `attachments list`) are implemented and require a running, paired host with an approved account scope; the CLI defaults to the read-only level.
- The external CLI is read-only by default. After raising the CLI permission in desktop settings to "confirm before operations" (`send-confirmed`) or "fully automatic" (`full-access`), the seven write commands (`draft create`, `draft update`, `draft delete`, `messages move`, `messages set-flag`, `messages send`, `mail reply`) become available. `--yes` cannot bypass confirmation: the parser rejects `--yes` for external commands at every level.
- The experimental local NLLB-200 translation feature remains separate, explicit, and opt-in. It is not a CLI Agent Provider and enabling the CLI never sends mail content to a cloud service.

Protocol, command, and application versions are reported separately. Clients must branch on `protocolVersion`, `success`, and stable error `code`, not on human-readable text.
