import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, PenLine, Undo2 } from "lucide-react";
import { api } from "./api";
import { ApiError, apiError, boundedRequest, requestResponse } from "./apiTransport";
import { mailErrorMessage } from "./errorPresentation";
import type { Translate } from "./i18n";
import type { ToastKind } from "./mailUi";

/**
 * Mirrors `MAX_POLISH_TEXT_LENGTH` in the local server so the compose window
 * refuses an over-long body before asking the model to read it, and answers the
 * same way the endpoint does. `apps/server/tests/agent-polish.test.ts` pins the
 * server-side pair together; this is the renderer's half of that contract.
 */
export const MAX_POLISH_TEXT_LENGTH = 50_000;

/**
 * Model latency, not local-service latency: this call crosses a provider. The
 * budget is the same 30 s the JSON path in api.ts uses, so a wedged local
 * service and a wedged provider fail the same way instead of hanging the
 * compose window forever.
 */
const POLISH_TIMEOUT_MS = 30_000;

/** Why the polish affordance is unavailable, in the order the user meets them. */
export type PolishBlockReason = "no-model" | "too-large" | "empty" | null;

/**
 * `POST /api/agent/polish`. This lives beside the hook rather than in api.ts
 * because that file is frozen at its exact line count by the ESLint ratchet,
 * and a feature endpoint that only this dialog uses does not belong in the
 * shared table anyway. It goes through the same transport primitives, so the
 * call is bounded and fails with the same `ApiError` shape as every other
 * endpoint.
 */
async function polishDraft(text: string, locale?: string): Promise<string> {
  const bounded = boundedRequest(POLISH_TIMEOUT_MS);
  try {
    const response = await requestResponse("/api/agent/polish", {
      method: "POST",
      body: JSON.stringify({ text, ...(locale ? { locale } : {}) }),
      signal: bounded.signal,
    });
    if (!response.ok) throw await apiError(response);
    const body = (await response.json().catch(() => ({}))) as { text?: unknown };
    const polished = typeof body.text === "string" ? body.text.trim() : "";
    if (!polished) throw new ApiError("The polished text could not be read.", "polish_invalid_response");
    return polished;
  } finally {
    bounded.dispose();
  }
}

/**
 * Whether the refusal is "you have not configured a model" rather than a real
 * failure. The endpoint owns that distinction (`no_model_configured`, 409) and
 * the compose window depends on it: the same answer becomes an affordance
 * ("configure a model") instead of an error toast, and the button's own
 * blocked state corrects itself so the next hover is right.
 */
function isNoModelConfigured(reason: unknown): boolean {
  return reason instanceof ApiError && reason.code === "no_model_configured";
}

export type ComposePolish = {
  /** True while the provider call is in flight; the textarea locks and shimmers. */
  polishing: boolean;
  /** Non-null when the affordance is unavailable, and why. */
  blocked: PolishBlockReason;
  /** True while a polished body can still be reverted to what it replaced. */
  undoAvailable: boolean;
  run: () => void;
  undo: () => void;
};

/**
 * The three states the compose window needs, in one hook.
 *
 * - **Model availability** is read once per compose window from
 *   `/api/agent/providers`. `defaultProviderId` is already null there unless
 *   the default model is fully configured, which is exactly the question the
 *   endpoint asks, so the button's hover state and the endpoint's 409 agree by
 *   construction rather than by two copies of the same rule. `null` means
 *   "not known yet" and is deliberately *not* treated as "missing": a
 *   transport failure must not tell the user their configuration is wrong.
 * - **Polishing** locks the textarea, because letting it be edited under an
 *   in-flight call would replace text the user typed after the request was
 *   built. The in-flight look is a `.compose-body.is-polishing` rule that
 *   reuses the app's existing `search-pulse` keyframe — a focus-coloured ring
 *   that breathes outward and touches nothing else, so the body stays fully
 *   legible while it waits. It needs no reduced-motion rule of its own: the
 *   blanket clamp in styles.css already collapses every animation to one
 *   0.01 ms iteration under `prefers-reduced-motion`, and this animation's end
 *   state is a transparent ring, i.e. exactly what the element looks like with
 *   no animation at all.
 * - **Undo** keeps the exact pre-polish body in component state. The toast
 *   undo affordance is not reusable here: it restores a whole compose draft by
 *   reopening the window, which would discard attachments and the rest of the
 *   message. An inline button that touches one field is the honest shape.
 */
export function useComposePolish(input: {
  text: string;
  applyText: (next: string) => void;
  notify: (message: string, kind?: ToastKind) => void;
  t: Translate;
}): ComposePolish {
  const { text, applyText, notify, t } = input;
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [undoText, setUndoText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.agentProviders()
      .then((list) => { if (!cancelled) setModelConfigured(Boolean(list.defaultProviderId)); })
      .catch(() => { if (!cancelled) setModelConfigured(null); });
    return () => { cancelled = true; };
  }, []);

  const tooLarge = text.length > MAX_POLISH_TEXT_LENGTH;
  const blocked: PolishBlockReason = modelConfigured === false
    ? "no-model"
    : tooLarge
      ? "too-large"
      : text.trim()
        ? null
        : "empty";

  const run = useCallback(() => {
    if (polishing || blocked) return;
    const previous = text;
    setPolishing(true);
    setUndoText(null);
    void polishDraft(text, document.documentElement.lang || undefined)
      .then((polished) => {
        applyText(polished);
        setUndoText(previous);
        notify(t("compose.polish.done"), "success");
      })
      .catch((reason) => {
        // The textarea was locked for the whole call, so this is a no-op today;
        // it states the invariant instead of relying on the lock.
        applyText(previous);
        setUndoText(null);
        if (isNoModelConfigured(reason)) {
          setModelConfigured(false);
          notify(t("compose.polish.needsModel"), "error");
          return;
        }
        notify(mailErrorMessage(reason, t("compose.polish.failed"), t), "error");
      })
      .finally(() => setPolishing(false));
  }, [applyText, blocked, notify, polishing, t, text]);

  const undo = useCallback(() => {
    if (undoText === null) return;
    applyText(undoText);
    setUndoText(null);
    notify(t("compose.polish.undone"), "info");
  }, [applyText, notify, t, undoText]);

  return { polishing, blocked, undoAvailable: undoText !== null, run, undo };
}

/**
 * The compose toolbar's polish affordance and its inline undo.
 *
 * A blocked button is marked `aria-disabled` rather than `disabled`, and that
 * is deliberate: Chromium and Firefox do not dispatch pointer events on a
 * natively disabled control, so the hover bubble that explains *why* the
 * button is unavailable would never appear. `aria-disabled` keeps the button
 * hoverable and announced while the guarded `onClick` refuses the action —
 * the standard pattern for "disabled, but here is how to fix it".
 */
export function ComposePolishControls({ polish, t }: { polish: ComposePolish; t: Translate }) {
  const { polishing, blocked, undoAvailable, run, undo } = polish;
  const hint = blocked === "no-model"
    ? t("compose.polish.needsModel")
    : blocked === "too-large"
      ? t("compose.polish.tooLarge")
      : blocked === "empty"
        ? t("compose.polish.empty")
        : undefined;
  return (
    <>
      <button
        type="button"
        className="secondary-button compose-polish-button"
        aria-label={t("compose.polish.action")}
        data-tooltip={polishing ? t("compose.polish.running") : hint}
        aria-disabled={blocked !== null || polishing}
        disabled={polishing}
        onClick={run}
      >
        {polishing ? <LoaderCircle className="spin" size={15} /> : <PenLine size={15} />}
        {polishing ? t("compose.polish.running") : t("compose.polish.action")}
      </button>
      {undoAvailable && (
        <button type="button" className="secondary-button compose-polish-button" aria-label={t("compose.polish.undo")} onClick={undo}>
          <Undo2 size={15} />
          {t("compose.polish.undo")}
        </button>
      )}
    </>
  );
}
