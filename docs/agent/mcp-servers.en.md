# Connecting External MCP Servers (NamiMail Agent)

[简体中文](mcp-servers.zh-CN.md) | [Usage guide](usage.en.md) | [Model configuration](providers.en.md)

The mail assistant acts as an MCP client and connects to external MCP servers launched over stdio (such as Claude Code, filesystem, GitHub, etc.), calling their tools during conversations to extend its capabilities.

## Quick Start

1. Open the NamiMail Agent workspace and go to **Settings → MCP servers**.
2. Click **Add server**, fill in the display name and launch command (e.g. `npx -y @modelcontextprotocol/server-filesystem`).
3. Click **Save and check**; once the handshake and tool discovery succeed, the server status becomes "Connection verified".
4. Keep **Enable this server** on; from then on, the assistant connects and loads its tools automatically when a conversation starts.

Disabled or deleted servers never load their tools into conversations.

## Configuration Fields

| Field | Description |
| --- | --- |
| Display name | Only used to distinguish servers within Nami Mail |
| Launch command | A local executable or installed command such as npx, python, node |
| Launch arguments | One argument per line, matching command-line arguments one-to-one; each argument is at most 1,024 characters |
| Environment variables | One per line; values are written only to local encrypted storage and never echoed; deleting a row removes a saved variable (names allow letters, digits, and underscores and cannot start with a digit; values are at most 8,192 characters) |
| Working directory | Optional; the working directory of the server process, at most 2,048 characters |
| Connection timeout | In milliseconds, 5,000 to 180,000 |
| Enable this server | When off, the assistant does not connect to this server or load its tools |

Environment variables are merged as "system environment + server configuration" into the server process. When updating a server, environment variables that were not explicitly changed are preserved — editing only the label or timeout never wipes saved secrets.

## Tool Loading and Naming

- Once enabled, the server's tools are loaded automatically at the start of a conversation; tools appear as "server prefix + tool name", e.g. `mcp-server-xxx.get_weather`.
- A single server loads at most 100 tools; individual MCP responses are size-bounded, and oversized results are truncated at a safety limit.
- After a configuration change, the server reconnects by configuration fingerprint to avoid unnecessary reconnects.

## Read/Write Classification and Confirmation

- **Read-only tools**: only tools that explicitly declare read-only and non-destructive annotations run without confirmation.
- **Write tools**: everything else is treated as a write tool — the desktop UI asks for confirmation before execution, and external callers (CLI/MCP bridge) cannot see or invoke them.
- Tool inputs are validated against their schema before execution; invalid inputs never reach the server.

## Cloud Mail-Content Consent

- External MCP tools that never touch mail data remain available to conversations even when cloud mail content is not authorized.
- Built-in mail tools (reading, drafts, etc.) stay behind the cloud-consent gate: without consent, a cloud model cannot read mail through any built-in tool.
- Connecting external MCP servers therefore never bypasses the cloud-consent boundary for mail data.

## Security and Troubleshooting

- Server commands run locally and may read/write local files or call external services; only add servers you trust.
- Environment variables (often API keys) are encrypted on disk; the interface returns only variable names, never values.
- Deleting a server requires a second confirmation; deleting removes both the local configuration and its secrets.

Common errors:

| Message | Cause and fix |
| --- | --- |
| Connection failed | Wrong launch command, arguments, working directory, or environment variables; fix and retry |
| Handshake failed | The server is not compatible with MCP protocol 2025-03-26, or the process exited after initialization |
| Timeout | The server did not respond within the timeout; check the command and status, or increase the connection timeout |
| Configuration changed during check | The configuration was modified while saving; save and check again |

## Related Documentation

- [Model provider configuration](providers.en.md): configuring the model and cloud consent for the assistant.
- [Usage guide](usage.en.md): conversations, mail scope, and the confirmation flow.
- [Runtime](runtime.en.md) and [Security](security.en.md): the MCP tool execution chain and security boundaries.
