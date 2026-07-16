import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  Menu,
  Moon,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { demoAccounts, demoMessages, demoProviders, demoStats } from "./demo";
import type { Account, Message, ProviderInfo, Stats } from "./types";

type MailView = "inbox" | "unread" | "starred";

const isDemo = new URLSearchParams(window.location.search).get("demo") === "1";

function formatMessageTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("zh-CN", sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function initials(name: string, address: string): string {
  const value = name.trim() || address.split("@")[0] || "?";
  return [...value].slice(0, 2).join("").toUpperCase();
}

function accountTone(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("nami-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("nami-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#09090a" : "#f2f2f4");
  }, [theme]);
  return { theme, toggle: () => setTheme((value) => (value === "light" ? "dark" : "light")) };
}

function IconButton({ label, children, onClick, className = "", disabled = false }: { label: string; children: React.ReactNode; onClick?: () => void; className?: string; disabled?: boolean }) {
  return (
    <button className={`icon-button ${className}`} type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function colorLuminance(value: string | null): number | null {
  if (!value) return null;
  const color = value.trim().toLowerCase();
  if (!color || color === "transparent" || color === "inherit" || color === "initial") return null;
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
  };
  let rgb = named[color];
  const hex = color.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (!rgb && hex) {
    const expanded = hex.length === 3 || hex.length === 4
      ? hex.slice(0, 3).split("").map((part) => `${part}${part}`).join("")
      : hex.slice(0, 6);
    rgb = [Number.parseInt(expanded.slice(0, 2), 16), Number.parseInt(expanded.slice(2, 4), 16), Number.parseInt(expanded.slice(4, 6), 16)];
  }
  if (!rgb) {
    const channels = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i);
    if (channels) rgb = [Number(channels[1]), Number(channels[2]), Number(channels[3])];
  }
  if (!rgb) return null;
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function sanitizeMailHtml(html: string, darkMode: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "img", "form"],
  });
  if (!darkMode) return clean;

  const template = document.createElement("template");
  template.innerHTML = clean;
  const hasLightBackground = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      const styled = current as HTMLElement;
      const background = styled.style?.backgroundColor || current.getAttribute("bgcolor");
      const luminance = colorLuminance(background);
      if (luminance !== null) return luminance > 0.62;
      current = current.parentElement;
    }
    return false;
  };

  for (const element of template.content.querySelectorAll("*")) {
    const styled = element as HTMLElement;
    const foreground = styled.style?.color || element.getAttribute("color");
    const luminance = colorLuminance(foreground);
    if (luminance !== null && luminance < 0.35 && !hasLightBackground(element)) {
      styled.style?.removeProperty("color");
      element.removeAttribute("color");
    }
  }
  return template.innerHTML;
}

function AddAccountModal({ providers, onClose, onAdded }: { providers: ProviderInfo[]; onClose: () => void; onAdded: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error" | "idle"; message: string }>({ kind: "idle", message: "" });
  const domain = email.toLowerCase().split("@")[1] ?? "";
  const provider = providers.find((item) => item.domains.includes(domain));
  const guideKey = provider?.id ?? (domain.includes(".") ? "custom" : "");
  const credentialName = provider?.credentialName ?? "邮箱密码或客户端授权码";
  const setupSteps = provider?.setupSteps ?? [
    "登录邮箱服务商网页，确认已经开启 IMAP 与 SMTP。",
    "如果账户启用了两步验证，请生成应用专用密码或客户端授权码。",
    "把生成的专用凭据粘贴到密码框，不要填写短信或验证器的一次性验证码。",
  ];

  useEffect(() => {
    setShowGuide(Boolean(guideKey));
  }, [guideKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus({ kind: "idle", message: "" });
    try {
      if (isDemo) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      } else {
        const result = await api.addAccount(email, password);
        const detail = result.sync ? `，已同步 ${result.sync.synced} 封邮件 / ${result.sync.folders} 个文件夹` : "";
        setStatus(result.syncWarning
          ? { kind: "error", message: `邮箱已添加，但首次同步失败：${result.syncWarning}。稍后可点击同步重试。` }
          : { kind: "success", message: `连接成功${detail}。` });
      }
      setPassword("");
      if (isDemo) setStatus({ kind: "success", message: "连接成功，已同步最近邮件。" });
      await onAdded();
      window.setTimeout(onClose, isDemo ? 650 : 1000);
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "无法添加邮箱。" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card account-modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW ACCOUNT</span>
            <h2 id="add-account-title">添加邮箱</h2>
          </div>
          <IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton>
        </div>

        <div className="provider-orbit" aria-hidden="true">
          <div className="provider-core"><Mail size={26} strokeWidth={1.7} /></div>
          <span className="orbit-chip chip-a">G</span>
          <span className="orbit-chip chip-b">iC</span>
          <span className="orbit-chip chip-c">Q</span>
          <span className="orbit-chip chip-d">163</span>
        </div>

        <p className="modal-intro">只需邮箱和授权凭据。服务器地址、端口与加密方式会在本机自动识别。</p>

        <form onSubmit={submit} className="account-form">
          <label>
            <span>邮箱地址</span>
            <input type="email" autoFocus autoComplete="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            <span className="credential-label">密码 / 授权码 <em>{provider ? `请填：${credentialName}` : ""}</em></span>
            <input type="password" autoComplete="new-password" placeholder={provider ? `粘贴${credentialName}` : "仅加密保存在本机"} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>

          <div className={`provider-hint ${provider?.basicAuthLimited ? "warning" : ""}`}>
            <ShieldCheck size={17} />
            <div>
              <strong>{provider ? `${provider.name} 已识别` : domain ? "标准 IMAP 邮箱" : "凭据不会离开你的设备"}</strong>
              <span>{provider?.credentialHint ?? "Gmail/iCloud 使用应用专用密码，QQ/163 使用客户端授权码。"}</span>
            </div>
          </div>

          <button className="guide-toggle" type="button" aria-expanded={showGuide} onClick={() => setShowGuide((value) => !value)}>
            <KeyRound size={15} />
            <span>{provider ? `如何获取${credentialName}` : "如何通过两步验证"}</span>
            <ChevronDown className={showGuide ? "open" : ""} size={15} />
          </button>

          {showGuide && (
            <section className={`setup-guide ${provider?.basicAuthLimited ? "warning" : ""}`} aria-label="授权凭据获取步骤">
              <div className="setup-guide-title">
                <div>
                  <span>SETUP GUIDE</span>
                  <strong>{provider ? provider.name : "标准 IMAP 邮箱"}</strong>
                </div>
                <ShieldCheck size={17} />
              </div>
              <ol>
                {setupSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              {provider?.helpUrl && (
                <a href={provider.helpUrl} target="_blank" rel="noreferrer">
                  {provider.helpLabel ?? "打开服务商官方设置"}
                  <ExternalLink size={13} />
                </a>
              )}
              <p><strong>注意：</strong>这里不填写短信、邮箱或验证器中的 6 位一次性验证码。</p>
            </section>
          )}

          {status.kind !== "idle" && <div className={`form-status ${status.kind}`}>{status.kind === "success" ? <Check size={17} /> : <X size={17} />}{status.message}</div>}

          <button className="primary-button large" type="submit" disabled={busy || !email || !password}>
            {busy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
            {busy ? "正在安全连接…" : "验证并添加"}
          </button>
        </form>
        <p className="privacy-note">AES‑256‑GCM 加密 · TLS 强制验证 · 仅监听 127.0.0.1</p>
      </section>
    </div>
  );
}

function ComposeModal({ accounts, onClose, onSent }: { accounts: Account[]; onClose: () => void; onSent: (message: string) => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!isDemo) {
        await api.send({
          accountId,
          to: to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean),
          subject,
          text,
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      onSent("邮件已安全发送");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败。" );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop compose-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="compose-card" role="dialog" aria-modal="true" aria-labelledby="compose-title">
        <header className="compose-header">
          <div><span className="eyebrow">NEW MESSAGE</span><h2 id="compose-title">新邮件</h2></div>
          <IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form onSubmit={submit}>
          <div className="compose-row"><span>发件人</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></div>
          <div className="compose-row"><span>收件人</span><input type="text" value={to} onChange={(event) => setTo(event.target.value)} placeholder="email@example.com" required /></div>
          <div className="compose-row"><span>主题</span><input type="text" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="简洁的主题" /></div>
          <textarea className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder="开始写邮件…" required />
          {error && <div className="form-status error"><X size={17} />{error}</div>}
          <footer className="compose-footer">
            <IconButton label="添加附件" disabled><Paperclip size={18} /></IconButton>
            <button className="primary-button" type="submit" disabled={busy || !accountId || !to || !text}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{busy ? "发送中…" : "发送"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [stats, setStats] = useState<Stats>({ accounts: 0, messages: 0, unread: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<MailView>("inbox");
  const [selectedAccount, setSelectedAccount] = useState("all");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [toast, setToast] = useState("");
  const [fatalError, setFatalError] = useState("");

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true);
      setFatalError("");
      if (isDemo) {
        setAccounts(demoAccounts);
        setProviders(demoProviders);
        setMessages(demoMessages);
        setMessageTotal(demoMessages.length);
        setMessagePage(1);
        setStats(demoStats);
        setSelectedId((current) => current ?? demoMessages[0]?.id ?? null);
      } else {
        const messageQuery = new URLSearchParams({ pageSize: "100" });
        if (selectedAccount !== "all") messageQuery.set("accountId", selectedAccount);
        if (selectedFolder) messageQuery.set("folder", selectedFolder);
        if (debouncedQuery.trim()) messageQuery.set("q", debouncedQuery.trim());
        const [nextAccounts, nextProviders, messagePage, nextStats] = await Promise.all([
          api.accounts(),
          api.providers(),
          api.messages(messageQuery.toString()),
          api.stats(),
        ]);
        setAccounts(nextAccounts);
        setProviders(nextProviders);
        setMessages(messagePage.items);
        setMessageTotal(messagePage.total);
        setMessagePage(messagePage.page);
        setStats(nextStats);
        setSelectedId((current) => current && messagePage.items.some((item) => item.id === current) ? current : messagePage.items[0]?.id ?? null);
      }
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : "无法连接本地服务。" );
    } finally {
      setLoading(false);
    }
  }, [selectedAccount, selectedFolder, debouncedQuery]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (isDemo) return;
    const timer = window.setInterval(() => void load({ silent: true }), 180_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredMessages = useMemo(() => messages.filter((message) => {
    if (selectedAccount !== "all" && message.accountId !== selectedAccount) return false;
    if (selectedFolder && message.mailbox !== selectedFolder) return false;
    if (view === "unread" && message.seen) return false;
    if (view === "starred" && !message.flagged) return false;
    if (query.trim()) {
      const haystack = `${message.subject} ${message.from.name} ${message.from.address} ${message.snippet}`.toLowerCase();
      if (!haystack.includes(query.trim().toLowerCase())) return false;
    }
    return true;
  }), [messages, selectedAccount, selectedFolder, view, query]);

  const loadMore = async () => {
    if (loading || messages.length >= messageTotal) return;
    try {
      const nextQuery = new URLSearchParams({ pageSize: "100", page: String(messagePage + 1) });
      if (selectedAccount !== "all") nextQuery.set("accountId", selectedAccount);
      if (selectedFolder) nextQuery.set("folder", selectedFolder);
      if (debouncedQuery.trim()) nextQuery.set("q", debouncedQuery.trim());
      const nextPage = await api.messages(nextQuery.toString());
      setMessages((items) => [...items, ...nextPage.items]);
      setMessagePage(nextPage.page);
      setMessageTotal(nextPage.total);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "加载更多邮件失败");
    }
  };

  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const selectedAccountRecord = accounts.find((account) => account.id === selectedAccount);
  const sentFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Sent");
  const draftsFolder = selectedAccountRecord?.folders.find((folder) => folder.specialUse === "\\Drafts");
  const selectedFolderRecord = selectedAccountRecord?.folders.find((folder) => folder.path === selectedFolder);
  const safeHtml = useMemo(
    () => selected?.htmlBody ? sanitizeMailHtml(selected.htmlBody, theme === "dark") : "",
    [selected?.htmlBody, theme],
  );

  const openMessage = async (message: Message) => {
    setSelectedId(message.id);
    if (!message.seen) {
      setMessages((items) => items.map((item) => item.id === message.id ? { ...item, seen: true, flags: [...item.flags, "\\Seen"] } : item));
      setStats((value) => ({ ...value, unread: Math.max(0, value.unread - 1) }));
      if (!isDemo) void api.markSeen(message.id, true).catch(() => undefined);
    }
  };

  const sync = async () => {
    if (!accounts.length || syncing) return;
    setSyncing(true);
    try {
      if (!isDemo) {
        const targets = selectedAccount === "all" ? accounts : accounts.filter((account) => account.id === selectedAccount);
        const results = await Promise.all(targets.map((account) => api.sync(account.id)));
        await load({ silent: true });
        const synced = results.reduce((sum, result) => sum + result.synced, 0);
        const folders = results.reduce((sum, result) => sum + result.folders, 0);
        const failedFolders = results.reduce((sum, result) => sum + result.failedFolders, 0);
        setToast(failedFolders ? `已同步 ${synced} 封邮件，${failedFolders} 个文件夹失败` : `已同步 ${synced} 封邮件 · ${folders} 个文件夹`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 700));
        setToast("本地演示数据已刷新");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const chooseView = (next: MailView) => {
    setView(next);
    setSelectedFolder("");
    setMobileSidebar(false);
  };

  const chooseFolder = (path: string) => {
    setSelectedFolder(path);
    setView("inbox");
    setMobileSidebar(false);
  };

  return (
    <div className="app-frame">
      <div className="window-bar">
        <div className="traffic-lights" aria-hidden="true"><span /><span /><span /></div>
        <span className="window-title">Nami Mail</span>
        <div className="window-actions"><span className="local-pill"><span /> LOCAL</span><IconButton label={theme === "light" ? "切换深色" : "切换浅色"} onClick={toggle}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton></div>
      </div>

      <main className="mail-shell">
        <aside className={`sidebar ${mobileSidebar ? "open" : ""}`}>
          <div className="brand-row">
            <div className="brand-mark"><span>N</span></div>
            <div><strong>Nami</strong><span>你的本地邮件空间</span></div>
            <IconButton label="关闭菜单" className="mobile-only" onClick={() => setMobileSidebar(false)}><X size={18} /></IconButton>
          </div>

          <button className="compose-button" type="button" onClick={() => accounts.length ? setComposeOpen(true) : setAddOpen(true)}><PenLine size={18} />写邮件<span>⌘ N</span></button>

          <nav className="nav-section" aria-label="邮箱视图">
            <button className={view === "inbox" && !selectedFolder ? "active" : ""} onClick={() => chooseView("inbox")}><Inbox size={18} /><span>统一收件箱</span><em>{stats.unread || ""}</em></button>
            <button className={view === "unread" ? "active" : ""} onClick={() => chooseView("unread")}><Mail size={18} /><span>未读</span><em>{stats.unread || ""}</em></button>
            <button className={view === "starred" ? "active" : ""} onClick={() => chooseView("starred")}><Star size={18} /><span>已标星</span></button>
            <button className={selectedFolder === draftsFolder?.path ? "active" : ""} disabled={!draftsFolder} onClick={() => draftsFolder && chooseFolder(draftsFolder.path)}><FileText size={18} /><span>草稿</span></button>
            <button className={selectedFolder === sentFolder?.path ? "active" : ""} disabled={!sentFolder} onClick={() => sentFolder && chooseFolder(sentFolder.path)}><Send size={18} /><span>已发送</span></button>
          </nav>

          <div className="accounts-heading"><span>邮箱账户</span><IconButton label="添加邮箱" onClick={() => setAddOpen(true)}><Plus size={16} /></IconButton></div>
          <div className="account-list">
            <button className={selectedAccount === "all" ? "active" : ""} onClick={() => { setSelectedAccount("all"); setSelectedFolder(""); }}><span className="account-avatar all"><Sparkles size={14} /></span><span className="account-copy"><strong>所有邮箱</strong><small>{accounts.length} 个账户</small></span></button>
            {accounts.map((account) => (
              <button key={account.id} className={selectedAccount === account.id ? "active" : ""} onClick={() => { setSelectedAccount(account.id); setSelectedFolder(""); }}>
                <span className={`account-avatar tone-${accountTone(account.email)}`}>{account.email[0]?.toUpperCase()}</span>
                <span className="account-copy"><strong>{account.email.split("@")[0]}</strong><small>{account.providerName}</small></span>
                <span className={`status-dot ${account.status}`} title={account.lastError ?? account.status} />
              </button>
            ))}
          </div>

          {selectedAccountRecord && selectedAccountRecord.folders.length > 0 && (
            <div className="folder-list">
              <span className="folder-title">文件夹</span>
              {selectedAccountRecord.folders.map((folder) => (
                <button key={folder.path} className={selectedFolder === folder.path ? "active" : ""} onClick={() => chooseFolder(folder.path)}><Archive size={15} /><span>{folder.name}</span><em>{folder.unseen || ""}</em></button>
              ))}
            </div>
          )}

          <div className="sidebar-footer">
            <div><ShieldCheck size={16} /><span><strong>本地加密</strong><small>凭据不会上传</small></span></div>
            <span className="version">v0.1</span>
          </div>
        </aside>

        <section className="message-column">
          <header className="column-header">
            <IconButton label="打开菜单" className="mobile-only" onClick={() => setMobileSidebar(true)}><Menu size={19} /></IconButton>
            <div><span className="eyebrow">{selectedAccount === "all" ? "UNIFIED" : selectedAccountRecord?.providerName.toUpperCase()}</span><h1>{view === "unread" ? "未读邮件" : view === "starred" ? "已标星" : selectedFolderRecord?.name || "收件箱"}</h1></div>
            <div className="header-actions"><span className="message-count">{filteredMessages.length}</span><IconButton label="同步邮件" onClick={() => void sync()} disabled={syncing || !accounts.length}><RefreshCw className={syncing ? "spin" : ""} size={17} /></IconButton></div>
          </header>

          <div className="search-wrap"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索发件人、主题或正文" /><span>⌘ K</span></div>

          <div className="list-toolbar"><button className="filter-button">最新优先 <ChevronDown size={14} /></button><span>{query ? `“${query}” 的结果` : "最近同步"}</span></div>

          <div className="message-list">
            {loading && <div className="center-state"><LoaderCircle className="spin" size={24} /><p>正在打开你的邮箱…</p></div>}
            {!loading && fatalError && <div className="center-state error-state"><X size={24} /><h3>本地服务未连接</h3><p>{fatalError}</p><button className="secondary-button" onClick={() => void load()}>重新连接</button></div>}
            {!loading && !fatalError && !accounts.length && (
              <div className="center-state empty-state"><div className="empty-orb"><Mail size={28} /></div><h3>让邮件回到本地</h3><p>连接第一个邮箱。只需要邮箱地址与应用密码或授权码。</p><button className="primary-button" onClick={() => setAddOpen(true)}><Plus size={17} />添加邮箱</button></div>
            )}
            {!loading && accounts.length > 0 && filteredMessages.length === 0 && <div className="center-state"><Search size={24} /><h3>这里很安静</h3><p>没有符合当前条件的邮件。</p></div>}
            {filteredMessages.map((message) => (
              <button key={message.id} className={`message-item ${selectedId === message.id ? "selected" : ""} ${message.seen ? "" : "unread"}`} onClick={() => void openMessage(message)}>
                <span className={`sender-avatar tone-${accountTone(message.from.address)}`}>{initials(message.from.name, message.from.address)}</span>
                <span className="message-copy">
                  <span className="message-meta"><strong>{message.from.name || message.from.address}</strong><time>{formatMessageTime(message.sentAt)}</time></span>
                  <span className="message-subject">{message.subject}</span>
                  <span className="message-snippet">{message.snippet}</span>
                  <span className="message-tags"><i>{message.accountEmail.split("@")[0]}</i>{message.hasAttachments && <Paperclip size={13} />}{message.flagged && <Star size={13} fill="currentColor" />}</span>
                </span>
                {!message.seen && <span className="unread-dot" />}
              </button>
            ))}
            {!loading && !fatalError && filteredMessages.length > 0 && messages.length < messageTotal && query === debouncedQuery && (
              <div className="list-footer">
                <button className="secondary-button" type="button" onClick={() => void loadMore()} disabled={loading}>
                  加载更多 <span>{messages.length} / {messageTotal}</span>
                </button>
              </div>
            )}
          </div>
        </section>

        <section className={`reader-column ${selected ? "has-message" : ""}`}>
          {selected ? (
            <>
              <header className="reader-toolbar">
                <IconButton label="返回邮件列表" className="reader-back" onClick={() => setSelectedId(null)}><ArrowLeft size={18} /></IconButton>
                <div className="reader-actions"><IconButton label="归档"><Archive size={18} /></IconButton><IconButton label="删除"><Trash2 size={18} /></IconButton><span className="toolbar-divider" /><IconButton label="更多"><MoreHorizontal size={19} /></IconButton></div>
              </header>
              <article className="mail-reader">
                <header className="mail-title"><span className="account-badge">{selected.providerName}</span><h2>{selected.subject}</h2><div className="mail-people"><span className={`sender-avatar large tone-${accountTone(selected.from.address)}`}>{initials(selected.from.name, selected.from.address)}</span><div><strong>{selected.from.name || selected.from.address}</strong><button title={selected.from.address}>发给我 <ChevronDown size={13} /></button></div><time>{formatFullDate(selected.sentAt)}</time></div></header>
                <div className="mail-content">
                  {selected.htmlBody ? <div className="mail-html" dangerouslySetInnerHTML={{ __html: safeHtml }} /> : <div className="mail-text">{selected.textBody || selected.snippet}</div>}
                  {selected.hasAttachments && <div className="attachment-strip"><div><Paperclip size={18} /><span><strong>邮件包含附件</strong><small>附件内容按需从服务器读取</small></span></div><button className="secondary-button" disabled>即将支持</button></div>}
                </div>
                <footer className="quick-reply"><span className={`sender-avatar small tone-${accountTone(selected.accountEmail)}`}>{selected.accountEmail[0]?.toUpperCase()}</span><button onClick={() => setComposeOpen(true)}>回复 {selected.from.name || selected.from.address}…</button><IconButton label="回复选项"><ChevronDown size={16} /></IconButton></footer>
              </article>
            </>
          ) : (
            <div className="reader-empty"><div className="reader-orb"><Mail size={32} /></div><h2>选择一封邮件</h2><p>内容只在需要时呈现。远程图片默认被阻止，以避免追踪。</p><div className="shortcut-grid"><span><kbd>J</kbd><small>下一封</small></span><span><kbd>K</kbd><small>上一封</small></span><span><kbd>R</kbd><small>回复</small></span></div></div>
          )}
        </section>
      </main>

      {addOpen && <AddAccountModal providers={providers} onClose={() => setAddOpen(false)} onAdded={load} />}
      {composeOpen && <ComposeModal accounts={accounts} onClose={() => setComposeOpen(false)} onSent={setToast} />}
      {mobileSidebar && <button className="mobile-scrim" aria-label="关闭菜单" onClick={() => setMobileSidebar(false)} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}
