# Agent Runtime

[Chinese](runtime.md) | [English](runtime.en.md)

> **Current-build status: the external Agent runtime cannot start.** The current Windows build has no verifiable native SID-DACL named-pipe adapter, so it provides no external AgentHost, Broker, CLI, service mode, pairing UI, or MCP launcher. The runtime order below is a future fail-closed contract, not an executable flow today. Experimental local NLLB-200 translation remains separate, explicit, and opt-in.

Do not conflate the external Agent runtime with the normal desktop/server runtime. The current normal runtime creates and starts an embedded `AgentService`; the local Fastify GUI API, RAG worker, and React workspace use that path. It is not external IPC, and it has not yet completed release-grade validation for a packaged desktop build, real account/provider paths, deletion and rebuild lifecycle, or the security confirmation flow.

## Responsibility

Runtime composes providers, tools, permissions, citations, and audit into one controlled execution chain. It does not own a second IMAP, SMTP, draft, or database implementation. Every mail write must reuse the existing mail service's idempotent submission and Sent-folder reconciliation semantics.

The released external `AgentHost` will be the sole production owner. The local Fastify service used by the desktop GUI runs the embedded Agent, but it is not external Agent IPC and does not authorize CLI/MCP to use its token or database.

## Future startup order (not executed in the current build)

1. Electron enforces the single-instance rule and obtains the current-user SID.
2. It creates an exclusive SID-DACL named-pipe lease; an unverified adapter fails closed.
3. `AgentHost` unwraps the master key, opens SQLite, and runs compatible Agent-schema migrations.
4. The same host creates sync, source-event, RAG, provider, audit, and confirmation dependencies.
5. It starts the GUI adapter and paired Broker before accepting requests.

Any failure must stop started parts, zero in-memory key copies, and expose no half-started Broker. The current build exits before this flow; when shipped, ordinary CLI commands will never start Runtime and only explicit `service start` may ask the desktop host for service mode.

## Requests and streams

A chat request produces a monotonically sequenced stream: `queued`, model text deltas, tool calls/results, citations, confirmations, usage, errors, and a terminal event. Clients may disconnect or cancel; cancellation reaches provider and tools through `AbortSignal`, while the terminal event remains explainable.

Before a tool runs, Runtime:

1. Resolves and validates its descriptor and input.
2. Computes a default-deny permission decision from `CallerContext`, account scope, and confirmation policy.
3. Writes a durable audit intent for high-risk work; it refuses to execute when no audit store is available.

`AgentRuntime`, stream schemas, tool registry, provider health checks, HTTP GUI routes, actual mail tools, and the embedded workspace have source implementations or independent tests. Source presence and isolated tests still cannot claim delivery: the same build needs packaged-desktop smoke, real account/provider, deletion and rebuild, and confirmation-flow validation.

## Provider calls

Providers receive scope-filtered messages, not the whole mail store. Requests have timeout, cancellation, response-frame, and tool-argument limits. Network, TLS, auth, rate-limit, and server faults map to stable Agent errors and must not mutate local mail state.

Cloud egress needs separate visible user consent. It is not inferred from an API key, CLI flag, or model output. When a provider is absent, not consented, or unhealthy, UI preserves the conversation and presents a recoverable state.

## Future update drain

Before update, the gate synchronously closes ingress, waits for existing permits, then stops Broker, quiesces Runtime/database ownership, and releases the lease. The gate has no TTL; only successful installer handoff or explicit recovery changes a draining state. Failed recovery remains closed rather than accepting requests again.

## Runtime invariants

- Model output is never authorization.
- The current build has no external CLI/MCP path; the future interface must never directly open SQLite, reuse a Fastify token, or send SMTP.
- After an account-generation deletion change, old tasks cannot commit pages, tool results, or confirmations.
- Existing `unknown_delivery` and Sent-folder reconciliation decide send state; Agent must not guess that a message was sent.

See [Permissions and confirmations](permissions.en.md), [RAG consistency](../rag/consistency.en.md), and the [testing plan](../development/testing-plan.en.md).
