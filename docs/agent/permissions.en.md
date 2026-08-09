# Permissions and Confirmations

[Chinese](permissions.zh-CN.md) | [English](permissions.en.md)

## Default deny

Permission decisions live in the host, never in a model, prompt, CLI frontend, or MCP client. Each call checks caller identity, access level, required scopes, account scope, external availability, and confirmation policy. A missing condition denies the call.

`CallerContext` binds at least `callerId`, entry point, access level, scopes, account scope, interactivity, and session. GUI sessions or the paired Broker construct it; external input cannot self-assign greater privilege.

| Access level | Maximum reachable capability |
| --- | --- |
| `read-only` | Read-only tools within authorized scope |
| `send-confirmed` | Every write (including sending) requests a one-time confirmation in the UI each time |
| `full-access` | Runs all operations automatically (including sending and deletion) without per-action confirmation; never bypasses scope or audit |

`accountScope` is `none`, `selected`, or `all`. A selected scope must never expand through an omitted parameter, bulk list, thread reference, or RAG result.

## One-time GUI confirmation

Confirmation policy depends on the access level: `read-only` never confirms (writes are rejected); `send-confirmed` requests a visible one-time immutable confirmation in the in-app UI for every write (including sending); `full-access` requires the user to read an explicit warning and confirm before enabling, then runs automatically without per-action confirmation. A confirmation record is an immutable event, not an editable boolean.

The request snapshot contains an action title, human-readable summary, key fields, accounts, tool, `requestId`, immutable payload hash, and expiry. Approval must match:

1. The same confirmation ID and request ID.
2. The same authorized interactive GUI caller.
3. The unchanged payload hash.
4. A still-valid account generation and unexpired record.
5. A one-time token not already consumed.

Rejection, cancellation, expiry, content change, account deletion, or prior consumption invalidates confirmation. GUI unavailability, CLI, MCP, automation, `--yes`, and model tool calls cannot approve it.

## Audit

High-risk work writes a durable intent before execution, then appends confirmation, success, failure, or cancellation events. Audit records are immutable; encrypted details keep only sufficient explanatory summaries, never keys, tokens, passwords, full bodies, or attachments.

Audit must answer who requested which tool from which entry point, with which scope, whether it was confirmed, result/error code, and time. It cannot bypass a deleted account key or restore original mail content.

## External callers

Each of the three entry points configures its access level independently: the built-in Agent uses `agentAccessLevel` (`send-confirmed` by default), the external CLI uses `agentCliAccessLevel` (`read-only` by default), and the external MCP uses `agentMcpAccessLevel` (`read-only` by default). All three use the levels `read-only` / `send-confirmed` / `full-access`; they are set in the "Permissions" group of the desktop settings with three adjacent dropdowns, and CLI and MCP are two independent settings with identical content.

CLI/MCP v1 supports the same three-level model. Permission decisions live in the host: the host constructs the external caller's access level and clamps it to the configured level, and a paired client cannot raise its own; a request beyond the configured level returns `PERMISSION_DENIED`. CLI `--yes`, MCP arguments, or model tool calls can neither confirm nor elevate. At `send-confirmed`, every write pops a visible one-time immutable confirmation in the desktop app; at `full-access`, the user must read an explicit warning in the UI and confirm before enabling, after which all operations (including sending and deletion) run automatically within the approved account scope while scope and audit still apply. The built-in Agent's `full-access` also requires a warning before enabling.

## Error semantics

- `PERMISSION_DENIED`: access level or scope is insufficient.
- `SCOPE_DENIED`: target account is outside caller scope.
- `NOT_SUPPORTED`: the tool is not available to external callers (e.g. `messages.search`, `rag.*`, `agent.chat`, `agent.run`, attachment export).
- `CONFIRMATION_REQUIRED`: the action needs a running GUI confirmation.
- `BROKER_SECURITY_UNAVAILABLE`: secure local IPC cannot be proven and cannot degrade.

See [Security](security.en.md) and [Tools](tools.en.md).
