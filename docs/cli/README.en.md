# NamiMail CLI

[Chinese](README.md) | [Installation](installation.en.md) | [Commands](commands.en.md) | [Output](output-schema.en.md) | [Permissions](permissions.en.md) | [Examples](examples.en.md) | [Troubleshooting](troubleshooting.en.md)

> **Current-build status: unavailable.** This Windows build does not ship a verifiable native Windows SID-DACL named-pipe adapter. It therefore starts no external AgentHost or Broker and provides no `namimail` executable, PATH shim, or client-pairing UI. The commands, output, permissions, and examples in this document are a future-release security contract; do not configure or execute them in the current build. Experimental local NLLB-200 translation remains separate and opt-in through the UI.

NamiMail CLI documents the future native automation contract for the Windows desktop application. The planned interface targets scripts and local Agents, with external calls fixed at read-only.

The future interface must not open SQLite, hold the DPAPI-unwrapped master key, reuse a renderer token, or fall back to loopback HTTP/TCP. Once the adapter ships, every request other than local `version` must reach a running `AgentHost` through a paired named-pipe Broker restricted to the current Windows user SID.

## Documentation scope

| Topic | Purpose |
| --- | --- |
| [Installation](installation.en.md) | Windows installation, explicit host startup, and pairing prerequisites. |
| [Commands](commands.en.md) | v1 commands and the write commands deliberately rejected externally. |
| [Parameters](parameters.en.md) | Shared options, types, and parsing rules. |
| [Output](output-schema.en.md) | Stable JSON envelope, JSONL, errors, and exit codes. |
| [Permissions](permissions.en.md) | Scopes, account boundaries, confirmations, and audit. |
| [Agent integration](agent-integration.en.md) | Calling rules for scripts, IDE Agents, and automation. |
| [Examples](examples.en.md) | Copyable read-only workflows. |
| [Troubleshooting](troubleshooting.en.md) | Host, update, pairing, and provider/network failures. |

## v1 boundary

- The current release target is Windows. This documentation makes no macOS or Linux CLI promise.
- `namimail service start` and `namimail mcp start` are reserved future command names; this build ships neither the command nor service mode, so they cannot be run.
- After a verified native adapter ships in the installer, `service start` will be the only lifecycle command permitted to start a headless AgentHost, and `mcp start` will provide a stdio bridge that still requires a running, paired host.
- Sending, replying, forwarding, deleting, moving, archiving, changing message state, creating or editing drafts, and rebuilding the index cannot be completed by the external CLI. `--yes` does not change that rule.
- The experimental local NLLB-200 translation feature remains separate, explicit, and opt-in. It is not a CLI Agent Provider and enabling the CLI never sends mail content to a cloud service.

Protocol, command, and application versions are reported separately. Clients must branch on `protocolVersion`, `success`, and stable error `code`, not on human-readable text.
