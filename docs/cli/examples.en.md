# CLI Usage Examples

[Chinese](examples.zh-CN.md) | [Agent integration](agent-integration.en.md)

> **Current-build status: runnable.** The 0.3.0 installer ships the `namimail` executable and PATH shim. The examples below run against a paired, running Agent host.

## Local version check

`version` returns non-sensitive local version data without reading mail data or requiring a host:

```text
namimail version
```

```json
{"name":"NamiMail","version":"0.3.0"}
```

## Read-only queries

The CLI allows only paired, scope-limited reads. The seven external commands are `accounts list`, `folders list`, `messages list`, `mail summarize`, `messages get`, `threads get`, and `attachments list`. `acct_work` and date ranges are illustrative values only; an account ID must be inside approved account scope.

```text
namimail accounts list --output json
namimail folders list --account acct_work --output json
namimail messages list --folder INBOX --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail mail summarize --folder INBOX --since 2026-07-01T00:00:00Z --limit 10 --output json
namimail messages get --message msg_1 --output json
namimail threads get --thread thr_1 --output json
namimail attachments list --message msg_1 --output json
```

Scripts must use `--output json`, check `success` before reading `data`, and handle failure using stable `error.code`, `retryable`, and `requestId`. They must not rely on table-column order, human-readable error text, or PowerShell formatting.

## MCP bridge

`mcp start` reserves stdout for MCP stdio and still requires a running, paired host. It does not create pairing, start Runtime implicitly, or fall back to HTTP. See [MCP configuration](../mcp/configuration.en.md) for the client shape.

## Write boundary

External CLI send, reply, forward, delete, move, archive, state-change, draft-edit, and index-rebuild operations return `PERMISSION_DENIED`. A user can complete drafting, review, and one-time confirmation only in visible NamiMail UI; `--yes` does not change that rule.
