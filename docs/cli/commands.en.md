# CLI Commands

[Chinese](commands.zh-CN.md) | [Parameters](parameters.en.md) | [Output](output-schema.en.md)

> **Current-build status: implemented.** The 0.3.0 installer ships a managed `namimail` command and PATH shim. The syntax and command names below are live; data commands require a running, paired Agent host.

Syntax:

```text
namimail <group> <action> [options]
```

Every data command except `version` and `help` requires a running, paired host. The command parser validates shared options and rejects `--yes` for external commands. The host Tool Schema validates account, message, folder, query, and write-input requirements and returns `INVALID_ARGUMENT` or `TOOL_INPUT_INVALID` when they do not match.

## Implemented commands

| Command | Purpose | External access | Typical input |
| --- | --- | --- | --- |
| `version` | Returns the NamiMail name and application version. | Local | None |
| `help` | Shows command help. | Local | Optional command words |
| `doctor` | Reports client, host, and Broker availability. | Read-only | None |
| `status` | Returns host and Agent state. | Read-only | None |
| `accounts list` | Lists the accounts approved for the paired caller. | Read-only | None |
| `folders list` | Lists folders for one account. | Read-only | `--account` |
| `messages list` | Lists message metadata. | Read-only | `--folder`, `--limit`, `--since`, `--before`, `--unread`, `--flagged`, `--sender`, `--cursor` |
| `mail summarize` | Fetches a compact digest of recent matching mail. | Read-only | `--folder`, `--limit`, `--since`, `--before`, `--unread`, `--sender` |
| `messages get` | Reads bounded plain-text content for one message. | Read-only | `--message` |
| `messages batch-get` | Reads bounded plain-text content for up to 10 messages. | Read-only | `--message` (comma-separated ids, 1-10) |
| `threads get` | Reads bounded plain-text content for one thread. | Read-only | `--thread` |
| `attachments list` | Lists attachment metadata for one message. | Read-only | `--message` |
| `draft create` | Creates a draft for one account inside the paired caller's scope. | By access level | `--account`, `--to` (at least one), `--cc`, `--subject`, `--body` |
| `draft update` | Replaces the recipients, subject, or body of one draft. | By access level | `--account`, `--draft`, `--to`, `--cc`, `--subject`, `--body` |
| `draft delete` | Deletes one draft inside the paired caller's scope. | By access level | `--account`, `--draft` |
| `messages move` | Moves one message to the archive or trash. | By access level | `--message`, `--target` (`archive`\|`trash`) |
| `messages set-flag` | Sets the seen or flagged state of one message. | By access level | `--message`, `--flag` (`seen`\|`flagged`), `--value` (`true`\|`false`) |
| `messages send` | Composes and sends one message. | By access level | `--account`, `--to`, `--cc`, `--subject`, `--body` |
| `mail reply` | Creates a reply draft for one original message. | By access level | `--account`, `--message`, `--to`, `--cc`, `--subject`, `--body` |
| `mcp start` | Starts the MCP stdio bridge. | Launcher | `--profile`, `--output` |
| `service start` | Explicitly starts the packaged headless AgentHost. | Launcher | `--output` |
| `service stop` | Stops the running AgentHost. | Launcher | `--profile`, `--output` |
| `service restart` | Restarts the AgentHost. | Launcher | `--profile`, `--output` |
| `pair` | Pairs a client profile with an approved read-only account scope. | Launcher | `--profile`, `--output` |
| `revoke` | Revokes a paired client profile. | Launcher | `--profile`, `--output` |

Recipient options accept `address` or `Name <address>` and are comma-separated. Write commands are available only when the CLI permission is `send-confirmed` or above (default `read-only`; see [Permissions](permissions.en.md)).

`--account`, `--folder`, `--limit`, `--since`, `--before`, `--unread`, `--flagged`, `--sender`, and `--cursor` narrow a read-only query; they never expand the paired client's approved account scope, and write commands that take `--account` must keep the account inside that scope.

`mcp start` reserves stdout for MCP stdio and still requires a running, paired host. `service start` is the only lifecycle command permitted to explicitly start a headless AgentHost; neither command reads mail data itself.

## Write commands rejected by default (only when the CLI permission is read-only)

The following write commands return `PERMISSION_DENIED` and are not forwarded to the Broker when the CLI permission is `read-only` (the default level):

```text
draft create | draft update | draft delete
messages move | messages set-flag | messages send
mail reply | mail forward | mail send
mail archive | mail trash | mail mark-read | mail mark-unread
rag rebuild
```

After raising the CLI permission in desktop settings to "confirm before operations" (`send-confirmed`), these commands are available, but every write raises a visible confirmation in the Nami Mail desktop app; the confirmation binds an immutable content digest, account generation, and one-time token, and must be approved by the user in the UI. `--yes` is not an authorization token: the parser rejects `--yes` for external commands, so confirmation cannot be bypassed. At the "fully automatic" (`full-access`) level, writes execute automatically without per-item confirmation, but scope and audit still apply.

The success `data` for each command is defined by the host-registered schema. Scripts must treat it as command-specific JSON, never treat table or text output as an API. See the full envelope in [Output schema](output-schema.en.md).
