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
import {
  CUSTOM_IMAP_PROVIDER_ID,
  orderedProviderCatalog,
  providerAuthLabel,
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
const providerPriorityLabels = {
  P0: "常用服务商",
  P1: "更多服务商",
  P2: "其他支持的服务商",
} as const;

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

function providerFallback(provider: ProviderInfo | undefined, domain: string): ProviderDiscovery | undefined {
  if (!domain) return undefined;
  const authMethods = providerAuthMethods(provider);
  return {
    id: provider?.id ?? "custom",
    name: provider?.name ?? "其他邮箱（IMAP）",
    family: provider?.family ?? "custom",
    priority: provider?.priority,
    domain,
    isCustom: !provider,
    source: provider ? "preset" : "conventional",
    confidence: provider ? "high" : "low",
    authMethods,
    recommendedAuthMethod: provider?.recommendedAuthMethod ?? authMethods[0],
    credentialLabel: provider?.credentialLabel ?? provider?.credentialName ?? "邮箱密码或应用专用密码",
    credentialName: provider?.credentialName ?? "邮箱密码或应用专用密码",
    credentialHint: provider?.credentialHint ?? "请使用邮箱服务商允许第三方客户端使用的密码、应用专用密码或授权码。",
    helpText: provider?.helpText,
    caveat: provider?.caveat,
    setupSteps: provider?.setupSteps ?? [
      "在邮箱设置中开启 IMAP 和 SMTP 服务。",
      "如已开启两步验证，请生成应用专用密码或客户端授权码。",
      "请勿填写短信、邮箱或验证器中的一次性验证码。",
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

function friendlyError(error: unknown): string {
  return mailErrorMessage(error);
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

function resultForDemo(email: string, fallback: ProviderDiscovery | undefined): AccountDiscoveryResult {
  const provider = fallback ?? providerFallback(undefined, emailDomain(email));
  if (!provider) throw new Error("请输入邮箱地址后继续。");
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
    () => validEmail(normalizedEmail) ? providerFallback(matchedProvider, domain) : undefined,
    [domain, matchedProvider, normalizedEmail],
  );
  const activeDiscovery = discoveryEmail === normalizedEmail ? discovery?.provider ?? fallbackProvider : fallbackProvider;
  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  const selectedProviderGuide = useMemo(() => {
    if (selectedProvider) return providerFallback(selectedProvider, selectedProvider.domains[0] ?? "");
    return selectedProviderId === CUSTOM_IMAP_PROVIDER_ID
      ? providerFallback(undefined, "your-domain.example")
      : undefined;
  }, [selectedProvider, selectedProviderId]);
  const guideProvider = activeDiscovery ?? selectedProviderGuide;
  const orderedProviders = useMemo(() => orderedProviderCatalog(providers), [providers]);
  const quickProviders = useMemo(() => quickProviderCatalog(providers), [providers]);
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
      const fallback = providerFallback(localProvider, emailDomain(candidate));
      const result = demoMode ? resultForDemo(candidate, fallback) : await api.discoverAccount(candidate);
      if (!mountedRef.current || requestId !== discoveryRequestIdRef.current || candidate !== emailValueRef.current.trim().toLowerCase()) return null;
      setDiscovery(result);
      setDiscoveryEmail(candidate);
      if (manualReviewRecommended(result.provider)) {
        setStatus({ kind: "warning", message: "已找到可能的连接设置。请核对服务器信息，必要时改用手动配置。" });
      }
      return result;
    } catch (error) {
      if (mountedRef.current && requestId === discoveryRequestIdRef.current && candidate === emailValueRef.current.trim().toLowerCase()) {
        setDiscovery(null);
        setDiscoveryEmail(candidate);
        setStatus({ kind: "warning", message: "未能自动识别服务商。你仍可手动填写 IMAP/SMTP 设置继续。" });
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === discoveryRequestIdRef.current) {
        setBusyAction((current) => current === "discover" ? "idle" : current);
      }
    }
  }, [demoMode, discovery, discoveryEmail, providers]);

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
      if (mountedRef.current) setStatus({ kind: "warning", message: "邮箱已添加。邮件列表暂未刷新，请关闭并重新打开 Nami Mail 后查看。" });
    }
  }, [onAdded, scheduleClose]);

  const cancelOAuth = () => {
    clearOAuthPolling();
    activeOAuthAttemptRef.current = null;
    oauthPopupRef.current?.close();
    oauthPopupRef.current = null;
    setOauthAttemptId(null);
    setOauthUrl(null);
    setBusyAction("idle");
    setStatus({ kind: "warning", message: "已停止等待授权。浏览器中的页面可以直接关闭。" });
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
          await finishAddedAccount("授权已完成，邮箱已添加。");
          return;
        }
        showError(mailErrorMessage({
          code: result.code ?? (result.status === "expired" ? "oauth_expired" : "oauth_failed"),
          message: result.message ?? "",
        }));
      } catch (error) {
        if (!mountedRef.current || activeOAuthAttemptRef.current !== attemptId) return;
        clearOAuthPolling();
        setOauthAttemptId(null);
        setOauthUrl(null);
        activeOAuthAttemptRef.current = null;
        setBusyAction("idle");
        showError(friendlyError(error));
      }
    };
    void poll();
  }, [clearOAuthPolling, finishAddedAccount, showError]);

  const startOAuth = async () => {
    if (!validEmail(normalizedEmail)) {
      showError("请输入有效的邮箱地址后继续登录。", "email");
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
        showError("该邮箱当前没有可用的安全登录方式。请使用应用专用密码或手动配置。", "email");
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
          void finishAddedAccount("授权已完成（演示模式）。");
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
      showError(friendlyError(error));
    }
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validEmail(normalizedEmail)) {
      showError("请输入有效的邮箱地址。", "email");
      return;
    }
    if (!password) {
      showError(`请填写${activeDiscovery?.credentialLabel ?? "密码或授权码"}。`, "password");
      return;
    }
    if (manualOpen && !isServerConfigValid(manualConfig)) {
      showError("请填写有效的 IMAP 与 SMTP 主机、端口和 TLS 模式。", "manual");
      return;
    }

    setBusyAction(manualOpen ? "manual" : "password");
    setStatus({ kind: "idle", message: "" });
    try {
      if (demoMode) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        await finishAddedAccount("邮箱已连接，已同步最近邮件。");
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
      const detail = result.sync ? `，已同步 ${result.sync.synced} 封邮件 / ${result.sync.folders} 个文件夹` : "";
      if (result.syncWarning) {
        setAccountAdded(true);
        setPassword("");
        await onAdded();
        const issue = result.account.lastErrorCode
          ? presentMailError({ code: result.account.lastErrorCode, message: result.syncWarning })
          : null;
        setStatus({
          kind: "warning",
          message: issue
            ? `邮箱已添加，但首次同步未完成。${issue.title}：${issue.guidance}`
            : `邮箱已添加，${result.syncWarning}。可稍后在账户设置中重新同步。`,
        });
        return;
      }
      await finishAddedAccount(`邮箱已连接${detail}。`);
    } catch (error) {
      const issue = presentMailError(error);
      // A network, TLS, or protocol problem is not corrected by retyping a
      // password, so keep focus on the status guidance in those cases.
      showError(friendlyError(error), issue.kind === "authentication" ? (manualOpen ? "manual" : "password") : undefined);
    } finally {
      if (mountedRef.current) setBusyAction("idle");
    }
  };

  const credentialName = showPasswordFallback && activeOAuthProvider
    ? activeDiscovery?.credentialName ?? "应用专用密码或授权码"
    : activeDiscovery?.credentialLabel ?? "密码或授权码";
  const passwordFallbackName = activeDiscovery?.credentialName ?? "应用专用密码或授权码";
  const setupSteps = guideProvider?.setupSteps ?? [];
  const guideIsPreview = !activeDiscovery && Boolean(selectedProviderGuide);
  const sourceNote = guideProvider?.isCustom
    ? guideIsPreview
      ? "填写完整企业或学校邮箱后，Nami Mail 会尝试查找可用的连接设置；也可以随时选择手动配置。"
      : "此邮箱的设置由自动查找得出，请与邮箱管理员提供的信息核对。"
    : guideProvider?.caveat;
  const guideAvailable = Boolean(guideProvider) && (!needsProviderDiscovery || Boolean(selectedProviderId));
  const serverConfiguration = guideProvider && !guideProvider.isCustom
    ? providerServerConfiguration(guideProvider.name, guideProvider.imap, guideProvider.smtp)
    : null;
  const emailInvalid = status.kind === "error" && status.field === "email";
  const passwordInvalid = status.kind === "error" && status.field === "password";
  const manualInvalid = status.kind === "error" && status.field === "manual";

  const copyServerConfiguration = async () => {
    if (!serverConfiguration) return;
    const copied = await copySetupTextToClipboard(serverConfiguration);
    if (!mountedRef.current) return;
    if (!copied) {
      setStatus({ kind: "warning", message: "无法直接复制服务器设置。请选中上方 IMAP / SMTP 信息后复制。" });
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
            <span className="eyebrow">添加账户</span>
            <h2 id="add-account-title">添加邮箱</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" data-tooltip="关闭" onClick={requestClose} disabled={blockingBusy}>
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

        <p id="add-account-description" className="modal-intro">输入邮箱地址后，选择服务商支持的安全登录方式。服务器设置和凭据仅用于连接你选择的邮件服务商。</p>

        <form noValidate onSubmit={submitPassword} className="account-form" aria-busy={busy}>
          <section className="provider-picker" aria-labelledby="provider-picker-title">
            <div className="provider-picker-heading">
              <div>
                <span className="eyebrow">快速设置</span>
                <strong id="provider-picker-title">选择服务商，查看连接方式</strong>
              </div>
              <button
                className="provider-catalog-toggle"
                type="button"
                aria-expanded={providerCatalogOpen}
                onClick={() => setProviderCatalogOpen((value) => !value)}
                disabled={busy || accountAdded}
              >
                {providerCatalogOpen ? "收起列表" : "更多服务商"}
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
                  aria-label={`选择 ${provider.name}，查看接入步骤`}
                  onClick={() => selectProvider(provider.id)}
                  disabled={busy || accountAdded}
                >
                  <span className="provider-choice-mark" aria-hidden="true">{providerMonogram(provider)}</span>
                  <span className="provider-choice-copy">
                    <strong>{provider.name}</strong>
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
                  <strong>其他邮箱</strong>
                  <small>企业、高校或自定义域</small>
                </span>
              </button>
            </div>
            {providerCatalogOpen && (
              <label className="provider-catalog-select" htmlFor="account-provider-catalog">
                <span>从服务商列表选择</span>
                <ThemedSelect
                  id="account-provider-catalog"
                  value={selectedProviderId}
                  onValueChange={selectProvider}
                  disabled={busy || accountAdded}
                >
                  <option value="">稍后选择服务商</option>
                  {(["P0", "P1", "P2"] as const).map((priority) => {
                    const options = orderedProviders.filter((provider) => provider.priority === priority);
                    return options.length ? (
                      <optgroup key={priority} label={providerPriorityLabels[priority]}>
                        {options.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.domains[0]}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                  <option value={CUSTOM_IMAP_PROVIDER_ID}>其他邮箱 / 企业邮箱</option>
                </ThemedSelect>
              </label>
            )}
            <small className="provider-picker-note">选择服务商只会展示登录与服务器说明，不会填写或提交你的邮箱地址。</small>
          </section>

          <div className="account-email-row">
            <label htmlFor="account-email">
              <span>邮箱地址</span>
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
              {busyAction === "discover" ? "识别中" : "识别服务商"}
            </button>
          </div>
          <small id="account-email-help" className="account-field-help">支持个人、企业和高校邮箱；输入完整企业或学校邮箱后，Nami Mail 会查找连接设置。</small>

          {activeDiscovery && (
            <section className={`provider-hint account-provider-result${manualReviewRecommended(activeDiscovery) ? " warning" : ""}`} aria-live="polite">
              <ShieldCheck size={17} />
              <div>
                <strong>{activeDiscovery.name}</strong>
                <span>{activeDiscovery.helpText ?? activeDiscovery.credentialHint}</span>
                {sourceNote && <small>{sourceNote}</small>}
              </div>
            </section>
          )}

          {needsProviderDiscovery && (
            <section className="account-discovery-pending" role="status" aria-live="polite">
              {busyAction === "discover" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              <span>{busyAction === "discover"
                ? "正在查找此企业或学校邮箱的连接设置。"
                : "输入完整邮箱地址后，将自动查找企业或学校邮箱的连接设置。"}</span>
            </section>
          )}

          {guideAvailable && !accountAdded && guideProvider && (
            <>
              <button className="guide-toggle" type="button" aria-expanded={showGuide} onClick={() => setShowGuide((value) => !value)} disabled={busy}>
                <KeyRound size={15} />
                <span>{guideIsPreview ? `查看 ${guideProvider.name} 接入指南` : `查看 ${guideProvider.name} 连接步骤`}</span>
                <ChevronDown className={showGuide ? "open" : ""} size={15} />
              </button>

              {showGuide && (
                <section className="setup-guide" aria-label={`${guideProvider.name} 连接步骤`}>
                  <div className="setup-guide-title">
                    <div>
                      <span>连接指南</span>
                      <strong>{guideProvider.name}</strong>
                    </div>
                    <ShieldCheck size={17} />
                  </div>
                  {guideIsPreview && <p className="setup-guide-preview">填写完整邮箱地址后，才会开始验证连接设置。</p>}
                  <div className="setup-guide-auth">
                    <span>推荐登录方式</span>
                    <strong>{providerAuthLabel(guideProvider.recommendedAuthMethod)}</strong>
                    <small>{guideProvider.credentialLabel}</small>
                  </div>
                  <ol>
                    {setupSteps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {serverConfiguration && (
                    <div className="setup-guide-server-settings">
                      <dl className="setup-guide-endpoints">
                        <div><dt>IMAP</dt><dd>{serverEndpointLabel(guideProvider.imap)}</dd></div>
                        <div><dt>SMTP</dt><dd>{serverEndpointLabel(guideProvider.smtp)}</dd></div>
                      </dl>
                      <button
                        className={`setup-guide-copy${serverConfigurationCopied ? " copied" : ""}`}
                        type="button"
                        onClick={() => void copyServerConfiguration()}
                        aria-label={serverConfigurationCopied ? "服务器设置已复制" : `复制 ${guideProvider.name} 服务器设置`}
                      >
                        {serverConfigurationCopied ? <Check size={14} /> : <Copy size={14} />}
                        <span>{serverConfigurationCopied ? "已复制服务器设置" : "复制服务器设置"}</span>
                      </button>
                      <small className="setup-guide-copy-note">仅复制 IMAP / SMTP 地址、端口和加密方式，不含邮箱地址或凭据。</small>
                    </div>
                  )}
                  {sourceNote && <p><strong>注意：</strong>{sourceNote}</p>}
                  {guideProvider.helpUrl && (
                    <a href={guideProvider.helpUrl} target="_blank" rel="noreferrer">
                      {guideProvider.helpLabel ?? "打开服务商官方设置"}
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
                <span className="eyebrow">推荐方式</span>
                <strong id="oauth-login-title">使用 {activeOAuthProvider === "google" ? "Google" : "Microsoft"} 登录</strong>
                <p>通过官方安全登录授权。Nami Mail 不会要求你输入该服务商的网页登录密码。</p>
              </div>
              {!oauthAvailable && <small className="oauth-config-note">此设备尚未配置 {activeOAuthProvider === "google" ? "Google" : "Microsoft"} 安全登录；请查看上方连接步骤。若这是组织部署的应用，请联系管理员完成配置。</small>}
              <button className="primary-button large oauth-button" type="button" onClick={() => void startOAuth()} disabled={busy || !oauthAvailable}>
                {busyAction === "oauth" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
                {busyAction === "oauth" ? "等待浏览器授权…" : oauthAvailable ? `使用 ${activeOAuthProvider === "google" ? "Google" : "Microsoft"} 登录` : "安全登录尚未配置"}
              </button>
              {canUsePassword && (
                <button className="account-link-button" type="button" onClick={() => setShowPasswordFallback(true)} disabled={busy}>
                  改用{passwordFallbackName}
                </button>
              )}
            </section>
          )}

          {isOAuthWaiting && (
            <section className="account-oauth-wait" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={18} />
              <div>
                <strong>等待安全登录完成</strong>
                <span>请在系统浏览器中完成授权；此窗口会自动继续。</span>
                {oauthUrl && !desktopBridge() && <a href={oauthUrl} target="_blank" rel="noopener noreferrer">浏览器没有打开？在此继续登录 <ExternalLink size={12} /></a>}
              </div>
              <button className="secondary-button" type="button" onClick={cancelOAuth}>取消</button>
            </section>
          )}

          {usingPassword && !accountAdded && (
            <>
              {activeOAuthProvider && !manualOpen && (
                <button className="account-link-button account-link-back" type="button" onClick={() => setShowPasswordFallback(false)} disabled={busy}>
                  返回使用 {activeOAuthProvider === "google" ? "Google" : "Microsoft"} 登录
                </button>
              )}
              <label htmlFor="account-password">
                <span className="credential-label">{credentialName}<em>请勿填写一次性验证码</em></span>
                <input
                  ref={passwordRef}
                  id="account-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={`粘贴${credentialName}`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  required
                  aria-invalid={passwordInvalid}
                  aria-describedby={passwordInvalid ? "account-form-status" : "account-credential-help"}
                />
              </label>
              <small id="account-credential-help" className="account-field-help">{activeDiscovery?.credentialHint ?? "请使用服务商允许第三方客户端使用的专用凭据。"}</small>

              <button className="account-link-button manual-config-toggle" type="button" onClick={openManualConfig} disabled={busy} aria-expanded={manualOpen}>
                {manualOpen ? "收起手动服务器设置" : "手动设置 IMAP / SMTP 服务器"}
              </button>

              {manualOpen && (
                <fieldset className="manual-server-config" disabled={busy}>
                  <legend>手动服务器设置</legend>
                  <p>仅支持 TLS/SSL 或 STARTTLS。连接前会同时验证收件和发件服务器。</p>
                  {(["imap", "smtp"] as const).map((server) => {
                    const config = manualConfig[server];
                    const label = server.toUpperCase();
                    return (
                      <section key={server} className="manual-server-group" aria-labelledby={`manual-${server}-title`}>
                        <div className="manual-server-title"><strong id={`manual-${server}-title`}>{label}</strong><small>{server === "imap" ? "收件" : "发件"}</small></div>
                        <div className="manual-server-grid">
                          <label className="manual-host-field" htmlFor={`manual-${server}-host`}>
                            <span>服务器</span>
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
                            <span>端口</span>
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
                            <span>加密</span>
                            <ThemedSelect id={`manual-${server}-transport`} value={config.transport} onValueChange={(value) => updateManualServer(server, "transport", value)} aria-invalid={manualInvalid}>
                              <option value="tls">TLS/SSL</option>
                              <option value="starttls">STARTTLS</option>
                            </ThemedSelect>
                          </label>
                          <label className="manual-username-field" htmlFor={`manual-${server}-username`}>
                            <span>用户名 <em>可选</em></span>
                            <input
                              id={`manual-${server}-username`}
                              type="text"
                              autoComplete="username"
                              value={config.username}
                              onChange={(event) => updateManualServer(server, "username", event.target.value)}
                              placeholder={normalizedEmail || "通常为邮箱地址"}
                            />
                          </label>
                        </div>
                        <small className="manual-transport-note">当前使用 {serverModeLabel(config.transport)}；不支持明文连接。</small>
                      </section>
                    );
                  })}
                </fieldset>
              )}

              <button className="primary-button large" type="submit" disabled={busy || !password}>
                {busyAction === "password" || busyAction === "manual" ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                {busyAction === "password" || busyAction === "manual" ? "正在验证收件和发件服务器…" : manualOpen ? "验证设置并添加" : "验证并添加"}
              </button>
            </>
          )}

          {accountAdded && <button className="primary-button large" type="button" onClick={onClose}>完成</button>}

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
        <p className="privacy-note">仅使用 TLS 加密连接 · 凭据加密保存在此设备 · OAuth 授权以服务商验证结果为准</p>
      </section>
    </div>
  );
}
