# CLI Commands

[Chinese](commands.md) | [Parameters](parameters.en.md) | [Output](output-schema.en.md)

> **Future contract, not executable today.** The current installer has no `namimail` command, PATH shim, startable AgentHost, or Broker. The syntax and command names below are reserved for an interface released with a verified native Windows SID-DACL adapter. Do not copy them into a terminal.

Future syntax:

```text
namimail <group> <action> [options] [-- <positionals...>]
```

After the interface ships, every data command except `version` will require a running, paired host. The command parser will validate shared options only. The host Tool Schema will validate account, message, folder, and query requirements and return `INVALID_ARGUMENT` or `TOOL_INPUT_INVALID` when they do not match.

## Reserved commands (future)

| Command | Future purpose | Future external access | Typical input |
| --- | --- | --- | --- |
| `version` | Will return the NamiMail name and application version. | Local | None |
| `doctor` | Will report client, host, and Broker availability. | Read-only | None |
| `status` | Will return host and Agent state. | Read-only | None |
| `accounts list` | Lists authorized accounts. | Read-only | `--account` narrows scope |
| `folders list` | Lists folders. | Read-only | `--account` |
| `messages list` | Lists message metadata. | Read-only | `--account`, `--folder`, `--limit`, time range |
| `messages get` | Reads one message and content allowed by the host. | Read-only | `--message`, `--account` |
| `messages search` | Searches mail with structured criteria. | Read-only | `--query`, range, `--limit` |
| `threads get` | Reads a thread. | Read-only | `--thread`, `--account` |
| `attachments list` | Lists attachment metadata. | Read-only | `--message`, `--account` |
| `attachments export` | Exports an attachment allowed for reading. | Read-only | `--attachment`, `--message`, `--account` |
| `rag search` | Searches a ready index within account scope. | Read-only | `--query`, `--account`, `--limit` |
| `rag status` | Returns indexing state. | Read-only | `--account` |
| `rag verify` | Verifies index consistency. | Read-only | `--account` |
| `agent chat` | Runs read-only chat subject to existing Provider and privacy consent. | Read-only | Query or positionals |
| `agent run` | Executes one read-only Agent request. | Read-only | Query or positionals |
| `mcp start` | Starts the MCP bridge on stdio. | Read-only bridge | None |
| `service start` | Explicitly starts the packaged headless AgentHost. | Lifecycle | None |

Neither `mcp start` nor `service start` reads mail data itself. Once the adapter ships, the former will not auto-start a host and the latter will be the only command permitted to explicitly start one; neither can run in the current build.

## Rejected write commands

The following names are retained for consistent product semantics. Once the interface ships, v1 external CLI will return `PERMISSION_DENIED` without forwarding the request to the Broker:

```text
drafts create | drafts update | drafts delete
mail reply | mail forward | mail send
mail archive | mail move | mail trash
mail mark-read | mail mark-unread
rag rebuild
```

`--yes`, `--interactive`, a paired identity, and model output cannot relax this rule. A user must initiate and approve an action requiring confirmation in NamiMail's visible Agent workspace. The confirmation binds an immutable content digest, account generation, and one-time token.

The future success `data` for each command is defined by the host-registered schema. Scripts must treat it as command-specific JSON, never treat table or text output as an API. See the full envelope in [Output schema](output-schema.en.md).
