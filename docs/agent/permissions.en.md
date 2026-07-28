# Permissions and Confirmations

[Chinese](permissions.md) | [English](permissions.en.md)

## Default deny

Permission decisions live in the host, never in a model, prompt, CLI frontend, or MCP client. Each call checks caller identity, access level, required scopes, account scope, external availability, and confirmation policy. A missing condition denies the call.

`CallerContext` binds at least `callerId`, entry point, access level, scopes, account scope, interactivity, and session. GUI sessions or the paired Broker construct it; external input cannot self-assign greater privilege.

| Access level | Maximum reachable capability |
| --- | --- |
| `read-only` | Read-only tools within authorized scope |
| `draft-only` | Reads and draft tools |
| `mail-write` | Non-high-risk mail writes, still scoped and policy-bound |
| `send-confirmed` | High-risk actions may request GUI confirmation |
| `full-access` | Still never bypasses scope, audit, or confirmation |

`accountScope` is `none`, `selected`, or `all`. A selected scope must never expand through an omitted parameter, bulk list, thread reference, or RAG result.

## One-time GUI confirmation

Send, forward, permanent delete, bulk writes, move/state changes when a descriptor requires it, and cloud mail-content egress require visible in-app confirmation. A confirmation record is an immutable event, not an editable boolean.

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

CLI/MCP v1 is read-only. Broker pairing proves a local caller identity and scope; it does not grant write power. Even if external writes are designed later, they need separate product approval, least scope, revocable pairing, durable audit, and visible one-time confirmation. A compatibility flag will not enable them.

## Error semantics

- `PERMISSION_DENIED`: access level or scope is insufficient.
- `SCOPE_DENIED`: target account is outside caller scope.
- `READ_ONLY`: an external entry point attempted a write.
- `CONFIRMATION_REQUIRED`: the action needs a running GUI confirmation.
- `BROKER_SECURITY_UNAVAILABLE`: secure local IPC cannot be proven and cannot degrade.

See [Security](security.en.md) and [Tools](tools.en.md).
