/**
 * The single source of truth for the `code` field the local HTTP API puts on an
 * error body.
 *
 * Before this module every route spelled its own string literal, so the same
 * meaning reached the wire under three shapes: a zod failure answered
 * `invalid_argument` on one route and `invalid_request` on another, a missing
 * resource answered `not_found` on one route and no `code` at all on the rest,
 * and an Agent failure answered the upper-snake `AgentServiceError` code. A
 * client could not branch on `code` without a per-route, per-case table.
 *
 * The vocabulary is deliberately a *routing-layer* module rather than a
 * contracts package. `docs/TRANSLATION-API` states that the loopback Fastify service
 * is a protected desktop-renderer protocol, not a third-party API, and it
 * promises only that callers "must branch on HTTP status and a stable `code`" —
 * it never enumerates the values. Putting the list in `@nami/agent-contracts`
 * would publish the renderer's private vocabulary as if it were the external
 * Mail v1 contract, and would make the frozen Agent/Broker vocabulary below
 * look renameable from the server side.
 *
 * Four families reach the wire, and only the first one is owned here:
 *
 * 1. `ROUTE_ERROR_CODES` — this module. Lower-snake, one code per meaning.
 * 2. `MAIL_ERROR_CODES` — mail transport classification, owned by `../mail.js`.
 * 3. `OAUTH_ERROR_CODES` / `TRANSLATION_SERVICE_ERROR_CODES` — typed unions in
 *    `../oauth.js` / `../translation.js` that have no runtime array, so they
 *    are spelled out here and pinned to their union by `satisfies` plus the
 *    `Exclude` probes below. A member added upstream without a row here is a
 *    compile error, not a silent wire change.
 * 4. `AGENT_ERROR_CODES` — the Agent/Broker vocabulary from
 *    `@nami/agent-contracts`. It is UPPER_SNAKE and it is FROZEN: it is the
 *    documented external Mail v1 vocabulary (docs/EXTERNAL-MAIL-INTERFACE,
 *    docs/cli/output-schema, docs/mcp/security, docs/cli/permissions) and the
 *    renderer branches on it case-sensitively (`AgentWorkspace.tsx` and
 *    `agent/agent-utils.ts` compare against the literal "NOT_FOUND",
 *    `AgentMcpServerPane.tsx` against "SERVER_CHANGED",
 *    `AgentProviderSettings.tsx` against "PROVIDER_AUTH_FAILED" and
 *    "PROVIDER_CHANGED"). `agentFailure` in `routes/agent.ts` passes those
 *    through verbatim, so the HTTP surface carries the documented spelling
 *    rather than a second, lower-cased variant. Uppercase reaching a client is
 *    therefore a declared, owned value — not vocabulary drift.
 *
 * `tests/route-error-codes.test.ts` scans every file in this directory and
 * fails on any `code` literal outside the union below, so a new spelling is a
 * red test rather than a silent fourth dialect.
 */

import { agentErrorCodes, type AgentErrorCode } from "@nami/agent-contracts";
import { MAIL_ERROR_CODES, type MailErrorCode } from "../mail.js";
import type { OAuthErrorCode } from "../oauth.js";
import type { TranslationServiceErrorCode } from "../translation.js";

// ---------------------------------------------------------------------------
// Family 1 — route-owned codes
// ---------------------------------------------------------------------------

/**
 * `status` is the status the route answers with when it uses this code; it is
 * documentation of intent, not something the table enforces (a code can be
 * legal on more than one status — `translation_content_unavailable` is 404 for
 * a missing message and 422 for a message with no translatable text).
 */
export const ROUTE_ERROR_CODE_DEFINITIONS = {
  // Request shape. One meaning, one code, every route.
  invalid_argument: { status: 400, meaning: "Body, query, params or a manually checked argument failed validation." },
  not_found: { status: 404, meaning: "The addressed resource does not exist." },
  conflict: { status: 409, meaning: "The request cannot be applied to the resource's current state." },
  payload_too_large: { status: 413, meaning: "The request body exceeds a declared size or count limit." },
  unprocessable: { status: 422, meaning: "The request was well-formed but the local service rejects it on a business rule." },
  internal_error: { status: 500, meaning: "The local service failed without a more specific classification." },

  // Mailbox lifecycle.
  account_exists: { status: 409, meaning: "The mailbox is already added." },
  contact_exists: { status: 409, meaning: "The address is already in the address book." },
  discovery_failed: { status: 422, meaning: "Automatic provider discovery could not complete." },
  cancelled: { status: 499, meaning: "A long-running operation was cancelled or hit its runtime cap." },

  // Outbox.
  idempotency_conflict: { status: 409, meaning: "An idempotency key was reused with a different request." },

  // OAuth.
  oauth_not_configured: { status: 503, meaning: "No OAuth client is configured for this provider." },
  oauth_provider_unsupported: { status: 404, meaning: "The OAuth provider is not supported." },

  // Agent.
  agent_unavailable: { status: 503, meaning: "No Agent service instance is present in this process." },
  agent_internal: { status: 500, meaning: "The Agent service failed outside its own error contract." },
  // A model-backed feature the host offers on its own initiative (compose
  // polish) asked for a call with no configured default model. It is a 409 and
  // not a 404 because nothing is missing at the addressed URL: the user's
  // configuration is in the wrong state for this request, and the renderer
  // branches on this code to explain that instead of reporting a failure.
  no_model_configured: { status: 409, meaning: "A model-backed feature was requested with no configured default model." },
  auto_reply_unavailable: { status: 503, meaning: "No auto-reply engine is present in this process." },
  confirmation_expired: { status: 409, meaning: "The auto-reply confirmation has expired." },
  confirmation_record_failed: { status: 409, meaning: "The auto-reply decision could not be recorded." },

  // Server-sent events.
  events_unavailable: { status: 404, meaning: "This process serves no server event bus." },
  events_overloaded: { status: 503, meaning: "The live event stream connection limit is reached." },

  // Translation.
  translation_configuration_managed: { status: 409, meaning: "The runtime manages translation configuration out of band." },
  translation_configuration_invalid: { status: 400, meaning: "The translation configuration is not usable." },
  translation_configuration_failed: { status: 500, meaning: "The translation configuration could not be written." },
  translation_invalid_target: { status: 400, meaning: "The requested target locale is not supported." },
  translation_request_too_large: { status: 413, meaning: "The text exceeds the single-block translation limit." },
  translation_content_unavailable: { status: 404, meaning: "The selected message is gone or holds no translatable text." },
  translation_failed: { status: 500, meaning: "The translation did not complete." },
} as const;

export type RouteErrorCode = keyof typeof ROUTE_ERROR_CODE_DEFINITIONS;

/**
 * The wire constants, keyed by their own value: routes write
 * `code: ROUTE_ERROR_CODES.invalid_argument`, so a typo in the key is a
 * compile error and the declaration above stays the only place a spelling is
 * chosen.
 */
export const ROUTE_ERROR_CODES: { readonly [K in RouteErrorCode]: K } = Object.freeze(
  Object.fromEntries(
    (Object.keys(ROUTE_ERROR_CODE_DEFINITIONS) as RouteErrorCode[]).map((code) => [code, code]),
  ),
) as { readonly [K in RouteErrorCode]: K };

export const ROUTE_ERROR_CODE_LIST: readonly RouteErrorCode[] = Object.freeze(
  Object.keys(ROUTE_ERROR_CODE_DEFINITIONS) as RouteErrorCode[],
);

// ---------------------------------------------------------------------------
// Families 2–4 — owned elsewhere, referenced here
// ---------------------------------------------------------------------------

/** Mail transport classification. Owned by `../mail.js`; imported, not copied. */
export const REFERENCED_MAIL_ERROR_CODES: readonly MailErrorCode[] = MAIL_ERROR_CODES;

/** UPPER_SNAKE Agent/Broker vocabulary. Owned by `@nami/agent-contracts`. Frozen. */
export const REFERENCED_AGENT_ERROR_CODES: readonly AgentErrorCode[] = agentErrorCodes;

/**
 * Upper-snake codes the Agent layer emits that the contracts enum does not
 * list, and which therefore reach the wire only because `agentFailure` passes
 * `error.code` through verbatim.
 *
 * `PROVIDER_CHANGED` and `SERVER_CHANGED` are optimistic-concurrency refusals
 * on a provider/MCP-server record that changed mid-check; the renderer matches
 * both by literal. `CLOUD_CONTENT_CONSENT_REQUIRED` is the 403 raised when a
 * provider may not receive mail content, and `apps/web/src/translationPresentation.ts`
 * matches it by literal too. The `MCP_CLIENT_CODES` below are the MCP
 * transport's own vocabulary: they reach the client through the `lastError`
 * summary on an `/api/agent/mcp-servers` row rather than as an error-body
 * `code`, but they are the same upper-snake family and the renderer switches on
 * them the same way, so they belong in the same set.
 *
 * `tests/route-error-codes.test.ts` re-derives the Agent layer's thrown codes
 * from `src/agent/**` and `src/agent-service.ts`, so adding one here without
 * adding one there — or the reverse — is a failing test, not a surprise.
 */
export const AGENT_PASSTHROUGH_ONLY_CODES = [
  "PROVIDER_CHANGED",
  "SERVER_CHANGED",
  "CLOUD_CONTENT_CONSENT_REQUIRED",
] as const satisfies readonly string[];

export const MCP_CLIENT_CODES = [
  "CLOSED",
  "CONNECT_TIMEOUT",
  "CONNECTION_FAILED",
  "NOT_CONNECTED",
  "PROTOCOL_ERROR",
  "TIMEOUT",
] as const satisfies readonly string[];

export const OAUTH_ERROR_CODES = [
  "oauth_not_configured",
  "oauth_callback_unavailable",
  "oauth_invalid_state",
  "oauth_expired",
  "oauth_failed",
  "oauth_connection_failed",
  "oauth_identity_invalid",
  "oauth_refresh_failed",
  "account_exists",
  // `OAuthErrorCode` also admits every `MailErrorCode`; those are already
  // carried by REFERENCED_MAIL_ERROR_CODES and are not repeated here.
] as const satisfies readonly OAuthErrorCode[];

export const TRANSLATION_SERVICE_ERROR_CODES = [
  "translation_not_configured",
  // The next three are also route-owned (see ROUTE_ERROR_CODE_DEFINITIONS).
  // One spelling, two homes: the route writes it and the service raises it.
  // Renaming one side would fork the vocabulary this table exists to prevent.
  "translation_invalid_target",
  "translation_content_unavailable",
  "translation_request_too_large",
  "translation_timeout",
  "translation_tls_certificate_failed",
  "translation_tls_handshake_failed",
  "translation_server_not_found",
  "translation_network_unavailable",
  "translation_connection_refused",
  "translation_connection_failed",
  "translation_model_download_failed",
  "translation_model_cache_unavailable",
  "translation_model_unavailable",
  "translation_service_authentication_failed",
  "translation_rate_limited",
  "translation_service_unavailable",
  "translation_service_rejected",
  "translation_invalid_response",
  "translation_response_too_large",
] as const satisfies readonly TranslationServiceErrorCode[];

// Compile-time probes. Each evaluates to `true` only while the local list still
// covers its upstream union, so adding an OAuth or translation code upstream
// without a row here fails `npm run typecheck` instead of shipping.
// `oauth_required` matches the `oauth_*` pattern but belongs to the mail
// family (`oauthRequiredBody` emits it, and it is a `MailErrorCode`), so it is
// excluded here rather than duplicated above.
export type UncoveredOAuthErrorCode = Exclude<
  Extract<OAuthErrorCode, `oauth_${string}`>,
  (typeof OAUTH_ERROR_CODES)[number] | MailErrorCode
>;
export type UncoveredTranslationErrorCode = Exclude<
  TranslationServiceErrorCode,
  (typeof TRANSLATION_SERVICE_ERROR_CODES)[number]
>;
export const OAUTH_CODES_ARE_EXHAUSTIVE: UncoveredOAuthErrorCode extends never ? true : never = true;
export const TRANSLATION_CODES_ARE_EXHAUSTIVE: UncoveredTranslationErrorCode extends never ? true : never = true;

// ---------------------------------------------------------------------------
// The union every route response must draw from
// ---------------------------------------------------------------------------

/**
 * The complete set of `code` values the routing layer may put on the wire.
 * Route-owned values are lower-snake; a value that is also present in the
 * Agent family is upper-snake — the two never collide because the frozen Agent
 * vocabulary keeps its own casing.
 */
export const WIRE_ERROR_CODES: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...ROUTE_ERROR_CODE_LIST,
    ...REFERENCED_MAIL_ERROR_CODES,
    ...OAUTH_ERROR_CODES,
    ...TRANSLATION_SERVICE_ERROR_CODES,
    ...REFERENCED_AGENT_ERROR_CODES,
    ...AGENT_PASSTHROUGH_ONLY_CODES,
    ...MCP_CLIENT_CODES,
  ]),
]);

const WIRE_ERROR_CODE_SET: ReadonlySet<string> = new Set(WIRE_ERROR_CODES);

/** True when `value` is a code this API is allowed to put on the wire. */
export function isWireErrorCode(value: unknown): value is string {
  return typeof value === "string" && WIRE_ERROR_CODE_SET.has(value);
}

/**
 * The canonical code for a status a route picked dynamically (the attachment
 * and mail-failure paths derive their status from the thrown error). Keeps
 * those responses inside the vocabulary without a per-site table.
 */
export function routeErrorCodeForStatus(status: number): RouteErrorCode {
  if (status === 400) return ROUTE_ERROR_CODES.invalid_argument;
  if (status === 404) return ROUTE_ERROR_CODES.not_found;
  if (status === 409) return ROUTE_ERROR_CODES.conflict;
  if (status === 413) return ROUTE_ERROR_CODES.payload_too_large;
  if (status === 422) return ROUTE_ERROR_CODES.unprocessable;
  if (status === 499) return ROUTE_ERROR_CODES.cancelled;
  return ROUTE_ERROR_CODES.internal_error;
}

/**
 * `mailFailureBody` deliberately drops the transport code when the failure is
 * unclassified (`code: "unknown"` becomes a message-only body) so a local
 * validation error is not dressed up as a transport error. Dropping the field
 * entirely is a different problem: a client that branches on `code` can then
 * tell nothing at all. This fills the gap from the status the route already
 * chose — a 404 "mail is gone" becomes `not_found`, a 409 becomes `conflict` —
 * while leaving the mail taxonomy's own decision untouched.
 */
export function withErrorCode<T extends { ok: false; code?: string }>(body: T, status: number): T & { code: string } {
  return (body.code ? body : { ...body, code: routeErrorCodeForStatus(status) }) as T & { code: string };
}
