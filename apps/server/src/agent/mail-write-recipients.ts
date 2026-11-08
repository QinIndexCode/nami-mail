import type { DraftMutation } from "./mail-application-service.js";

/** BCC is separate, including an explicit empty array when removing it from a draft. */
export function mailRecipientFields(input: Pick<DraftMutation, "to" | "cc" | "bcc">) {
  return { to: input.to, ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined ? { bcc: input.bcc } : {}) };
}
