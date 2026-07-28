# CLI Parameters

[Chinese](parameters.md) | [Commands](commands.en.md)

> **Future contract, not executable today.** The current build has no `namimail` CLI, external Broker, or pairing entry point. The options below define parsing and permission rules only after a verified native Windows SID-DACL adapter ships; do not use them for current automation.

After the interface ships, options may be written as `--name value` or `--name=value`. An option cannot be repeated. An unknown option, a missing value, or using both `--interactive` and `--non-interactive` will return `INVALID_ARGUMENT`. Options follow the command words; content after `--` is passed to the host unchanged as positionals.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `--output` | `table`, `json`, `jsonl`, or `text` | `table` | Selects output format. Automation should use `json`. |
| `--account` | Opaque account ID | Unset | Limits work to one authorized account. |
| `--folder` | Folder ID or host-recognized reference | Unset | Limits a message list or search location. |
| `--limit` | Integer `1..1000` | Host default | Limits result count. The CLI validates this range locally. |
| `--since` | String | Unset | Start boundary interpreted by the host schema. |
| `--before` | String | Unset | End boundary interpreted by the host schema. |
| `--query` | String | Unset | Search, RAG, or Agent request. |
| `--message` | Opaque message ID | Unset | Target message. |
| `--thread` | Opaque thread ID | Unset | Target thread. |
| `--attachment` | Opaque attachment ID | Unset | Target attachment. |
| `--dry-run` | Boolean flag | `false` | Requests host-supported preview behavior. It grants no write permission. |
| `--yes` | Boolean flag | `false` | States willingness to continue a non-sensitive flow. It cannot bypass permission or GUI confirmation. |
| `--interactive` | Boolean flag | `false` | Marks a caller as able to present interaction. External v1 still cannot request a write confirmation. |
| `--non-interactive` | Boolean flag | `false` | Explicitly disables interaction. It cannot be combined with `--interactive`. |

## Parsing and scope

- The CLI parses only `--limit` as a number. The Broker-side Tool Schema validates real account, message, thread, folder, attachment, and time formats.
- Supplying `--account` never expands authority. The account must be inside the paired client's account scope or the host returns `SCOPE_DENIED`.
- Omitting `--account` does not mean every account is readable. The host still filters by pairing scope and caller account scope.
- Request values must not contain tokens, passwords, OAuth callback values, private keys, or full attachment content. CLI audit records use restricted summaries and `requestId`, not those secrets.

## Future example (not executable)

```text
namimail messages search --account acct_work --query "invoice" --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail rag search --query "renewal date" --limit 5 --output json
```

Do not use undeclared `--server`, `--database`, `--token`, or URL options. The future NamiMail interface will accept no externally supplied HTTP endpoint or database path.
