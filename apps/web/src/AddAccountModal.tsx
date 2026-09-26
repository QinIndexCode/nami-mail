import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type FormEvent, type RefObject } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  Mail,
  Mailbox,
  Plus,
  ShieldCheck,
  Wand2,
  X,
} from "lucide-react";
import { api } from "./api";
import { desktopBridge } from "./desktop";
import { mailErrorMessage, presentMailError } from "./errorPresentation";
import { type Translate, useI18n } from "./i18n";
import {
  CUSTOM_IMAP_PROVIDER_ID,
  fullCatalogProviders,
  localizedProviderOnboarding,
  orderedProviderCatalog,
  providerAuthLabel,
  providerDisplayName,
  providerIconUrl,
  providerMonogram,
  providerServerConfiguration,
  quickProviderCatalog,
  serverEndpointLabel,
} from "./providerOnboarding";
import ThemedSelect from "./ThemedSelect";
import type {
  Account,
  AccountDiscoveryResult,
  ManualAccountConfig,
  MailTransport,
  OAuthProvider,
  ProviderDiscovery,
  ProviderInfo,
} from "./types";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";

type StatusKind = "success" | "warning" | "error" | "idle";
type StatusField = "email" | "password" | "manual";
type FormStatus = { kind: StatusKind; message: string; field?: StatusField };
type BusyAction = "idle" | "discover" | "password" | "manual" | "oauth";

type AddAccountModalProps = {
  providers: ProviderInfo[];
  /** Already-added local accounts, so a duplicate email is caught before the server round-trip. */
  existingAccounts: Account[];
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

/**
 * Gmail-style plus addressing (`user+tag@gmail.com`) delivers into the same
 * mailbox as `user@gmail.com`, so duplicates must be detected against the
 * canonical address. Other domains are untouched because `+` is not a
 * guaranteed alias mechanism there.
 */
export function canonicalGmailEmail(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return trimmed;
  const plus = local.indexOf("+");
  if (plus <= 0) return trimmed;
  return `${local.slice(0, plus)}@${domain}`;
}

/**
 * Computes the updated email address and target cursor index when a provider is selected.
 * - When targetDomain is provided (e.g. "gmail.com"):
 *   - If input is empty or only a domain suffix (e.g. "@qq.com"), sets "@gmail.com" and places cursor at 0.
 *   - If input already contains a username (e.g. "user" or "user@qq.com"), preserves username and appends "@gmail.com", placing cursor right after the username.
 * - When targetDomain is empty (e.g. Custom IMAP):
 *   - If input was only a suffix (e.g. "@gmail.com"), resets to "" with cursor at 0.
 *   - If input had a username, keeps it with cursor at the end.
 */
export function computeEmailAfterProviderSelect(
  currentEmail: string,
  targetDomain: string | undefined
): { nextEmail: string; cursorPos: number } {
  if (!targetDomain) {
    if (currentEmail.trim().startsWith("@")) {
      return { nextEmail: "", cursorPos: 0 };
    }
    return { nextEmail: currentEmail, cursorPos: currentEmail.length };
  }

  const domainSuffix = `@${targetDomain.toLowerCase()}`;
  const trimmed = currentEmail.trim();

  if (!trimmed || trimmed.startsWith("@")) {
    return { nextEmail: domainSuffix, cursorPos: 0 };
  }

  const atIndex = trimmed.indexOf("@");
  if (atIndex !== -1) {
    const username = trimmed.slice(0, atIndex).trim();
    if (!username) {
      return { nextEmail: domainSuffix, cursorPos: 0 };
    }
    return { nextEmail: `${username}${domainSuffix}`, cursorPos: username.length };
  }

  return { nextEmail: `${trimmed}${domainSuffix}`, cursorPos: trimmed.length };
}

function emailDomain(value: string): string {
  return value.trim().toLowerCase().split("@")[1] ?? "";
}

function providerAuthMethods(provider?: ProviderInfo): string[] {
  if (provider?.authMethods?.length) return provider.authMethods;
  if (provider?.id === "gmail") return ["app-password", "oauth2"];
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
    // Keep the conventional fallback aligned with the server-side custom
    // provider (providers.ts), so what the user previews is what gets tested.
    smtp: provider?.smtp ?? { host: `smtp.${domain}`, port: 465, transport: "tls" },
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
    smtp: defaultServer(smtp?.host ?? (domain ? `smtp.${domain}` : ""), smtp?.port ?? 465, smtp?.transport ?? "tls", smtpUsername),
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

export default function AddAccountModal({ providers, existingAccounts, onClose, onAdded, fallbackFocusRef, demoMode = false }: AddAccountModalProps) {
  const { locale, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>("idle");
  const [tutorialDrawerOpen, setTutorialDrawerOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerCatalogOpen, setProviderCatalogOpen] = useState(false);
  const [explicitAuthMode, setExplicitAuthMode] = useState<"oauth" | "password" | null>(null);
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
  const gridRef = useRef<HTMLDivElement>(null);
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
  // Matches an already-added local account. Gmail `+tag` sub-addresses are
  // folded onto their canonical address; the matched account is surfaced so
  // the message can say which mailbox was actually found. `accountAdded` is
  // excluded: once the add succeeded, onAdded() refreshes the list and the
  // just-added address would otherwise instantly "already exists" while the
  // success state is shown before the dialog closes.
  const existingAccountMatch = useMemo(() => {
    if (accountAdded || !validEmail(normalizedEmail)) return undefined;
    const needle = canonicalGmailEmail(normalizedEmail);
    return existingAccounts.find((account) => canonicalGmailEmail(account.email) === needle);
  }, [accountAdded, existingAccounts, normalizedEmail]);
  const existingDuplicateMessage = useMemo(() => {
    if (!existingAccountMatch) return "";
    return existingAccountMatch.email.toLowerCase() === normalizedEmail
      ? t("account.error.email_exists")
      : t("account.error.email_exists_plus", { email: existingAccountMatch.email });
  }, [existingAccountMatch, normalizedEmail, t]);
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
  const allProviders = useMemo(() => fullCatalogProviders(providers, locale), [locale, providers]);

  const targetProviderId = guideProvider?.id || activeDiscovery?.id || matchedProvider?.id || selectedProviderId;
  const isGmail = targetProviderId === "gmail" || /@(gmail\.com|googlemail\.com)$/i.test(normalizedEmail);
  const isQQ = targetProviderId === "qq" || /@(qq\.com|vip\.qq\.com|foxmail\.com)$/i.test(normalizedEmail);
  const isNetease = Boolean(targetProviderId?.startsWith("netease")) || /@(163\.com|126\.com|yeah\.net|188\.com)$/i.test(normalizedEmail);
  const isiCloud = targetProviderId === "icloud" || /@(icloud\.com|me\.com|mac\.com)$/i.test(normalizedEmail);
  const isMicrosoft = targetProviderId === "microsoft" || /@(outlook\.com|hotmail\.com|live\.com|msn\.com|office365\.com)$/i.test(normalizedEmail);

  const providerKind: "gmail" | "qq" | "netease" | "icloud" | "microsoft" | "generic" =
    isGmail ? "gmail"
    : isQQ ? "qq"
    : isNetease ? "netease"
    : isiCloud ? "icloud"
    : isMicrosoft ? "microsoft"
    : "generic";

  const credentialDetails = useMemo(() => {
    switch (providerKind) {
      case "gmail":
        return {
          label: t("account.credential.gmail.label"),
          placeholder: t("account.credential.gmail.placeholder"),
          help: t("account.credential.gmail.help"),
          is16CharAppPassword: true,
        };
      case "qq":
        return {
          label: t("account.credential.qq.label"),
          placeholder: t("account.credential.qq.placeholder"),
          help: t("account.credential.qq.help"),
          is16CharAppPassword: true,
        };
      case "netease":
        return {
          label: t("account.credential.netease.label"),
          placeholder: t("account.credential.netease.placeholder"),
          help: t("account.credential.netease.help"),
          is16CharAppPassword: true,
        };
      case "icloud":
        return {
          label: t("account.credential.icloud.label"),
          placeholder: t("account.credential.icloud.placeholder"),
          help: t("account.credential.icloud.help"),
          is16CharAppPassword: true,
        };
      case "microsoft":
        return {
          label: t("account.credential.microsoft.label"),
          placeholder: t("account.credential.microsoft.placeholder"),
          help: t("account.credential.microsoft.help"),
          is16CharAppPassword: false,
        };
      case "generic":
      default:
        return {
          label: activeOnboarding?.credentialLabel ?? t("account.credential.generic.label"),
          placeholder: t("account.credential.generic.placeholder"),
          help: activeOnboarding?.credentialHint ?? t("account.credential.generic.help"),
          is16CharAppPassword: false,
        };
    }
  }, [activeOnboarding?.credentialHint, activeOnboarding?.credentialLabel, providerKind, t]);

  const providerCardInfo = useMemo(() => {
    if (!guideProvider) return null;
    const icon = providerIconUrl(guideProvider.id);
    const monogram = matchedProvider
      ? providerMonogram(matchedProvider)
      : (guideProvider.domain ? guideProvider.domain.slice(0, 2).toUpperCase() : guideProvider.name.slice(0, 2).toUpperCase());
    switch (providerKind) {
      case "gmail":
        return {
          icon,
          monogram,
          name: "Gmail (Google)",
          badge: t("account.provider.badge.appPassword"),
          summary: t("account.actionCard.gmail.summary"),
          actionHref: "https://myaccount.google.com/apppasswords",
          actionLabel: t("account.actionCard.gmail.openAppPasswords"),
          actionTitle: t("account.actionCard.gmail.openAppPasswordsTitle"),
          howToEnable: t("account.actionCard.gmail.howToEnable"),
        };
      case "qq":
        return {
          icon,
          monogram,
          name: "QQ 邮箱 / Foxmail",
          badge: t("account.provider.badge.authCode"),
          summary: t("account.actionCard.qq.summary"),
          actionHref: "https://mail.qq.com",
          actionLabel: t("account.actionCard.qq.openSettings"),
          actionTitle: t("account.actionCard.qq.openSettings"),
          howToEnable: t("account.actionCard.qq.howToEnable"),
        };
      case "netease":
        return {
          icon: icon || providerIconUrl("netease-163"),
          monogram: monogram || "163",
          name: guideProviderName || "网易邮箱",
          badge: t("account.provider.badge.neteaseCode"),
          summary: t("account.actionCard.netease.summary"),
          actionHref: domain.includes("126") ? "https://mail.126.com" : "https://mail.163.com",
          actionLabel: t("account.actionCard.netease.openSettings"),
          actionTitle: t("account.actionCard.netease.openSettings"),
          howToEnable: t("account.actionCard.netease.howToEnable"),
        };
      case "icloud":
        return {
          icon,
          monogram,
          name: "Apple iCloud",
          badge: t("account.provider.badge.applePassword"),
          summary: t("account.actionCard.icloud.summary"),
          actionHref: "https://account.apple.com/account/manage",
          actionLabel: t("account.actionCard.icloud.openSettings"),
          actionTitle: t("account.actionCard.icloud.openSettings"),
          howToEnable: t("account.actionCard.icloud.howToEnable"),
        };
      case "microsoft":
        return {
          icon,
          monogram,
          name: "Microsoft Outlook",
          badge: t("account.provider.badge.oauth"),
          summary: t("account.actionCard.microsoft.summary"),
          actionHref: "https://account.live.com/proofs/manage/additional",
          actionLabel: t("account.actionCard.microsoft.openSettings"),
          actionTitle: t("account.actionCard.microsoft.openSettings"),
          howToEnable: t("account.actionCard.microsoft.howToEnable"),
        };
      case "generic":
      default:
        return {
          icon: guideProvider.isCustom ? undefined : icon,
          monogram: guideProvider.isCustom ? undefined : monogram,
          name: guideProviderName || (domain ? `@${domain}` : t("account.provider.custom_name")),
          badge: t("account.provider.badge.imap"),
          summary: t("account.actionCard.generic.summary"),
          actionHref: guideProvider.helpUrl,
          actionLabel: guideOnboarding?.helpLabel ?? t("account.guide.open_official"),
          actionTitle: guideOnboarding?.helpLabel ?? t("account.guide.open_official"),
          howToEnable: t("account.actionCard.generic.howToEnable"),
        };
    }
  }, [domain, guideOnboarding?.helpLabel, guideProvider, guideProviderName, providerKind, t]);

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
  const passwordLooksLikeAppCredential = !manualOpen
    && authMethods.some((method) => method === "app-password" || method === "client-authorization-code");
  const canUsePassword = !oauthOnly;
  const providerPrefersOAuth = Boolean(
    activeOAuthProvider && oauthAvailable && activeDiscovery?.recommendedAuthMethod !== "app-password" && !isGmail
  );
  const showOAuthPanel = Boolean(
    activeOAuthProvider && !manualOpen && (explicitAuthMode === "oauth" || (explicitAuthMode === null && providerPrefersOAuth))
  );
  const busy = busyAction !== "idle";
  const blockingBusy = busyAction === "password" || busyAction === "manual" || busyAction === "oauth";
  const isOAuthWaiting = busyAction === "oauth" && Boolean(oauthAttemptId);
  const usingPassword = (validEmail(normalizedEmail) || Boolean(selectedProviderId) || Boolean(matchedProvider))
    && !needsProviderDiscovery
    && canUsePassword
    && (manualOpen || !showOAuthPanel);

  const [showPassword, setShowPassword] = useState(false);
  const pendingCursorRef = useRef<number | null>(null);


  useLayoutEffect(() => {
    if (pendingCursorRef.current !== null && emailRef.current) {
      const pos = pendingCursorRef.current;
      pendingCursorRef.current = null;
      emailRef.current.focus();
      emailRef.current.setSelectionRange(pos, pos);
    }
  }, [email]);

  useEffect(() => {
    if (!providerCatalogOpen && gridRef.current) {
      gridRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [providerCatalogOpen]);

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

  const { closing, requestClose: requestExit } = useDismissTransition(() => {
    onClose();
  });

  const requestClose = () => {
    if (!blockingBusy) requestExit();
  };

  const scheduleClose = useCallback(() => {
    if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = window.setTimeout(() => {
      autoCloseTimerRef.current = null;
      requestExit();
    }, demoMode ? 650 : 1_000);
  }, [demoMode, requestExit]);

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
    setExplicitAuthMode(null);
    setTutorialDrawerOpen(false);
    setManualConfig(manualConfigFor(next));
    setPassword("");
    setOauthAttemptId(null);
    setOauthUrl(null);
    activeOAuthAttemptRef.current = null;
    if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    serverConfigurationCopyTimerRef.current = null;
    setServerConfigurationCopied(false);
    setSelectedProviderId((current) => {
      const domain = emailDomain(next);
      if (!domain) {
        return next.trim() === "" ? "" : current;
      }
      const providerForEmail = providers.find((item) =>
        item.domains.some((candidate) => candidate.toLowerCase() === domain)
      );
      if (providerForEmail) return providerForEmail.id;
      return current === CUSTOM_IMAP_PROVIDER_ID ? current : "";
    });
    clearOAuthPolling();
    setBusyAction((current) => current === "discover" ? "idle" : current);
    setStatus((current) => current.kind === "idle" ? current : { kind: "idle", message: "" });
  }, [clearOAuthPolling, providers]);

  const clearEmail = useCallback(() => {
    updateEmailValue("");
    setSelectedProviderId("");
    pendingCursorRef.current = 0;
    window.requestAnimationFrame(() => {
      if (emailRef.current) {
        emailRef.current.focus();
        emailRef.current.setSelectionRange(0, 0);
      }
    });
  }, [updateEmailValue]);

  const selectProvider = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setProviderCatalogOpen(false);
    setManualOpen(false);
    setExplicitAuthMode(null);
    if (serverConfigurationCopyTimerRef.current !== null) window.clearTimeout(serverConfigurationCopyTimerRef.current);
    serverConfigurationCopyTimerRef.current = null;
    setServerConfigurationCopied(false);
    setStatus({ kind: "idle", message: "" });

    const provider = providers.find((item) => item.id === providerId);
    const targetDomain = providerId === CUSTOM_IMAP_PROVIDER_ID ? undefined : provider?.domains[0];
    const { nextEmail, cursorPos } = computeEmailAfterProviderSelect(emailValueRef.current, targetDomain);

    pendingCursorRef.current = cursorPos;
    updateEmailValue(nextEmail);

    window.requestAnimationFrame(() => {
      if (emailRef.current) {
        emailRef.current.focus();
        emailRef.current.setSelectionRange(cursorPos, cursorPos);
      }
    });
  }, [providers, updateEmailValue]);

  const handleEmailKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      const input = event.currentTarget;
      if (input.selectionStart === 0 && input.selectionEnd === 0 && email.startsWith("@")) {
        event.preventDefault();
        clearEmail();
        return;
      }
    }
    if (event.key === "Enter") {
      if (validEmail(normalizedEmail)) {
        if (canUsePassword && passwordRef.current) {
          event.preventDefault();
          passwordRef.current.focus();
        }
      }
    }
  };

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
    } catch {
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
    // The browser's isComposing flag is authoritative. If it reports no active
    // composition but the local guard is still set, a compositionend was missed
    // (e.g. focus left the field mid-composition). Clear the stale guard so
    // normal typing resumes instead of being silently dropped.
    if ((event.nativeEvent as InputEvent).isComposing) return;
    if (emailComposingRef.current) emailComposingRef.current = false;
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
    const discoveryToUse = activeDiscovery ?? selectedProviderGuide;
    if (!discoveryToUse) return;
    setManualConfig(manualConfigFor(normalizedEmail, discoveryToUse));
    setManualOpen((current) => !current);
    setExplicitAuthMode("password");
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
    if (existingAccountMatch) {
      showError(existingDuplicateMessage, "email");
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
    if (existingAccountMatch) {
      showError(existingDuplicateMessage, "email");
      return;
    }
    const rawPassword = password.trim();
    const cleanPassword = credentialDetails.is16CharAppPassword ? rawPassword.replace(/\s+/g, "") : rawPassword;
    if (!cleanPassword) {
      showError(t("account.error.credential_required", { credential: credentialDetails.label }), "password");
      return;
    }
    if (credentialDetails.is16CharAppPassword && cleanPassword.length !== 16) {
      setStatus({ kind: "warning", message: t("account.error.credential_app_password_hint") });
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
      await (manualOpen
        ? api.addManualAccount({
          email: normalizedEmail,
          password: cleanPassword,
          ...(activeDiscovery && activeDiscovery.id !== "custom" ? { providerId: activeDiscovery.id } : {}),
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
        : api.addAccount(normalizedEmail, cleanPassword));
      // The first full mailbox sync already runs in the background: this
      // request returns as soon as the connection is verified, so the dialog
      // closes immediately and the messages appear via the post-add refresh.
      await finishAddedAccount(t("account.status.connected"));
    } catch (error) {
      const issue = presentMailError(error, t);
      // A network, TLS, or protocol problem is not corrected by retyping a
      // password, so keep focus on the status guidance in those cases.
      showError(friendlyError(error, t), issue.kind === "authentication" ? (manualOpen ? "manual" : "password") : undefined);
    } finally {
      if (mountedRef.current) setBusyAction("idle");
    }
  };

  const credentialName = activeOnboarding?.credentialName
    ?? activeOnboarding?.credentialLabel
    ?? t("account.credential.fallback");
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
  const isFlowActive = Boolean(
    (guideAvailable && providerCardInfo) || showOAuthPanel || isOAuthWaiting || usingPassword
  ) && !accountAdded;

  const [, setFlowCloseTick] = useState(0);
  const flowCloseTimerRef = useRef<number | null>(null);

  const lastFlowSnapshotRef = useRef<{
    providerCardInfo: typeof providerCardInfo;
    usingPassword: boolean;
    showOAuthPanel: boolean;
    isOAuthWaiting: boolean;
    credentialDetails: typeof credentialDetails;
    manualOpen: boolean;
  } | null>(null);

  if (isFlowActive) {
    lastFlowSnapshotRef.current = {
      providerCardInfo,
      usingPassword,
      showOAuthPanel,
      isOAuthWaiting,
      credentialDetails,
      manualOpen,
    };
  } else if (accountAdded) {
    lastFlowSnapshotRef.current = null;
  }

  useEffect(() => {
    if (isFlowActive) {
      if (flowCloseTimerRef.current !== null) {
        window.clearTimeout(flowCloseTimerRef.current);
        flowCloseTimerRef.current = null;
      }
    } else if (lastFlowSnapshotRef.current !== null) {
      if (flowCloseTimerRef.current !== null) {
        window.clearTimeout(flowCloseTimerRef.current);
      }
      flowCloseTimerRef.current = window.setTimeout(() => {
        flowCloseTimerRef.current = null;
        lastFlowSnapshotRef.current = null;
        setFlowCloseTick((tick) => tick + 1);
      }, 340);
    }
  }, [isFlowActive]);

  useEffect(() => {
    return () => {
      if (flowCloseTimerRef.current !== null) {
        window.clearTimeout(flowCloseTimerRef.current);
        flowCloseTimerRef.current = null;
      }
    };
  }, []);

  const activeSnapshot = isFlowActive
    ? { providerCardInfo, usingPassword, showOAuthPanel, isOAuthWaiting, credentialDetails, manualOpen }
    : lastFlowSnapshotRef.current;

  const displayProviderCardInfo = isFlowActive ? providerCardInfo : activeSnapshot?.providerCardInfo;
  const displayUsingPassword = isFlowActive ? usingPassword : Boolean(activeSnapshot?.usingPassword);
  const displayShowOAuthPanel = isFlowActive ? showOAuthPanel : Boolean(activeSnapshot?.showOAuthPanel);
  const displayIsOAuthWaiting = isFlowActive ? isOAuthWaiting : Boolean(activeSnapshot?.isOAuthWaiting);
  const displayCredentialDetails = isFlowActive ? credentialDetails : (activeSnapshot?.credentialDetails ?? credentialDetails);
  const displayManualOpen = isFlowActive ? manualOpen : Boolean(activeSnapshot?.manualOpen);
  const hasFlowDetails = isFlowActive || activeSnapshot !== null;

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
    <div className={`modal-backdrop account-modal-backdrop${closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section
        ref={dialogRef}
        className={`modal-card account-modal${tutorialDrawerOpen ? " with-drawer" : ""}${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        aria-describedby="add-account-description"
        tabIndex={-1}
      >
        <div className="modal-heading account-modal-heading">
          <div className="account-modal-title-group">
            <div className="account-modal-title-row">
              <span className="account-modal-brand-badge" aria-hidden="true">
                <Mail size={16} strokeWidth={2} />
              </span>
              <h2 id="add-account-title">{t("account.title")}</h2>
            </div>
            <p id="add-account-description" className="account-modal-subtitle">{t("account.description")}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.close")} data-tooltip={t("common.close")} onClick={requestClose} disabled={blockingBusy}>
            <X size={18} />
          </button>
        </div>

        <div className="account-modal-body">
          <div className="account-modal-main">
            <form
              id="account-form"
              noValidate
              onSubmit={submitPassword}
              className={`account-form${providerCatalogOpen ? " catalog-open" : ""}`}
              aria-busy={busy}
            >
          <section className={`provider-picker${providerCatalogOpen ? " catalog-open" : ""}`} aria-labelledby="provider-picker-title">
            <div className="provider-picker-heading">
              <strong id="provider-picker-title">{providerCatalogOpen ? t("account.provider.all_providers") : t("account.provider.title")}</strong>
              <button
                className="provider-catalog-toggle"
                type="button"
                aria-expanded={providerCatalogOpen}
                onClick={() => setProviderCatalogOpen((value) => !value)}
                disabled={busy || accountAdded}
              >
                <span>{providerCatalogOpen ? t("account.provider.collapse_catalog") : t("account.provider.more")}</span>
                <ChevronDown className={providerCatalogOpen ? "open" : ""} size={14} />
              </button>
            </div>
            <div ref={gridRef} className={`provider-quick-grid${providerCatalogOpen ? " catalog-expanded" : ""}`}>
              {allProviders.map((provider, index) => {
                const isCore = index < 6;
                const iconUrl = providerIconUrl(provider.id);
                const isSelected = selectedProviderId === provider.id;
                return (
                  <button
                    key={provider.id}
                    className={`provider-choice${isCore ? "" : " extra-choice"}${isSelected ? " selected" : ""}`}
                    type="button"
                    tabIndex={isCore || providerCatalogOpen ? 0 : -1}
                    aria-hidden={!isCore && !providerCatalogOpen}
                    aria-pressed={isSelected}
                    aria-label={t("account.provider.select_aria", { provider: providerDisplayName(provider, locale, t) })}
                    onClick={() => selectProvider(provider.id)}
                    disabled={busy || accountAdded}
                  >
                    <span className="provider-choice-mark" aria-hidden="true">
                      {iconUrl ? <img className="provider-choice-icon" src={iconUrl} alt="" loading="lazy" /> : providerMonogram(provider)}
                    </span>
                    <span className="provider-choice-copy">
                      <strong>{providerDisplayName(provider, locale, t)}</strong>
                      <small className="provider-choice-domain">@{provider.domains[0]}</small>
                    </span>
                    {isSelected && (
                      <span className="provider-choice-check" aria-hidden="true">
                        <Check size={11} strokeWidth={2.6} />
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                className={`provider-choice provider-choice-custom extra-choice${selectedProviderId === CUSTOM_IMAP_PROVIDER_ID ? " selected" : ""}`}
                type="button"
                tabIndex={providerCatalogOpen ? 0 : -1}
                aria-hidden={!providerCatalogOpen}
                aria-pressed={selectedProviderId === CUSTOM_IMAP_PROVIDER_ID}
                onClick={() => selectProvider(CUSTOM_IMAP_PROVIDER_ID)}
                disabled={busy || accountAdded}
              >
                <span className="provider-choice-mark" aria-hidden="true"><Mailbox size={15} /></span>
                <span className="provider-choice-copy">
                  <strong>{t("account.provider.custom_name")}</strong>
                  <small>{t("account.provider.custom_description")}</small>
                </span>
                {selectedProviderId === CUSTOM_IMAP_PROVIDER_ID && (
                  <span className="provider-choice-check" aria-hidden="true">
                    <Check size={11} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            </div>
            <small className="provider-picker-note">{t("account.provider.picker_note")}</small>
          </section>

          <div className={`account-form-fields${providerCatalogOpen ? " collapsed" : ""}`} inert={providerCatalogOpen ? true : undefined}>
            <div className="account-form-fields-inner">
              <div className="account-email-row">
            <label htmlFor="account-email">
              <span>{t("account.email.label")}</span>
              <div className="account-email-input-wrapper">
                <input
                  ref={emailRef}
                  id="account-email"
                  type="text"
                  inputMode="email"
                  autoCapitalize="none"
                  data-dialog-initial-focus
                  autoComplete="email"
                  spellCheck={false}
                  placeholder={t("account.email.placeholder")}
                  value={email}
                  onChange={updateEmail}
                  onKeyDown={handleEmailKeyDown}
                  onFocus={() => setEmailFocused(true)}
                  onBlur={() => {
                    // Abandon any in-flight composition when focus leaves the
                    // field. Some IMEs never deliver compositionend after a
                    // blur, which would otherwise block all later typing.
                    emailComposingRef.current = false;
                    setEmailFocused(false);
                  }}
                  onCompositionStart={beginEmailComposition}
                  onCompositionEnd={endEmailComposition}
                  disabled={blockingBusy || accountAdded}
                  required
                  aria-invalid={emailInvalid}
                  aria-describedby={emailInvalid ? "account-form-status" : "account-email-help"}
                />
                {email.length > 0 && !blockingBusy && (
                  <button
                    type="button"
                    className="account-input-clear-btn"
                    aria-label={t("common.clear")}
                    title={t("common.clear")}
                    onClick={clearEmail}
                    tabIndex={-1}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </label>
          </div>
          <small id="account-email-help" className="account-field-help">{t("account.email.help")}</small>

          {existingAccountMatch && (
            <div className="form-status error account-email-exists" role="alert">
              <X size={17} />{existingDuplicateMessage}
            </div>
          )}

          {needsProviderDiscovery && (
            <section className="account-discovery-pending" role="status" aria-live="polite">
              {busyAction === "discover" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              <span>{busyAction === "discover"
                ? t("account.discovery.busy")
                : t("account.discovery.idle")}</span>
            </section>
          )}

          <div
            className={`account-flow-details${isFlowActive ? " open" : ""}`}
            aria-hidden={!isFlowActive}
          >
            <div className="account-flow-details-inner">
              {displayProviderCardInfo && !accountAdded && (
                <section className="account-provider-action-card" aria-label={displayProviderCardInfo.name}>
                  <div className="provider-card-header">
                <div className="provider-card-identity">
                  {displayProviderCardInfo.icon ? (
                    <img className="provider-card-icon" src={displayProviderCardInfo.icon} alt="" loading="lazy" />
                  ) : displayProviderCardInfo.monogram ? (
                    <span className="provider-card-monogram">{displayProviderCardInfo.monogram}</span>
                  ) : (
                    <span className="provider-card-monogram"><Mailbox size={12} /></span>
                  )}
                  <strong className="provider-card-name">{displayProviderCardInfo.name}</strong>
                </div>
                <span className="provider-card-badge">{displayProviderCardInfo.badge}</span>
              </div>

              <p className="provider-card-desc">{displayProviderCardInfo.summary}</p>

              <div className="provider-card-actions">
                {displayProviderCardInfo.actionHref && (
                  <a
                    href={displayProviderCardInfo.actionHref}
                    target="_blank"
                    rel="noreferrer"
                    className="provider-direct-action-btn"
                    title={displayProviderCardInfo.actionTitle}
                  >
                    <ExternalLink size={14} />
                    <span>{displayProviderCardInfo.actionLabel}</span>
                  </a>
                )}
                <button
                  type="button"
                  className={`provider-tutorial-trigger-btn${tutorialDrawerOpen ? " active" : ""}`}
                  onClick={() => setTutorialDrawerOpen((value) => !value)}
                  aria-expanded={tutorialDrawerOpen}
                  disabled={!isFlowActive}
                >
                  <CircleHelp size={14} />
                  <span>{tutorialDrawerOpen ? t("account.actionCard.collapseGuide") : displayProviderCardInfo.howToEnable}</span>
                  <ChevronRight size={13} className={tutorialDrawerOpen ? "open" : ""} />
                </button>
              </div>
            </section>
          )}

          {displayShowOAuthPanel && !accountAdded && (
            <section className="account-oauth-panel" aria-labelledby="oauth-login-title">
              <div>
                <span className="eyebrow">{t("account.oauth.eyebrow")}</span>
                <strong id="oauth-login-title">{t("account.oauth.title", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}</strong>
                <p>{t("account.oauth.description")}</p>
              </div>
              {!oauthAvailable && <small className="oauth-config-note">{t("account.oauth.config_unavailable", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}</small>}
              <button className="primary-button large oauth-button" type="button" onClick={() => void startOAuth()} disabled={busy || !oauthAvailable || Boolean(existingAccountMatch) || !isFlowActive}>
                {busyAction === "oauth" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
                {busyAction === "oauth"
                  ? t("account.oauth.waiting_browser")
                  : oauthAvailable
                    ? t("account.oauth.sign_in", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })
                    : t("account.oauth.unavailable")}
              </button>
              {canUsePassword && (
                <button className="account-link-button" type="button" onClick={() => setExplicitAuthMode("password")} disabled={busy || !isFlowActive}>
                  {activeDiscovery?.recommendedAuthMethod === "app-password"
                    ? t("account.oauth.switch_to_password")
                    : t("account.oauth.use_password_fallback", { credential: passwordFallbackName })}
                </button>
              )}
            </section>
          )}

          {displayIsOAuthWaiting && (
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

          {displayUsingPassword && !accountAdded && (
            <>
              <label htmlFor="account-password">
                <span className="credential-label">{displayCredentialDetails.label}<em>{t("account.credential.no_one_time_code")}</em></span>
                <div className="account-password-field-wrapper">
                  <input
                    ref={passwordRef}
                    id="account-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={displayCredentialDetails.placeholder}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy || !isFlowActive}
                    required={isFlowActive}
                    aria-invalid={passwordInvalid}
                    aria-describedby={passwordInvalid ? "account-form-status" : "account-credential-help"}
                  />
                  <button
                    type="button"
                    className="account-password-toggle-btn"
                    aria-label={showPassword ? t("account.password.hide") : t("account.password.show")}
                    title={showPassword ? t("account.password.hide") : t("account.password.show")}
                    onClick={() => setShowPassword((value) => !value)}
                    tabIndex={-1}
                    disabled={!isFlowActive}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
              <small id="account-credential-help" className="account-field-help">{displayCredentialDetails.help}</small>

              {activeOAuthProvider && !displayManualOpen && (
                <button className="account-link-button" type="button" onClick={() => setExplicitAuthMode("oauth")} disabled={busy || !isFlowActive}>
                  {t("account.oauth.switch_to_oauth", { provider: activeOAuthProvider === "google" ? "Google" : "Microsoft" })}
                </button>
              )}

              <button className="account-link-button manual-config-toggle" type="button" onClick={openManualConfig} disabled={busy || !isFlowActive} aria-expanded={displayManualOpen}>
                {displayManualOpen ? t("account.manual.collapse") : t("account.manual.open")}
              </button>

              {displayManualOpen && (
                <fieldset className="manual-server-config" disabled={busy || !isFlowActive}>
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
                              disabled={busy || !isFlowActive}
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
                              disabled={busy || !isFlowActive}
                            />
                          </label>
                          <label htmlFor={`manual-${server}-transport`}>
                            <span>{t("account.manual.encryption")}</span>
                            <ThemedSelect id={`manual-${server}-transport`} value={config.transport} onValueChange={(value) => updateManualServer(server, "transport", value)} aria-invalid={manualInvalid} disabled={busy || !isFlowActive}>
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
                              disabled={busy || !isFlowActive}
                            />
                          </label>
                        </div>
                        <small className="manual-transport-note">{t("account.manual.transport_note", { transport: serverModeLabel(config.transport) })}</small>
                      </section>
                    );
                  })}
                </fieldset>
              )}

            </>
          )}
            </div>
          </div>

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
            </div>
          </div>
        </form>
          </div>

          <div className="account-modal-divider" aria-hidden="true" />
          <div className="account-modal-drawer-wrapper" aria-hidden={!tutorialDrawerOpen}>
            {guideProvider && (
              <aside className="account-modal-drawer" aria-label={t("account.drawer.title", { provider: guideProviderName })}>
                <div className="drawer-header">
                  <strong>
                    {providerKind === "gmail"
                      ? t("account.drawer.gmail.title")
                      : providerKind === "qq"
                        ? t("account.drawer.qq.title")
                        : providerKind === "netease"
                          ? t("account.drawer.netease.title")
                          : providerKind === "icloud"
                            ? t("account.drawer.icloud.title")
                            : providerKind === "microsoft"
                              ? t("account.drawer.microsoft.title")
                              : t("account.drawer.generic.title")}
                  </strong>
                  <button
                    className="drawer-collapse-btn"
                    type="button"
                    onClick={() => setTutorialDrawerOpen(false)}
                    title={t("account.drawer.collapse")}
                  >
                    <X size={14} />
                    <span>{t("account.drawer.collapse")}</span>
                  </button>
                </div>

                {providerKind === "gmail" ? (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge warn">{t("account.drawer.gmail.prereqBadge")}</span>
                        <strong>{t("account.drawer.gmail.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.gmail.prereqDesc")}</p>
                      <a
                        href="https://myaccount.google.com/security"
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.drawer.gmail.prereqAction")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.gmail.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.gmail.step1Desc")}</p>
                      <a
                        href="https://myaccount.google.com/apppasswords"
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link primary"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.drawer.gmail.step1Action")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.gmail.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.gmail.step2Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.gmail.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.gmail.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.gmail.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.gmail.step4Desc")}</p>
                    </div>

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.gmail.faq1Q")}</summary>
                        <p>{t("account.drawer.gmail.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.gmail.faq2Q")}</summary>
                        <p>{t("account.drawer.gmail.faq2A")}</p>
                      </details>
                    </div>
                  </>
                ) : providerKind === "qq" ? (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge warn">{t("account.drawer.qq.prereqBadge")}</span>
                        <strong>{t("account.drawer.qq.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.qq.prereqDesc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.qq.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.qq.step1Desc")}</p>
                      <a
                        href="https://mail.qq.com"
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.actionCard.qq.openSettings")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.qq.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.qq.step2Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.qq.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.qq.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.qq.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.qq.step4Desc")}</p>
                    </div>

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.qq.faq1Q")}</summary>
                        <p>{t("account.drawer.qq.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.qq.faq2Q")}</summary>
                        <p>{t("account.drawer.qq.faq2A")}</p>
                      </details>
                    </div>
                  </>
                ) : providerKind === "netease" ? (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge warn">{t("account.drawer.netease.prereqBadge")}</span>
                        <strong>{t("account.drawer.netease.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.netease.prereqDesc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.netease.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.netease.step1Desc")}</p>
                      <a
                        href={domain.includes("126") ? "https://mail.126.com" : "https://mail.163.com"}
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.actionCard.netease.openSettings")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.netease.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.netease.step2Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.netease.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.netease.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.netease.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.netease.step4Desc")}</p>
                    </div>

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.netease.faq1Q")}</summary>
                        <p>{t("account.drawer.netease.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.netease.faq2Q")}</summary>
                        <p>{t("account.drawer.netease.faq2A")}</p>
                      </details>
                    </div>
                  </>
                ) : providerKind === "icloud" ? (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge warn">{t("account.drawer.icloud.prereqBadge")}</span>
                        <strong>{t("account.drawer.icloud.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.icloud.prereqDesc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.icloud.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.icloud.step1Desc")}</p>
                      <a
                        href="https://account.apple.com/account/manage"
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.actionCard.icloud.openSettings")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.icloud.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.icloud.step2Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.icloud.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.icloud.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.icloud.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.icloud.step4Desc")}</p>
                    </div>

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.icloud.faq1Q")}</summary>
                        <p>{t("account.drawer.icloud.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.icloud.faq2Q")}</summary>
                        <p>{t("account.drawer.icloud.faq2A")}</p>
                      </details>
                    </div>
                  </>
                ) : providerKind === "microsoft" ? (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge warn">{t("account.drawer.microsoft.prereqBadge")}</span>
                        <strong>{t("account.drawer.microsoft.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.microsoft.prereqDesc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.microsoft.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.microsoft.step1Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.microsoft.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.microsoft.step2Desc")}</p>
                      <a
                        href="https://account.live.com/proofs/manage/additional"
                        target="_blank"
                        rel="noreferrer"
                        className="drawer-action-link"
                      >
                        <ExternalLink size={13} />
                        <span>{t("account.actionCard.microsoft.openSettings")}</span>
                      </a>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.microsoft.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.microsoft.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.microsoft.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.microsoft.step4Desc")}</p>
                    </div>

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.microsoft.faq1Q")}</summary>
                        <p>{t("account.drawer.microsoft.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.microsoft.faq2Q")}</summary>
                        <p>{t("account.drawer.microsoft.faq2A")}</p>
                      </details>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="drawer-step-card prereq-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">{t("account.drawer.generic.prereqBadge")}</span>
                        <strong>{t("account.drawer.generic.prereqTitle")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.generic.prereqDesc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">01</span>
                        <strong>{t("account.drawer.generic.step1Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.generic.step1Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">02</span>
                        <strong>{t("account.drawer.generic.step2Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.generic.step2Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">03</span>
                        <strong>{t("account.drawer.generic.step3Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.generic.step3Desc")}</p>
                    </div>

                    <div className="drawer-step-card">
                      <div className="drawer-step-header">
                        <span className="drawer-step-badge">04</span>
                        <strong>{t("account.drawer.generic.step4Title")}</strong>
                      </div>
                      <p className="drawer-step-desc">{t("account.drawer.generic.step4Desc")}</p>
                    </div>

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

                    <div className="drawer-faq-section">
                      <strong>{t("account.drawer.faqTitle")}</strong>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.generic.faq1Q")}</summary>
                        <p>{t("account.drawer.generic.faq1A")}</p>
                      </details>
                      <details className="drawer-faq-item">
                        <summary>{t("account.drawer.generic.faq2Q")}</summary>
                        <p>{t("account.drawer.generic.faq2A")}</p>
                      </details>
                    </div>
                  </>
                )}
              </aside>
            )}
          </div>
        </div>
        <footer className="account-modal-footer">
          {accountAdded ? (
            <button className="primary-button large modal-submit-btn" type="button" onClick={onClose}>
              {t("account.done")}
            </button>
          ) : !showOAuthPanel ? (
            <button
              form="account-form"
              className="primary-button large modal-submit-btn"
              type="submit"
              disabled={busy || !password || Boolean(existingAccountMatch) || !usingPassword}
            >
              {busyAction === "password" || busyAction === "manual" ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
              {busyAction === "password" || busyAction === "manual"
                ? t("account.manual.validating")
                : manualOpen
                  ? t("account.manual.validate_and_add")
                  : t("account.manual.verify_and_add")}
            </button>
          ) : null}
          <div className="account-modal-footer-privacy">
            <ShieldCheck size={13} className="account-modal-footer-icon" aria-hidden="true" />
            <p className="privacy-note">{t("account.privacy_note")}</p>
          </div>
        </footer>
      </section>
    </div>
  );
}
