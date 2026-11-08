import type { OutboundSubmission } from "@nami/agent-contracts";

/** Only structured recipient evidence is retained; raw server replies may contain secrets. */
export function smtpRecipientDelivery(value: unknown): OutboundSubmission["recipientDelivery"] {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { accepted?: unknown; rejected?: unknown; rejectedErrors?: unknown };
  if (!Array.isArray(result.accepted) && !Array.isArray(result.rejected)) return undefined;
  const accepted = Array.isArray(result.accepted) ? result.accepted.filter((item): item is string => typeof item === "string") : [];
  const errors = Array.isArray(result.rejectedErrors) ? result.rejectedErrors as Array<{ recipient?: string; responseCode?: number }> : [];
  const rejected = (Array.isArray(result.rejected) ? result.rejected : [])
    .filter((item): item is string => typeof item === "string")
    .map((address) => {
      const responseCode = errors.find((error) => error?.recipient === address)?.responseCode;
      return { address, ...(Number.isInteger(responseCode) ? { responseCode } : {}) };
    });
  return { accepted, rejected };
}
