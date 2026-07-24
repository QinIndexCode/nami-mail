import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type FormEvent, type RefObject } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Mail,
  Plus,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { api } from "./api";
import { desktopBridge } from "./desktop";
import { mailErrorMessage, presentMailError } from "./errorPresentation";
import { type Translate, useI18n } from "./i18n";
import {
  CUSTOM_IMAP_PROVIDER_ID,
  localizedProviderOnboarding,
  orderedProviderCatalog,
  providerAuthLabel,
  providerDisplayName,
  providerMonogram,
  providerServerConfiguration,
  quickProviderCatalog,
  serverEndpointLabel,
} from "./providerOnboarding";
import ThemedSelect from "./ThemedSelect";
import type {
  AccountDiscoveryResult,
  ManualAccountConfig,
  MailServerPreset,
  MailTransport,
  OAuthProvider,
  ProviderDiscovery,
  ProviderInfo,
} from "./types";
import { useDialogFocus } from "./useDialogFocus";

type StatusKind = "success" | "warning" | "error" | "idle";
type StatusField = "email" | "password" | "manual";
type FormStatus = { kind: StatusKind; message: string; field?: StatusField };
type BusyAction = "idle" | "discover" | "password" | "manual" | "oauth";

type AddAccountModalProps = {
  providers: ProviderInfo[];
  onClose: () => void;
  onAdded: () => Promise<void>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  demoMode?: boolean;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISCOVERY_DEBOUNCE_MS = 600;

function validEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

function emailDomain(value: string): string {
  return value.trim().toLowerCase().split("@")[1] ?? "";
}

function providerAuthMethods(provider?: ProviderInfo): string[] {
  if (provider?.authMethods?.length) return provider.authMethods;
  if (provider?.id === "gmail") return ["oauth2", "app-password"];
  if (provider?.id === "microsoft") return ["oauth2"];
  return ["app-password"];
}

function oauthProviderFor(provider: Pick<ProviderDiscovery, "id" | "family">): OAuthProvider | undefined {
  if (provider.id === "gmail" || provider.family === "google") return "google";
  if (provider.id === "microsoft" || provider.family === "microsoft") return "microsoft";
  return undefined;
}

function providerFallback(provider: ProviderInfo | undefined, domain: string, t: Translate): ProviderDiscovery | undefined {
  if (!domain) return undefined;
  const authMethods = providerAuthMethods(provider);
  return {
    id: provider?.id ?? "custom",
    name: provider?.name ?? t("account.provider.custom_name"),
    family: provider?.family ?? "custom",
    priority: provider?.priority,
    domain,
    isCustom: !provider,
    source: provider ? "preset" : "conventional",
    confidence: provider ? "high" : "low",
    authMethods,
    recommendedAuthMethod: provider?.recommendedAuthMethod ?? authMethods[0],
    credentialLabel: provider?.credentialLabel ?? provider?.credentialName ?? t("account.provider.default_credential"),
    credentialName: provider?.credentialName ?? t("account.provider.default_credential"),
    credentialHint: provider?.credentialHint ?? t("account.provider.default_credential_hint"),
    helpText: provider?.helpText,
    caveat: provider?.caveat,
    setupSteps: provider?.setupSteps ?? [
      t("account.provider.default_setup_step_imap"),
      t("account.provider.default_setup_step_credential"),
      t("account.provider.default_setup_step_no_otp"),
    ],
    helpUrl: provider?.helpUrl,
    helpLabel: provider?.helpLabel,
    usernameMode: provider?.usernameMode ?? "email",
    imapUsernameMode: provider?.imapUsernameMode ?? provider?.usernameMode ?? "email",
    smtpUsernameMode: provider?.smtpUsernameMode ?? provider?.usernameMode ?? "email",
    basicAuthLimited: Boolean(provider?.basicAuthLimited),
    capabilities: { imap: true, smtp: true, pop: false, apis: [] },
    imap: provider?.imap ?? { host: `imap.${domain}`, port: 993, transport: "tls" },
    smtp: provider?.smtp ?? { host: `smtp.${domain}`, port: 587, transport: "starttls" },
  };
}

function defaultServer(host: string, port: number, transport: MailTransport, username: string) {
  return { host, port, transport, username };
}

function usernameForProtocol(
  email: string,
  provider: ProviderDiscovery | undefined,
  protocol: "imap" | "smtp",
): string {
  const usernameMode = protocol === "imap"
    ? provider?.imapUsernameMode
    : provider?.smtpUsernameMode;
  return (usernameMode ?? provider?.usernameMode ?? "email") === "local"
    ? email.slice(0, email.lastIndexOf("@"))
    : email;
}

function manualConfigFor(email: string, provider?: ProviderDiscovery): ManualAccountConfig {
  const domain = emailDomain(email);
  const normalizedEmail = email.trim();
  const imapUsername = usernameForProtocol(normalizedEmail, provider, "imap");
  const smtpUsername = usernameForProtocol(normalizedEmail, provider, "smtp");
  const imap = provider?.imap;
  const smtp = provider?.smtp;
  return {
    imap: defaultServer(imap?.host ?? (domain ? `imap.${domain}` : ""), imap?.port ?? 993, imap?.transport ?? "tls", imapUsername),
    smtp: defaultServer(smtp?.host ?? (domain ? `smtp.${domain}` : ""), smtp?.port ?? 587, smtp?.transport ?? "starttls", smtpUsername),
  };
}

function friendlyError(error: unknown, t: Translate): string {
  return mailErrorMessage(error, undefined, t);
}

function serverModeLabel(transport: MailTransport): string {
  return transport === "tls" ? "TLS/SSL" : "STARTTLS";
}

function isServerConfigValid(config: ManualAccountConfig): boolean {
  const servers = [config.imap, config.smtp];
  return servers.every((server) => (
    Boolean(server.host.trim())
    && Number.isInteger(server.port)
    && server.port >= 1
    && server.port <= 65_535
    && (server.transport === "tls" || server.transport === "starttls")
  ));
}

function manualReviewRecommended(provider: ProviderDiscovery): boolean {
  return provider.isCustom || provider.source !== "preset" || provider.confidence !== "high";
}

function resultForDemo(email: string, fallback: ProviderDiscovery | undefined, t: Translate): AccountDiscoveryResult {
  const provider = fallback ?? providerFallback(undefined, emailDomain(email), t);
  if (!provider) throw new Error(t("account.error.email_required"));
  const oauthProvider = oauthProviderFor(provider);
  return { ok: true, provider, ...(oauthProvider ? { oauthProvider, oauthAvailable: true } : { oauthAvailable: false }) };
}

async function copySetupTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The short-lived selection fallback keeps the web build usable when
    // clipboard permissions are unavailable for a local session.
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

export default function AddAccountModal({ providers, onClose, onAdded, fallbackFocusRef, demoMode = false }: AddAccountModalProps) {
  const { locale, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>("idle");
  const [showGuide, setShowGuide] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerCatalogOpen, setProviderCatalogOpen] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualConfig, setManualConfig] = useState<ManualAccountConfig>(() => manualConfigFor(""));
  const [discovery, setDiscovery] = useState<AccountDiscoveryResult | null>(null);
  const [discoveryEmail, setDiscoveryEmail] = useState("");
  const [oauthAttemptId, setOauthAttemptId] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<FormStatus>({ kind: "idle", message: "" });
  const [accountAdded, setAccountAdded] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [serverConfigurationCopied, setServerConfigurationCopied] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const autoCloseTimerRef = useRef<number | null>(null);
  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);
  const activeOAuthAttemptRef = useRef<string | null>(null);
  const serverConfigurationCopyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const emailValueRef = useRef("");
  const emailComposingRef = useRef(false);
  const discoveryRequestIdRef = useRef(0);

  const normalizedEmail = email.trim().toLowerCase();
  const domain = emailDomain(normalizedEmail);
  const matchedProvider = useMemo(
    () => validEmail(normalizedEmail)
      ? providers.find((item) => item.domains.some((candidate) => candidate.toLowerCase() === domain))
      : undefined,
    [domain, normalizedEmail, providers],
  );
  const fallbackProvider = useMemo(
    () => validEmail(normalizedEmail) ? providerFallback(matchedProvider, domain, t) : undefined,
    [domain, matchedProvider, normalizedEmail, t],
  );
  const activeDiscovery = discoveryEmail === normalizedEmail ? discovery?.provider ?? fallbackProvider : fallbackProvider;
  const activeOnboarding = useMemo(
    () => activeDiscovery ? localizedProviderOnboarding(activeDiscovery, locale, t) : undefined,
    [activeDiscovery, locale, t],
  );
  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  const selectedProviderGuide = useMemo(() => {
    if (selectedProvider) return providerFallback(selectedProvider, selectedProvider.domains[0] ?? "", t);
    return selectedProviderId === CUSTOM_IMAP_PROVIDER_ID
      ? providerFallback(undefined, "your-domain.example", t)
      : undefined;
  }, [selectedProvider, selectedProviderId, t]);
  const guideProvider = activeDiscovery ?? selectedProviderGuide;
  const guideOnboarding = useMemo(
    () => guideProvider ? localizedProviderOnboarding(guideProvider, locale, t) : undefined,
    [guideProvider, locale, t],
  );
  const activeProviderName = activeOnboarding?.name ?? activeDiscovery?.name ?? "";
  const guideProviderName = guideOnboarding?.name ?? guideProvider?.name ?? "";
  const orderedProviders = useMemo(() => orderedProviderCatalog(providers, locale), [locale, providers]);
  const quickProviders = useMemo(() => quickProviderCatalog(providers, locale), [locale, providers]);
  const activeOAuthProvider = discoveryEmail === normalizedEmail && discovery
    ? discovery.oauthProvider
    : activeDiscovery ? oauthProviderFor(activeDiscovery) : undefined;
  const oauthAvailable = discoveryEmail === normalizedEmail && discovery
    ? discovery.oauthAvailable
    : matchedProvider?.oauthAvailable ?? true;
  const discoveryRequired = validEmail(normalizedEmail) && !matchedProvider && discoveryEmail !== normalizedEmail;
  const needsProviderDiscovery = discoveryRequired;
  const authMethods = activeDiscovery?.authMethods ?? providerAuthMethods(matchedProvider);
  const oauthOnly = Boolean(activeOAuthProvider) && authMethods.length > 0 && authMethods.every((method) => method === "oauth2");
  const canUsePassword = !oauthOnly;
  const busy = busyAction !== "idle";
  const blockingBusy = busyAction === "password" || busyAction === "manual" || busyAction === "oauth";
  const isOAuthWaiting = busyAction === "oauth" && Boolean(oauthAttemptId);
  const usingPassword = validEmail(normalizedEmail)
    && !needsProviderDiscovery
    && canUsePassword
    && (manualOpen || !activeOAuthProvider || showPasswordFallback);

  const clearOAuthPolling = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearTimeout(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearOAuthPolling();
      activeOAuthAttemptRef.current = null;
      oauthPopupRef.current?.close();
      if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
      if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    };
  }, [clearOAuthPolling]);

  useEffect(() => {
    if (status.kind !== "error") return;
    const target = status.field === "email" ? emailRef.current
      : status.field === "password" ? passwordRef.current
        : status.field === "manual" ? manualRef.current
          : statusRef.current;
    const frame = window.requestAnimationFrame(() => target?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [status]);

  useEffect(() => {
    const keepOpenWhileWorking = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !blockingBusy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", keepOpenWhileWorking, true);
    return () => window.removeEventListener("keydown", keepOpenWhileWorking, true);
  }, [blockingBusy]);

  useDialogFocus(true, dialogRef, { fallbackFocusRef });

  const requestClose = () => {
    if (!blockingBusy) onClose();
  };

  const scheduleClose = useCallback(() => {
    if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = window.setTimeout(() => {
      autoCloseTimerRef.current = null;
      onClose();
    }, demoMode ? 650 : 1_000);
  }, [demoMode, onClose]);

  const showError = useCallback((message: string, field?: StatusField) => {
    setStatus({ kind: "error", message, ...(field ? { field } : {}) });
  }, []);

  const updateEmailValue = useCallback((next: string) => {
    if (next === emailValueRef.current) return;

    emailValueRef.current = next;
    // Make any in-flight discovery result stale before its response can update the form.
    discoveryRequestIdRef.current += 1;
    setEmail(next);
    setDiscovery(null);
    setDiscoveryEmail("");
    setManualOpen(false);
    setShowPasswordFallback(false);
    setShowGuide(false);
    setManualConfig(manualConfigFor(next));
    setPassword("");
    setOauthAttemptId(null);
    setOauthUrl(null);
    activeOAuthAttemptRef.current = null;
    if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    serverConfigurationCopyTimerRef.current = null;
    setServerConfigurationCopied(false);
    setSelectedProviderId((current) => {
      if (!current || !validEmail(next)) return current;
      const providerForEmail = providers.find((item) => item.domains.some((candidate) => candidate.toLowerCase() === emailDomain(next)));
      return providerForEmail?.id === current ? current : "";
    });
    clearOAuthPolling();
    setBusyAction((current) => current === "discover" ? "idle" : current);
    setStatus((current) => current.kind === "idle" ? current : { kind: "idle", message: "" });
  }, [clearOAuthPolling, providers]);

  const selectProvider = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setProviderCatalogOpen(false);
    setShowGuide(Boolean(providerId));
    setManualOpen(false);
    setShowPasswordFallback(false);
    if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    serverConfigurationCopyTimerRef.current = null;
    setServerConfigurationCopied(false);
    setStatus({ kind: "idle", message: "" });
    window.requestAnimationFrame(() => emailRef.current?.focus());
  }, []);

  const discoverProvider = useCallback(async (): Promise<AccountDiscoveryResult | null> => {
    const candidate = emailValueRef.current.trim().toLowerCase();
    if (emailComposingRef.current || !validEmail(candidate)) return null;
    if (candidate === discoveryEmail && discovery) return discovery;

    const requestId = ++discoveryRequestIdRef.current;
    setBusyAction("discover");
    setStatus({ kind: "idle", message: "" });
    try {
      const localProvider = providers.find((item) => item.domains.some((knownDomain) => knownDomain.toLowerCase() === emailDomain(candidate)));
      const fallback = providerFallback(localProvider, emailDomain(candidate), t);
      const result = demoMode ? resultForDemo(candidate, fallback, t) : await api.discoverAccount(candidate);
      if (!mountedRef.current || requestId !== discoveryRequestIdRef.current || candidate !== emailValueRef.current.trim().toLowerCase()) return null;
      setDiscovery(result);
      setDiscoveryEmail(candidate);
      if (manualReviewRecommended(result.provider)) {
        setStatus({ kind: "warning", message: t("account.status.discovery_manual_review") });
      }
      return result;
    } catch (error) {
      if (mountedRef.current && requestId === discoveryRequestIdRef.current && candidate === emailValueRef.current.trim().toLowerCase()) {
        setDiscovery(null);
        setDiscoveryEmail(candidate);
        setStatus({ kind: "warning", message: t("account.status.discovery_unavailable") });
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === discoveryRequestIdRef.current) {
        setBusyAction((current) => current === "discover" ? "idle" : current);
      }
    }
  }, [demoMode, discovery, discoveryEmail, providers, t]);

  useEffect(() => {
    if (!discoveryRequired || emailFocused || busy || accountAdded) return;
    const timer = window.setTimeout(() => {
      void discoverProvider();
    }, DISCOVERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [accountAdded, busy, discoverProvider, discoveryRequired, emailFocused]);

  const updateEmail = (event: ChangeEvent<HTMLInputElement>) => {
    if (emailComposingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    updateEmailValue(event.target.value);
  };

  const beginEmailComposition = () => {
    emailComposingRef.current = true;
  };

  const endEmailComposition = (event: CompositionEvent<HTMLInputElement>) => {
    emailComposingRef.current = false;
    updateEmailValue(event.currentTarget.value);
    if (document.activeElement !== emailRef.current) setEmailFocused(false);
  };

  const updateManualServer = (server: "imap" | "smtp", field: "host" | "port" | "transport" | "username", value: string | number) => {
    setManualConfig((current) => ({
      ...current,
      [server]: {
        ...current[server],
        [field]: field === "port" ? Number(value) : value,
      },
    }));
    if (status.field === "manual") setStatus({ kind: "idle", message: "" });
  };

  const openManualConfig = () => {
    if (!activeDiscovery) return;
    setManualConfig(manualConfigFor(normalizedEmail, activeDiscovery));
    setManualOpen((current) => !current);
    setShowPasswordFallback(true);
    setStatus({ kind: "idle", message: "" });
  };

  const finishAddedAccount = useCallback(async (message: string) => {
    setAccountAdded(true);
    setPassword("");
    oauthPopupRef.current?.close();
    oauthPopupRef.current = null;
    try {
      await onAdded();
      if (!mountedRef.current) return;
      setStatus({ kind: "success", message });
      scheduleClose();
    } catch {
      if (mountedRef.current) setStatus({ kind: "warning", message: t("account.status.refresh_unavailable") });
    }
  }, [onAdded, scheduleClose, t]);

  const cancelOAuth = () => {
    clearOAuthPolling();
    activeOAuthAttemptRef.current = null;
    oauthPopupRef.current?.close();
    oauthPopupRef.current = null;
    setOauthAttemptId(null);
    setOauthUrl(null);
    setBusyAction("idle");
    setStatus({ kind: "warning", message: t("account.status.oauth_canceled") });
  };

  const pollOAuthAttempt = useCallback((attemptId: string) => {
    const poll = async () => {
      try {
        const result = await api.oauthAttempt(attemptId);
        if (!mountedRef.current || activeOAuthAttemptRef.current !== attemptId) return;
        if (result.status === "pending") {
          oauthPollTimerRef.current = window.setTimeout(() => void poll(), 1_200);
          return;
        }
        clearOAuthPolling();
        setOauthAttemptId(null);
        setOauthUrl(null);
        activeOAuthAttemptRef.current = null;
        setBusyAction("idle");
        if (result.status === "success" && result.accountId) {
          await finishAddedAccount(t("account.status.oauth_completed"));
          return;
        }
        showError(mailErrorMessage({
          code: result.code ?? (result.status === "expired" ? "oauth_expired" : "oauth_failed"),
          message: result.message ?? "",
        }, undefined, t));
      } catch (error) {
        if (!mountedRef.current || activeOAuthAttemptRef.current !== attemptId) return;
        clearOAuthPolling();
        setOauthAttemptId(null);
        setOauthUrl(null);
        activeOAuthAttemptRef.current = null;
        setBusyAction("idle");
        showError(friendlyError(error, t));
      }
    };
    void poll();
  }, [clearOAuthPolling, finishAddedAccount, showError, t]);

  const startOAuth = async () => {
    if (!validEmail(normalizedEmail)) {
      showError(t("account.error.email_required_for_login"), "email");
      return;
    }

    // A web popup must be opened synchronously with this click or browsers may block it after the API request.
    const popup = desktopBridge() ? null : window.open("", "nami-mail-oauth", "popup,width=560,height=720");
    oauthPopupRef.current = popup;
    try {
      let nextDiscovery = discoveryEmail === normalizedEmail ? discovery : null;
      if (!nextDiscovery && !fallbackProvider) nextDiscovery = await discoverProvider();
      const provider = nextDiscovery?.oauthProvider ?? activeOAuthProvider;
      if (!provider) {
        popup?.close();
        showError(t("account.error.oauth_unavailable"), "email");
        return;
      }

      setBusyAction("oauth");
      setStatus({ kind: "idle", message: "" });
      const attempt = demoMode
        ? { attemptId: "demo-oauth", authorizationUrl: "https://example.invalid/nami-mail-demo", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
        : await api.startOAuth(provider);
      if (!mountedRef.current) return;
      setOauthAttemptId(attempt.attemptId);
      setOauthUrl(attempt.authorizationUrl);
      activeOAuthAttemptRef.current = attempt.attemptId;

      if (demoMode) {
        popup?.close();
        window.setTimeout(() => {
          if (!mountedRef.current) return;
          setOauthAttemptId(null);
          setOauthUrl(null);
          activeOAuthAttemptRef.current = null;
          setBusyAction("idle");
          void finishAddedAccount(t("account.status.oauth_demo_completed"));
        }, 700);
        return;
      }

      if (popup) {
        popup.opener = null;
        popup.location.replace(attempt.authorizationUrl);
      } else if (desktopBridge()) {
        // Electron's configured window-open handler sends this URL to the system browser.
        window.open(attempt.authorizationUrl, "_blank", "noopener,noreferrer");
      }
      pollOAuthAttempt(attempt.attemptId);
    } catch (error) {
      popup?.close();
      setOauthAttemptId(null);
      setOauthUrl(null);
      activeOAuthAttemptRef.current = null;
      setBusyAction("idle");
      showError(friendlyError(error, t));
    }
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validEmail(normalizedEmail)) {
      showError(t("account.error.email_invalid"), "email");
      return;
    }
    if (!password) {
      showError(t("account.error.credential_required", { credential: activeOnboarding?.credentialLabel ?? t("account.credential.fallback") }), "password");
      return;
    }
    if (manualOpen && !isServerConfigValid(manualConfig)) {
      showError(t("account.error.manual_invalid"), "manual");
      return;
    }

    setBusyAction(manualOpen ? "manual" : "password");
    setStatus({ kind: "idle", message: "" });
    try {
      if (demoMode) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        await finishAddedAccount(t("account.status.demo_connected"));
        return;
      }
      const result = manualOpen
        ? await api.addManualAccount({
          email: normalizedEmail,
          password,
          imap: {
            host: manualConfig.imap.host.trim(),
            port: manualConfig.imap.port,
            transport: manualConfig.imap.transport,
          },
          smtp: {
            host: manualConfig.smtp.host.trim(),
            port: manualConfig.smtp.port,
            transport: manualConfig.smtp.transport,
          },
          ...(manualConfig.imap.username.trim() ? { imapUsername: manualConfig.imap.username.trim() } : {}),
          ...(manualConfig.smtp.username.trim() ? { smtpUsername: manualConfig.smtp.username.trim() } : {}),
        })
        : await api.addAccount(normalizedEmail, password);
      const detail = result.sync
        ? t("account.status.sync_details", { synced: result.sync.synced, folders: result.sync.folders })
        : "";
      if (result.syncWarning) {
        setAccountAdded(true);
        setPassword("");
        await onAdded();
        const issue = result.account.lastErrorCode
          ? presentMailError({ code: result.account.lastErrorCode, message: result.syncWarning }, t)
          : null;
        setStatus({
          kind: "warning",
          message: issue
            ? t("account.status.sync_warning_issue", { title: issue.title, guidance: issue.guidance })
            : locale === "zh-CN"
              ? t("account.status.sync_warning", { warning: result.syncWarning })
              : t("account.status.sync_warning_generic"),
        });
        return;
      }
      await finishAddedAccount(t("account.status.connected", { detail }));
    } catch (error) {
      const issue = presentMailError(error, t);
      // A network, TLS, or protocol problem is not corrected by retyping a
      // password, so keep focus on the status guidance in those cases.
      showError(friendlyError(error, t), issue.kind === "authentication" ? (manualOpen ? "manual" : "password") : undefined);
    } finally {
      if (mountedRef.current) setBusyAction("idle");
    }
  };

  const credentialName = showPasswordFallback && activeOAuthProvider
    ? activeOnboarding?.credentialName ?? t("account.credential.oauth_fallback")
    : activeOnboarding?.credentialLabel ?? t("account.credential.fallback");
  const passwordFallbackName = activeOnboarding?.credentialName ?? t("account.credential.oauth_fallback");
  const setupSteps = guideOnboarding?.setupSteps ?? [];
  const guideIsPreview = !activeDiscovery && Boolean(selectedProviderGuide);
  const sourceNote = guideProvider?.isCustom
    ? guideIsPreview
      ? t("account.guide.custom_preview")
      : t("account.guide.custom_discovered")
    : guideOnboarding?.caveat;
  const guideAvailable = Boolean(guideProvider) && (!needsProviderDiscovery || Boolean(selectedProviderId));
  const serverConfiguration = guideProvider && !guideProvider.isCustom
    ? providerServerConfiguration(guideOnboarding?.name ?? guideProvider.name, guideProvider.imap, guideProvider.smtp, t)
    : null;
  const emailInvalid = status.kind === "error" && status.field === "email";
  const passwordInvalid = status.kind === "error" && status.field === "password";
  const manualInvalid = status.kind === "error" && status.field === "manual";

  const copyServerConfiguration = async () => {
    if (!serverConfiguration) return;
    const copied = await copySetupTextToClipboard(serverConfiguration);
    if (!mountedRef.current) return;
    if (!copied) {
      setStatus({ kind: "warning", message: t("account.status.copy_server_settings_failed") });
      return;
    }
    if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    setServerConfigurationCopied(true);
    serverConfigurationCopyTimerRef.current = window.setTimeout(() => {
      serverConfigurationCopyTimerRef.current = null;
      if (mountedRef.current) setServerConfigurationCopied(false);
    }, 2_500);
  };

  return (
    <div className="modal-backdrop account-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section
        ref={dialogRef}
        className="modal-card account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        aria-describedby="add-account-description"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{t("account.eyebrow")}</span>
            <h2 id="add-account-title">{t("account.title")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.close")} data-tooltip={t("common.close")} onClick={requestClose} disabled={blockingBusy}>
            <X size={18} />
          </button>
        </div>

        <div className="provider-orbit" aria-hidden="true">
          <div className="provider-core"><Mail size={26} strokeWidth={1.7} /></div>
          <span className="orbit-chip chip-a">G</span>
          <span className="orbit-chip chip-b">M</span>
          <span className="orbit-chip chip-c">Q</span>
          <span className="orbit-chip chip-d">163</span>
        </div>

        <p id="add-account-description" className="modal-intro">{t("account.description")}</p>

        <form noValidate onSubmit={submitPassword} className="account-form" aria-busy={busy}>
          <section className="provider-picker" aria-labelledby="provider-picker-title">
            <div className="provider-picker-heading">
              <div>
                <span className="eyebrow">{t("account.provider.eyebrow")}</span>
                <strong id="provider-picker-title">{t("account.provider.title")}</strong>
              </div>
              <button
                className="provider-catalog-toggle"
                type="button"
                aria-expanded={providerCatalogOpen}
                onClick={() => setProviderCatalogOpen((value) => !value)}
                disabled={busy || accountAdded}
              >
                {providerCatalogOpen ? t("account.provider.collapse_catalog") : t("account.provider.more")}
                <ChevronDown className={providerCatalogOpen ? "open" : ""} size={14} />
              </button>
            </div>
            <div className="provider-quick-grid">
              {quickProviders.map((provider) => (
                <button
                  key={provider.id}
                  className={`provider-choice${selectedProviderId === provider.id ? " selected" : ""}`}
                  type="button"
                  aria-pressed={selectedProviderId === provider.id}
                  aria-label={t("account.provider.select_aria", { provider: providerDisplayName(provider, locale, t) })}
                  onClick={() => selectProvider(provider.id)}
                  disabled={busy || accountAdded}
                >
                  <span className="provider-choice-mark" aria-hidden="true">{providerMonogram(provider)}</span>
                  <span className="provider-choice-copy">
                    <strong>{providerDisplayName(provider, locale, t)}</strong>
                    <small>{provider.domains[0]}</small>
                  </span>
                </button>
              ))}
              <button
                className={`provider-choice provider-choice-custom${selectedProviderId === CUSTOM_IMAP_PROVIDER_ID ? " selected" : ""}`}
                type="button"
                aria-pressed={selectedProviderId === CUSTOM_IMAP_PROVIDER_ID}
                onClick={() => selectProvider(CUSTOM_IMAP_PROVIDER_ID)}
                disabled={busy || accountAdded}
              >
                <span className="provider-choice-mark" aria-hidden="true"><Server size={15} /></span>
                <span className="provider-choice-copy">
                  <strong>{t("account.provider.custom_name")}</strong>
                  <small>{t("account.provider.custom_description")}</small>
                </span>
              </button>
            </div>
            {providerCatalogOpen && (
              <label className="provider-catalog-select" htmlFor="account-provider-catalog">
                <span>{t("account.provider.catalog_label")}</span>
                <ThemedSelect
                  id="account-provider-catalog"
                  value={selectedProviderId}
                  onValueChange={selectProvider}
                  disabled={busy || accountAdded}
                >
                  <option value="">{t("account.provider.catalog_placeholder")}</option>
                  {(["P0", "P1", "P2"] as const).map((priority) => {
                    const options = orderedProviders.filter((provider) => provider.priority === priority);
                    return options.length ? (
                      <optgroup key={priority} label={t(`account.provider.priority.${priority.toLowerCase()}`)}>
                        {options.map((provider) => <option key={provider.id} value={provider.id}>{providerDisplayName(provider, locale, t)} · {provider.domains[0]}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                  <option value={CUSTOM_IMAP_PROVIDER_ID}>{t("account.provider.custom_option")}</option>
                </ThemedSelect>
              </label>
            )}
            <small className="provider-picker-note">{t("account.provider.picker_note")}</small>
          </section>

          <div className="account-email-row">
            <label htmlFor="account-email">
              <span>{t("account.email.label")}</span>
              <input
                ref={emailRef}
                id="account-email"
                type="text"
                inputMode="email"
                autoCapitalize="none"
                data-dialog-initial-focus
                autoComplete="email"
                spellCheck={false}
                placeholder="name@example.com"
                value={email}
                onChange={updateEmail}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => {
                  if (!emailComposingRef.current) setEmailFocused(false);
                }}
                onCompositionStart={beginEmailComposition}
                onCompositionEnd={endEmailComposition}
                disabled={blockingBusy || accountAdded}
                required
                aria-invalid={emailInvalid}
                aria-describedby={emailInvalid ? "account-form-status" : "account-email-help"}
              />
            </label>
            <button className="secondary-button account-discover-button" type="button" onClick={() => void discoverProvider()} disabled={busy || accountAdded || !validEmail(normalizedEmail)}>
              {busyAction === "discover" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              {busyAction === "discover" ? t("account.email.discover_busy") : t("account.email.discover")}
            </button>
          </div>
          <small id="account-email-help" className="account-field-help">{t("account.email.help")}</small>

          {activeDiscovery && (
            <section className={`provider-hint account-provider-result${manualReviewRecommended(activeDiscovery) ? " warning" : ""}`} aria-live="polite">
              <ShieldCheck size={17} />
              <div>
                <strong>{activeProviderName}</strong>
                <span>{activeOnboarding?.helpText ?? activeOnboarding?.credentialHint}</span>
                {sourceNote && <small>{sourceNote}</small>}
              </div>
            </section>
          )}

          {needsProviderDiscovery && (
            <section className="account-discovery-pending" role="status" aria-live="polite">
              {busyAction === "discover" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              <span>{busyAction === "discover"
                ? t("account.discovery.busy")
                : t("account.discovery.idle")}</span>
            </section>
          )}

          {guideAvailable && !accountAdded && guideProvider && (
            <>
              <button className="guide-toggle" type="button" aria-expanded={showGuide} onClick={() => setShowGuide((value) => !value)} disabled={busy}>
                <KeyRound size={15} />
                <span>{guideIsPreview
                  ? t("account.guide.toggle_preview", { provider: guideProviderName })
                  : t("account.guide.toggle", { provider: guideProviderName })}</span>
                <ChevronDown className={showGuide ? "open" : ""} size={15} />
              </button>

              {showGuide && (
                <section className="setup-guide" aria-label={t("account.guide.aria", { provider: guideProviderName })}>
                  <div className="setup-guide-title">
                    <div>
                      <span>{t("account.guide.title")}</span>
                      <strong>{guideProviderName}</strong>
                    </div>
                    <ShieldCheck size={17} />
                  </div>
                  {guideIsPreview && <p className="setup-guide-preview">{t("account.guide.preview")}</p>}
                  <div className="setup-guide-auth">
                    <span>{t("account.guide.recommended_login")}</span>
                    <strong>{providerAuthLabel(guideProvider.recommendedAuthMethod, t)}</strong>
                    <small>{guideOnboarding?.credentialLabel}</small>
                  </div>
                  <ol>
                    {setupSteps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {serverConfiguration && (
                    <div className="setup-guide-server-settings">
                      <dl className="setup-guide-endpoints">
                        <div><dt>IMAP</dt><dd>{serverEndpointLabel(guideProvider.imap, t)}</dd></div>
                        <div><dt>SMTP</dt><dd>{serverEndpointLabel(guideProvider.smtp, t)}</dd></div>
                      </dl>
                      <button
                        className={`setup-guide-copy${serverConfigurationCopied ? " copied" : ""}`}
                        type="button"
                        onClick={() => void copyServerConfiguration()}
                        aria-label={serverConfigurationCopied
                          ? t("account.server.copied_aria")
                          : t("account.server.copy_aria", { provider: guideProviderName })}
                      >
                        {serverConfigurationCopied ? <Check size={14} /> : <Copy size={14} />}
                        <span>{serverConfigurationCopied ? t("account.server.copied") : t("account.server.copy")}</span>
                      </button>
                      <small className="setup-guide-copy-note">{t("account.server.copy_note")}</small>
                    </div>
                  )}
                  {sourceNote && <p><strong>{t("account.guide.note")}</strong>{sourceNote}</p>}
                  {guideProvider.helpUrl && (
                    <a href={guideProvider.helpUrl} target="_blank" rel="noreferrer">
                      {guideOnboarding?.helpLabel ?? t("account.guide.open_official")}
                      <ExternalLink size={13} />
                    </a>
                  )}
                </section>
              )}
            </>
          )}

          {activeOAuthProvider && !manualOpen && !showPasswordFallback && !accountAdded && (
            <section className="account-oauth-panel" aria-labelledby="oauth-login-title">
              <div>
                <span className="eyebrow">{t("account.oauth.eyebrow")}</span>
                <strong id="oauth-login-title">{t("account.oauth.title", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}</strong>
                <p>{t("account.oauth.description")}</p>
              </div>
              {!oauthAvailable && <small className="oauth-config-note">{t("account.oauth.config_unavailable", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}</small>}
              <button className="primary-button large oauth-button" type="button" onClick={() => void startOAuth()} disabled={busy || !oauthAvailable}>
                {busyAction === "oauth" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
                {busyAction === "oauth"
                  ? t("account.oauth.waiting_browser")
                  : oauthAvailable
                    ? t("account.oauth.sign_in", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })
                    : t("account.oauth.unavailable")}
              </button>
              {canUsePassword && (
                <button className="account-link-button" type="button" onClick={() => setShowPasswordFallback(true)} disabled={busy}>
                  {t("account.oauth.use_password_fallback", { credential: passwordFallbackName })}
                </button>
              )}
            </section>
          )}

          {isOAuthWaiting && (
            <section className="account-oauth-wait" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={18} />
              <div>
                <strong>{t("account.oauth.waiting_title")}</strong>
                <span>{t("account.oauth.waiting_description")}</span>
                {oauthUrl && !desktopBridge() && <a href={oauthUrl} target="_blank" rel="noopener noreferrer">{t("account.oauth.open_browser")} <ExternalLink size={12} /></a>}
              </div>
              <button className="secondary-button" type="button" onClick={cancelOAuth}>{t("common.cancel")}</button>
            </section>
          )}

          {usingPassword && !accountAdded && (
            <>
              {activeOAuthProvider && !manualOpen && (
                <button className="account-link-button account-link-back" type="button" onClick={() => setShowPasswordFallback(false)} disabled={busy}>
                  {t("account.oauth.back_to_sign_in", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}
                </button>
              )}
              <label htmlFor="account-password">
                <span className="credential-label">{credentialName}<em>{t("account.credential.no_one_time_code")}</em></span>
                <input
                  ref={passwordRef}
                  id="account-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("account.credential.paste", { credential: credentialName })}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  required
                  aria-invalid={passwordInvalid}
                  aria-describedby={passwordInvalid ? "account-form-status" : "account-credential-help"}
                />
              </label>
              <small id="account-credential-help" className="account-field-help">{activeOnboarding?.credentialHint ?? t("account.credential.help")}</small>

              <button className="account-link-button manual-config-toggle" type="button" onClick={openManualConfig} disabled={busy} aria-expanded={manualOpen}>
                {manualOpen ? t("account.manual.collapse") : t("account.manual.open")}
              </button>

              {manualOpen && (
                <fieldset className="manual-server-config" disabled={busy}>
                  <legend>{t("account.manual.legend")}</legend>
                  <p>{t("account.manual.description")}</p>
                  {(["imap", "smtp"] as const).map((server) => {
                    const config = manualConfig[server];
                    const label = server.toUpperCase();
                    return (
                      <section key={server} className="manual-server-group" aria-labelledby={`manual-${server}-title`}>
                        <div className="manual-server-title"><strong id={`manual-${server}-title`}>{label}</strong><small>{server === "imap" ? t("account.manual.incoming") : t("account.manual.outgoing")}</small></div>
                        <div className="manual-server-grid">
                          <label className="manual-host-field" htmlFor={`manual-${server}-host`}>
                            <span>{t("account.manual.server")}</span>
                            <input
                              ref={server === "imap" ? manualRef : undefined}
                              id={`manual-${server}-host`}
                              type="text"
                              inputMode="url"
                              autoComplete="off"
                              spellCheck={false}
                              value={config.host}
                              onChange={(event) => updateManualServer(server, "host", event.target.value)}
                              aria-invalid={manualInvalid}
                              aria-describedby={manualInvalid ? "account-form-status" : undefined}
                            />
                          </label>
                          <label htmlFor={`manual-${server}-port`}>
                            <span>{t("account.manual.port")}</span>
                            <input
                              id={`manual-${server}-port`}
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={65_535}
                              value={config.port}
                              onChange={(event) => updateManualServer(server, "port", event.target.value)}
                              aria-invalid={manualInvalid}
                            />
                          </label>
                          <label htmlFor={`manual-${server}-transport`}>
                            <span>{t("account.manual.encryption")}</span>
                            <ThemedSelect id={`manual-${server}-transport`} value={config.transport} onValueChange={(value) => updateManualServer(server, "transport", value)} aria-invalid={manualInvalid}>
                              <option value="tls">TLS/SSL</option>
                              <option value="starttls">STARTTLS</option>
                            </ThemedSelect>
                          </label>
                          <label className="manual-username-field" htmlFor={`manual-${server}-username`}>
                            <span>{t("account.manual.username")} <em>{t("account.manual.optional")}</em></span>
                            <input
                              id={`manual-${server}-username`}
                              type="text"
                              autoComplete="username"
                              value={config.username}
                              onChange={(event) => updateManualServer(server, "username", event.target.value)}
                              placeholder={normalizedEmail || t("account.manual.username_placeholder")}
                            />
                          </label>
                        </div>
                        <small className="manual-transport-note">{t("account.manual.transport_note", { transport: serverModeLabel(config.transport) })}</small>
                      </section>
                    );
                  })}
                </fieldset>
              )}

              <button className="primary-button large" type="submit" disabled={busy || !password}>
                {busyAction === "password" || busyAction === "manual" ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                {busyAction === "password" || busyAction === "manual"
                  ? t("account.manual.validating")
                  : manualOpen
                    ? t("account.manual.validate_and_add")
                    : t("account.manual.verify_and_add")}
              </button>
            </>
          )}

          {accountAdded && <button className="primary-button large" type="button" onClick={onClose}>{t("account.done")}</button>}

          {status.kind !== "idle" && (
            <div
              ref={statusRef}
              id="account-form-status"
              className={`form-status ${status.kind}`}
              role={status.kind === "error" ? "alert" : "status"}
              aria-live={status.kind === "error" ? "assertive" : "polite"}
              tabIndex={-1}
            >
              {status.kind === "success" ? <Check size={17} /> : status.kind === "warning" ? <CircleAlert size={17} /> : <X size={17} />}
              {status.message}
            </div>
          )}
        </form>
        <p className="privacy-note">{t("account.privacy_note")}</p>
      </section>
    </div>
  );
}
