import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ApiError, api } from "../api";
import { ensureDemoLoaded } from "../demo-loader";
import {
  applyMailTranslation,
  extractMailTextSegments,
  isMailMatchingLocale,
} from "../mailDomTranslation";
import { llmTranslationErrorMessage, translationErrorMessage, extractMailVisualStyle } from "../translationPresentation";
import { findVerificationCodes } from "../verificationCode";
import { copyVerificationCodeToClipboard } from "./verificationClipboard";
import {
  MAX_LLM_TRANSLATION_TEXT_LENGTH,
  rewriteRemoteImagesToProxy,
  sanitizeMailHtml,
  textFromSanitizedMailHtml,
} from "./app-utils";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { AgentBootstrap } from "../agentTypes";
import type { Message } from "../types";
import type { TranslationAvailability, TranslationContent, TranslationPanelState } from "../TranslationPanel";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];
type TranslationTermsPending = "free" | "llm" | null;

function retainedTranslationContent(state: TranslationPanelState): TranslationContent | undefined {
  if (state.phase === "ready") {
    return {
      translatedText: state.translatedText,
      ...(state.detectedLanguage ? { detectedLanguage: state.detectedLanguage } : {}),
      visible: state.visible,
    };
  }
  return state.phase === "loading" || state.phase === "error" ? state.previous : undefined;
}

export interface MailTranslationOptions {
  selected: Message | null;
  /** Sanitized HTML of the selected message (verification-code extraction source). */
  safeHtml: string;
  locale: string;
  t: Translate;
  theme: "light" | "dark";
  isDemo: boolean;
  showToast: ShowToast;
  agentProviderSnapshot: Pick<AgentBootstrap, "providers" | "defaultProviderId"> | null;
  translationTermsAccepted: boolean;
  translationTermsPendingRef: RefObject<TranslationTermsPending>;
  setTranslationTermsOpen: (open: boolean) => void;
  setTranslationTermsAccepted: (accepted: boolean) => void;
}

export interface MailTranslation {
  translationState: TranslationPanelState;
  forceShowTranslation: boolean;
  shouldRenderTranslationPanel: boolean;
  llmTranslationAvailable: boolean;
  translationMailStyle: ReturnType<typeof extractMailVisualStyle>;
  verificationCodes: ReturnType<typeof findVerificationCodes>;
  translationAvailability: TranslationAvailability;
  setForceShowTranslationId: (messageId: string | null) => void;
  refreshTranslationAvailability: () => Promise<void>;
  translateSelectedMessage: () => Promise<void>;
  translateSelectedMessageWithLlm: () => Promise<void>;
  showSelectedTranslation: () => void;
  hideSelectedTranslation: () => void;
  cancelTranslation: () => void;
  acceptTranslationTerms: () => void;
  declineTranslationTerms: () => void;
  copyDetectedVerificationCode: (code: string) => Promise<void>;
}

export function useMailTranslation({
  selected,
  safeHtml,
  locale,
  t,
  theme,
  isDemo,
  showToast,
  agentProviderSnapshot,
  translationTermsAccepted,
  translationTermsPendingRef,
  setTranslationTermsOpen,
  setTranslationTermsAccepted,
}: MailTranslationOptions): MailTranslation {
  const [translationSession, setTranslationSession] = useState<{ messageId: string; targetLocale: string; state: TranslationPanelState } | null>(null);
  const [forceShowTranslationId, setForceShowTranslationId] = useState<string | null>(null);
  const [translationAvailability, setTranslationAvailability] = useState<TranslationAvailability>(isDemo ? "available" : "checking");
  const translationRequestIdRef = useRef(0);
  const translationAvailabilityRequestIdRef = useRef(0);
  const translationAbortRef = useRef<AbortController | null>(null);
  const llmTranslationAbortRef = useRef<AbortController | null>(null);

  const translationState = useMemo<TranslationPanelState>(() => selected
    && translationSession?.messageId === selected.id
    && translationSession.targetLocale === locale
    ? translationSession.state
    : { phase: "idle" }, [locale, selected, translationSession]);
  const forceShowTranslation = selected ? forceShowTranslationId === selected.id : false;
  const isMailLanguageMatching = useMemo(() => {
    if (!selected) return true;
    return isMailMatchingLocale(selected, locale);
  }, [selected, locale]);
  const shouldRenderTranslationPanel =
    translationState.phase !== "idle" ||
    forceShowTranslation ||
    !isMailLanguageMatching;
  // Whether at least one LLM provider is configured AND authorized for mail
  // content, enabling AI translation. Cloud providers require the explicit
  // "allowCloudMailContent" consent; local providers (e.g. Ollama) always qualify.
  const llmTranslationAvailable = useMemo(
    () => !isDemo && Boolean(agentProviderSnapshot?.providers.some(
      (provider) => provider.configured && (!provider.cloud || provider.cloudContentConsent),
    )),
    [agentProviderSnapshot, isDemo],
  );
  const refreshTranslationAvailability = useCallback(async () => {
    const requestId = ++translationAvailabilityRequestIdRef.current;
    if (isDemo) {
      setTranslationAvailability("available");
      return;
    }
    setTranslationAvailability("checking");
    try {
      const status = await api.translationStatus();
      if (requestId === translationAvailabilityRequestIdRef.current) {
        setTranslationAvailability(status.configurationError ? "invalid" : status.enabled ? "available" : "unavailable");
      }
    } catch {
      if (requestId === translationAvailabilityRequestIdRef.current) setTranslationAvailability("unknown");
    }
  }, [isDemo]);
  // Inherit the message's branded backdrop so a translated result keeps the
  // provider-authored look instead of falling back to a plain app panel.
  const translationMailStyle = useMemo(
    () => selected?.htmlBody ? extractMailVisualStyle(selected.htmlBody) : undefined,
    [selected?.htmlBody],
  );
  const verificationCodes = useMemo(() => {
    if (!selected) return [];
    const htmlText = textFromSanitizedMailHtml(safeHtml);
    return findVerificationCodes({
      subject: selected.subject,
      body: [selected.textBody, selected.snippet, htmlText].filter(Boolean).join("\n"),
    });
  }, [safeHtml, selected]);
  useEffect(() => {
    // Translation is view-local and target-language specific. Never retain a
    // result when the user changes the selected mail or interface language.
    translationRequestIdRef.current += 1;
    setTranslationSession(null);
  }, [locale, selected?.id]);
  useEffect(() => {
    void refreshTranslationAvailability();
    return () => {
      translationAvailabilityRequestIdRef.current += 1;
    };
  }, [refreshTranslationAvailability]);

  const translateSelectedMessage = useCallback(async () => {
    if (!selected || translationState.phase === "loading") return;
    if (!translationTermsAccepted) {
      translationTermsPendingRef.current = "free";
      setTranslationTermsOpen(true);
      return;
    }
    const messageId = selected.id;
    const targetLocale = locale;
    const previous = retainedTranslationContent(translationState);
    const requestId = ++translationRequestIdRef.current;
    translationAbortRef.current?.abort();
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslationSession({ messageId, targetLocale, state: { phase: "loading", ...(previous ? { previous } : {}) } });
    try {
      // HTML-bodied messages keep their markup, links, and inline styles by
      // translating the visible text nodes in place (Immersive-Translate style)
      // instead of replacing the whole body with a plain-text translation.
      if (!isDemo && selected.htmlBody) {
        // Same proxy rewrite as the reader body (App.tsx): translatedHtml
        // REPLACES that body in the reader, so skipping it here would reopen the
        // leak for every translated message.
        const sanitized = rewriteRemoteImagesToProxy(sanitizeMailHtml(selected.htmlBody, theme === "dark"));
        const template = document.createElement("template");
        template.innerHTML = sanitized;
        const segments = extractMailTextSegments(template.content);
        if (segments.length > 0) {
          const { translations } = await api.translateMessageSegments(
            segments.map((segment) => segment.text),
            targetLocale,
            controller.signal,
          );
          for (let index = 0; index < segments.length; index++) {
            applyMailTranslation(template.content, segments[index]!.path, translations[index]!);
          }
          if (requestId !== translationRequestIdRef.current) return;
          setTranslationSession({
            messageId,
            targetLocale,
            state: {
              phase: "ready",
              // The panel preview stays plain text; the styled version lives in
              // translatedHtml and replaces the body in the reader.
              translatedText: translations.join("\n"),
              translatedHtml: template.innerHTML,
              visible: true,
            },
          });
          return;
        }
      }
      if (isDemo) {
        const demo = await ensureDemoLoaded();
        const result = demo.demoMessageTranslation(selected, targetLocale);
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({
          messageId,
          targetLocale,
          state: {
            phase: "ready",
            translatedText: result.translatedText,
            ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
            visible: true,
          },
        });
      } else {
        const result = await api.translateMessageStream(
          messageId,
          targetLocale,
          (partial) => {
            if (requestId !== translationRequestIdRef.current) return;
            setTranslationSession({
              messageId,
              targetLocale,
              state: { phase: "ready", translatedText: partial, visible: true, streaming: true },
            });
          },
          controller.signal,
        );
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({
          messageId,
          targetLocale,
          state: {
            phase: "ready",
            translatedText: result.translatedText,
            ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
            visible: true,
          },
        });
      }
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      // User cancelled the streaming translation — keep any partial result
      // already shown instead of surfacing an error.
      if (controller.signal.aborted) {
        setTranslationSession((current) => {
          if (!current || current.messageId !== messageId || current.targetLocale !== targetLocale) return current;
          if (current.state.phase === "ready" && current.state.streaming) {
            return { ...current, state: { ...current.state, streaming: false } };
          }
          return previous
            ? { messageId, targetLocale, state: { phase: "ready", ...previous, visible: true } }
            : null;
        });
        return;
      }
      const llmAvailable = error instanceof ApiError && error.llmAvailable;
      setTranslationSession({
        messageId,
        targetLocale,
        state: { phase: "error", message: translationErrorMessage(error, t), ...(previous ? { previous } : {}), ...(llmAvailable ? { llmAvailable } : {}) },
      });
    }
  }, [isDemo, locale, selected, setTranslationTermsOpen, t, theme, translationState, translationTermsAccepted, translationTermsPendingRef]);
  const translateSelectedMessageWithLlm = useCallback(async () => {
    if (!selected || translationState.phase === "loading") return;
    if (!translationTermsAccepted) {
      translationTermsPendingRef.current = "llm";
      setTranslationTermsOpen(true);
      return;
    }
    const messageId = selected.id;
    const targetLocale = locale;
    const previous = retainedTranslationContent(translationState);
    // Mirror the server-side size guard so oversized messages fail fast
    // without ever sending their body to an LLM provider.
    const bodyText = selected.textBody?.trim() ?? "";
    const translatableLength = bodyText
      ? bodyText.length
      : selected.htmlBody?.trim()
        ? selected.htmlBody.trim().replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").length
        : 0;
    if (translatableLength > MAX_LLM_TRANSLATION_TEXT_LENGTH) {
      setTranslationSession({ messageId, targetLocale, state: { phase: "error", message: t("translation.error.requestTooLarge"), ...(previous ? { previous } : {}) } });
      return;
    }
    const requestId = ++translationRequestIdRef.current;
    llmTranslationAbortRef.current?.abort();
    const controller = new AbortController();
    llmTranslationAbortRef.current = controller;
    setTranslationSession({ messageId, targetLocale, state: { phase: "loading", ...(previous ? { previous } : {}) } });
    try {
      const providers = isDemo ? { items: [], defaultProviderId: null } : await api.agentProviders();
      const configured = providers.items.filter((p) => p.configured);
      const provider = configured.find((p) => p.id === providers.defaultProviderId) ?? configured[0];
      if (!provider) {
        if (requestId !== translationRequestIdRef.current) return;
        setTranslationSession({ messageId, targetLocale, state: { phase: "error", message: t("translation.llmNoProvider"), ...(previous ? { previous } : {}) } });
        return;
      }
      const result = await api.translateMessageWithLlmStream(
        messageId,
        targetLocale,
        provider.id,
        undefined,
        (partial) => {
          if (requestId !== translationRequestIdRef.current) return;
          setTranslationSession({
            messageId,
            targetLocale,
            state: { phase: "ready", translatedText: partial, visible: true, streaming: true },
          });
        },
        controller.signal,
      );
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationSession({
        messageId, targetLocale,
        state: { phase: "ready", translatedText: result.translatedText, visible: true },
      });
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      // User cancelled the LLM translation — restore any previous result
      // instead of surfacing an error.
      if (controller.signal.aborted) {
        setTranslationSession((current) => {
          if (!current || current.messageId !== messageId || current.targetLocale !== targetLocale) return current;
          if (current.state.phase === "ready" && current.state.streaming) {
            return { ...current, state: { ...current.state, streaming: false } };
          }
          return previous
            ? { messageId, targetLocale, state: { phase: "ready", ...previous, visible: true } }
            : null;
        });
        return;
      }
      setTranslationSession({
        messageId, targetLocale,
        state: { phase: "error", message: llmTranslationErrorMessage(error, t), ...(previous ? { previous } : {}) },
      });
    } finally {
      if (llmTranslationAbortRef.current === controller) llmTranslationAbortRef.current = null;
    }
  }, [isDemo, locale, selected, setTranslationTermsOpen, t, translationState, translationTermsAccepted, translationTermsPendingRef]);
  const showSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: true } };
    });
  }, [locale, selected]);
  const hideSelectedTranslation = useCallback(() => {
    setTranslationSession((current) => {
      if (!selected || !current || current.messageId !== selected.id || current.targetLocale !== locale || current.state.phase !== "ready") {
        return current;
      }
      return { ...current, state: { ...current.state, visible: false } };
    });
  }, [locale, selected]);
  const cancelTranslation = useCallback(() => {
    translationAbortRef.current?.abort();
    translationAbortRef.current = null;
    llmTranslationAbortRef.current?.abort();
    llmTranslationAbortRef.current = null;
  }, []);
  const acceptTranslationTerms = useCallback(() => {
    try { localStorage.setItem("nami-mail:translation-terms-accepted", "1"); } catch { /* localStorage may be unavailable */ }
    // Also set a cookie so the acceptance survives port changes across restarts
    // (Chromium shares cookies across ports on the same domain).
    try { document.cookie = "nami-mail-translation-terms=1; max-age=31536000; path=/; SameSite=Lax"; } catch { /* cookie may be unavailable */ }
    setTranslationTermsAccepted(true);
    setTranslationTermsOpen(false);
    const pending = translationTermsPendingRef.current;
    translationTermsPendingRef.current = null;
    if (pending === "free") void translateSelectedMessage();
    else if (pending === "llm") void translateSelectedMessageWithLlm();
  }, [setTranslationTermsAccepted, setTranslationTermsOpen, translateSelectedMessage, translateSelectedMessageWithLlm, translationTermsPendingRef]);
  const declineTranslationTerms = useCallback(() => {
    setTranslationTermsOpen(false);
    const pending = translationTermsPendingRef.current;
    translationTermsPendingRef.current = null;
    if (!pending) {
      if (window.namiDesktop?.quit) window.namiDesktop.quit();
      else window.close();
    }
  }, [setTranslationTermsOpen, translationTermsPendingRef]);
  const copyDetectedVerificationCode = useCallback(async (code: string) => {
    const copied = await copyVerificationCodeToClipboard(code);
    showToast(copied ? t("mail.verification.copied", { code }) : t("mail.verification.copyFailed"), copied ? "success" : "error");
  }, [showToast, t]);

  return {
    translationState,
    forceShowTranslation,
    shouldRenderTranslationPanel,
    llmTranslationAvailable,
    translationMailStyle,
    verificationCodes,
    translationAvailability,
    setForceShowTranslationId,
    refreshTranslationAvailability,
    translateSelectedMessage,
    translateSelectedMessageWithLlm,
    showSelectedTranslation,
    hideSelectedTranslation,
    cancelTranslation,
    acceptTranslationTerms,
    declineTranslationTerms,
    copyDetectedVerificationCode,
  };
}
