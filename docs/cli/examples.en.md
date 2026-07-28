# Future CLI Usage Examples

[Chinese](examples.md) | [Agent integration](agent-integration.en.md)

> **Current-build status: the examples below cannot run.** The current installer has no `namimail` executable, PATH shim, AgentHost, Broker, or pairing entry point. They define behavior only after a verified native Windows SID-DACL adapter ships and must not be copied into a terminal or automation configuration.

## Future local version check

After the adapter ships, the reserved `version` command will be able to return non-sensitive local version data like this without reading mail data:

```json
{"name":"NamiMail","version":"0.2.2"}
```

## Future read-only queries

The released CLI will allow only paired, scope-limited reads. The contract includes searching mail by account, querying a ready RAG index, and reporting success, failure, and `requestId` in a JSON envelope. `acct_work`, query text, and date range are illustrative values only; an account ID must be inside approved account scope.

Future scripts must use `--output json`, check `success` before reading `data`, and handle failure using stable `error.code`, `retryable`, and `requestId`. They must not rely on table-column order, human-readable error text, or PowerShell formatting.

## Future MCP bridge

After release, `mcp start` will reserve stdout for MCP stdio and still require a running, paired host. It will not create pairing, start Runtime implicitly, or fall back to HTTP. See [MCP configuration](../mcp/configuration.en.md) for the future client shape.

## Write boundary

Even after release, external CLI send, reply, forward, delete, move, archive, state-change, draft-edit, and index-rebuild operations must return `PERMISSION_DENIED`. A user can complete drafting, review, and one-time confirmation only in visible NamiMail UI; `--yes` does not change that rule.
