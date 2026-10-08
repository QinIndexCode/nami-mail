import type { Message } from "../types";

export type DraftBodyResolution =
  | { ok: true; draft: Message }
  | { ok: false; error: unknown };

/**
 * Resolves the message a draft editor should open on.
 *
 * A list row only carries a text preview, and the composer is keyed to the
 * draft id — opening it on the preview would let a save overwrite the full
 * draft with truncated text. When the full body cannot be fetched the
 * resolution fails and the caller must NOT open the editor; opening the draft
 * again retries the fetch.
 */
export async function resolveDraftBody(
  message: Message,
  options: { isDemo: boolean; fetchMessage: (id: string) => Promise<Message> },
): Promise<DraftBodyResolution> {
  if (options.isDemo || message.htmlBody !== undefined) return { ok: true, draft: message };
  try {
    return { ok: true, draft: await options.fetchMessage(message.id) };
  } catch (error) {
    return { ok: false, error };
  }
}
