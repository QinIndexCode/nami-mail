# CLI Parameters

[Chinese](parameters.zh-CN.md) | [Commands](commands.en.md)

> **Current-build status: implemented.** The 0.3.0 build ships the `namimail` CLI. The options below are live parsing and permission rules; they may be used for current automation.

Options may be written as `--name value` or `--name=value`. An option cannot be repeated. An unknown option or a missing value returns `INVALID_ARGUMENT`. Options follow the command words; positional arguments are rejected.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `--output` | `table`, `json`, `jsonl`, or `text` | `table` | Selects output format. Automation should use `json`. |
| `--profile` | String | `default` | Selects the NamiMail Agent client profile. |
| `--account` | Opaque account ID | Unset | Required by `folders list`; must be inside the paired account scope. |
| `--folder` | Folder path | Unset | Limits a message list to one mailbox. |
| `--limit` | Integer `1..50` | Host default | Limits result count. The CLI validates this range locally. |
| `--since` | ISO 8601 string | Unset | Start boundary; compared as a real instant, offsets are normalized. |
| `--before` | ISO 8601 string | Unset | End boundary; compared as a real instant, offsets are normalized. |
| `--unread` | `true` or `false` | Unset | Filters unread or read messages. |
| `--flagged` | `true` or `false` | Unset | Filters flagged or unflagged messages. |
| `--sender` | String | Unset | Filters messages by sender address or name. |
| `--cursor` | String | Unset | Pagination cursor from a previous response. |
| `--message` | Opaque message ID | Unset | Target message for `messages get` or `attachments list`. |
| `--thread` | Opaque thread ID | Unset | Target thread for `threads get`. |

## Parsing and scope

- The CLI parses only `--limit` as a number. Account, message, thread, folder, and time formats are validated by the host Tool Schema.
- Supplying `--account` never expands authority. The account must be inside the paired client's account scope or the host returns `SCOPE_DENIED`.
- Omitting `--account` does not mean every account is readable. The host still filters by pairing scope and caller account scope.
- Request values must not contain tokens, passwords, OAuth callback values, private keys, or full attachment content. CLI audit records use restricted summaries and `requestId`, not those secrets.

## Example

```text
namimail messages list --folder INBOX --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail folders list --account acct_work --output table
```

Do not use undeclared `--server`, `--database`, `--token`, `--query`, `--yes`, or URL options. The NamiMail interface accepts no externally supplied HTTP endpoint or database path.
