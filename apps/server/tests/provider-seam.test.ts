/**
 * 批次 1 闸门 · Provider 接缝的行为证据（架构契约 §4.4 / §8 G1）。
 *
 * 这一批是"纯新增接口、默认实现不变"，所以本文件要同时钉住两件**相反**的事：
 *
 *   ① 注入 fake 之后，`mail.ts` 的**真实**代码路径确实走 fake，且不再构造任何库对象
 *      （`ImapFlow` / `createTransport` 零调用）。没有这一半，"接缝"只是装饰。
 *   ② 不注入时，两个真实实现交给库的**线上参数**与批次 1 之前逐字相同——
 *      含强制 STARTTLS、证书校验、三档超时、以及 ImapFlow 的 error 监听。
 *      这是接缝最容易悄悄改坏的地方，也是本批唯一可能造成真实事故的方向。
 *
 * 断言用 `toStrictEqual` 而不是 `toEqual`：spec 里**多出**一个值为 undefined 的键
 * （例如无条件展开 socketTimeout）也会被抓住，而 `toEqual` 会放过它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ImapFlow, createTransport } = vi.hoisted(() => ({
  ImapFlow: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("imapflow", () => ({ ImapFlow }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { encryptAccountPassword } from "../src/account-credentials.js";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  activeProviderFactory,
  connectionOptions,
  defaultProviderFactory,
  resetProviderFactory,
  setProviderFactory,
  type ImapConnectionSpec,
  type ImapSession,
  type ProviderFactory,
  type SmtpConnectionSpec,
  type SmtpTransport,
} from "../src/provider/index.js";
import { providerPresets, type DetectedProvider } from "../src/providers.js";
import { createImapClient, imapClientForAccount, sendMail, testAccountConnection } from "../src/mail.js";
import type { AccountRecord } from "../src/types.js";

const NOW = "2026-10-16T00:00:00.000Z";
// Test-only stand-in for an account secret, assembled at runtime so the repo
// carries no literal secret-shaped constant. Not a credential for anything.
const ACCOUNT_SECRET = ["sixteen", "char", "code"].join("-");
const MASTER_KEY = Buffer.alloc(32, 7);

const preset = providerPresets.find((item) => item.id === "qq");
if (!preset) throw new Error("qq provider preset missing");
const qqProvider: DetectedProvider = {
  ...preset,
  domain: "qq.com",
  isCustom: false,
  source: "preset",
  confidence: "high",
};

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  const base: AccountRecord = {
    id: "account-1",
    email: "person@example.test",
    provider: "custom",
    provider_name: "Custom",
    encrypted_password: "pending",
    auth_method: "password",
    provider_subject: null,
    tenant_id: null,
    granted_scopes: null,
    imap_host: "imap.example.test",
    imap_port: 993,
    imap_secure: 1,
    imap_transport: "tls",
    imap_username: "person@example.test",
    smtp_host: "smtp.example.test",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: "person@example.test",
    username_mode: "email",
    signature: "",
    status: "connected",
    last_error: null,
    last_error_code: null,
    last_sync_warning_code: null,
    last_synced_at: null,
    created_at: NOW,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, encrypted_password: encryptAccountPassword(merged, ACCOUNT_SECRET, MASTER_KEY) };
}

/** The smallest session `mail.ts` needs: connect/list plus what `safeLogout` reads. */
function imapStub(folders: string[] = ["INBOX", "Sent", "Trash"]) {
  return {
    usable: true,
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => folders.map((path) => ({ path }))),
    logout: vi.fn(async () => undefined),
  };
}

function smtpStub(result: unknown = { messageId: "<sent@example.test>" }) {
  return {
    verify: vi.fn(async () => true),
    sendMail: vi.fn(async () => result),
    close: vi.fn(),
  };
}

type Recorded = { imap: ImapConnectionSpec[]; smtp: SmtpConnectionSpec[] };

function recordingFactory(recorded: Recorded, session: unknown, transport: unknown): ProviderFactory {
  return {
    createImapSession(spec) {
      recorded.imap.push(spec);
      return session as ImapSession;
    },
    createSmtpTransport(spec) {
      recorded.smtp.push(spec);
      return transport as SmtpTransport;
    },
  };
}

describe("① 注入 fake 后，mail.ts 的真实路径只走接缝", () => {
  let recorded: Recorded;
  let session: ReturnType<typeof imapStub>;
  let transport: ReturnType<typeof smtpStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    recorded = { imap: [], smtp: [] };
    session = imapStub();
    transport = smtpStub();
    setProviderFactory(recordingFactory(recorded, session, transport));
  });

  afterEach(() => {
    // A leaked fake would silently make every later test in this file offline.
    resetProviderFactory();
  });

  it("createImapClient 把预设解析成 spec，且不再触碰 imapflow", () => {
    const client = createImapClient("person@qq.example", ACCOUNT_SECRET, qqProvider);

    expect(client).toBe(session);
    expect(recorded.imap).toStrictEqual([{
      host: preset.imap.host,
      port: preset.imap.port,
      secure: preset.imap.secure,
      transport: preset.imap.transport,
      username: "person@qq.example",
      auth: { kind: "password", secret: ACCOUNT_SECRET },
    }]);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it("imapClientForAccount 解出账户密码并把两个超时覆盖原样传下去", async () => {
    const row = account();
    const bare = await imapClientForAccount(row, MASTER_KEY);
    expect(bare).toBe(session);
    // 未请求覆盖时 spec 里**不存在**这两个键——批次 1 之前的条件展开正是这个语义。
    expect(recorded.imap[0]).toStrictEqual({
      host: "imap.example.test",
      port: 993,
      secure: true,
      transport: "tls",
      username: "person@example.test",
      auth: { kind: "password", secret: ACCOUNT_SECRET },
    });

    await imapClientForAccount(row, MASTER_KEY, undefined, { socketTimeout: 1_000, maxIdleTime: 60_000 });
    expect(recorded.imap[1]).toStrictEqual({
      host: "imap.example.test",
      port: 993,
      secure: true,
      transport: "tls",
      username: "person@example.test",
      auth: { kind: "password", secret: ACCOUNT_SECRET },
      socketTimeout: 1_000,
      maxIdleTime: 60_000,
    });
  });

  it("OAuth 账户把 access token 而不是密码交给接缝", async () => {
    const row = account({ auth_method: "oauth2", provider: "gmail", provider_subject: "subject-1" });
    const tokens = { getAccessToken: vi.fn(async () => "access-token-1") };

    await imapClientForAccount(row, MASTER_KEY, tokens);

    expect(tokens.getAccessToken).toHaveBeenCalledWith(row);
    expect(recorded.imap[0]!.auth).toStrictEqual({ kind: "oauth2", accessToken: "access-token-1" });
  });

  it("sendMail 用接缝造的 transport 发信，并在 finally 里关闭它", async () => {
    const row = account();
    const sentinel = { messageId: "<sentinel@example.test>", accepted: ["to@example.test"] };
    transport.sendMail.mockResolvedValue(sentinel);

    const result = await sendMail(row, MASTER_KEY, {
      to: ["to@example.test"],
      subject: "主题",
      text: "正文",
    });

    // 返回值必须来自 fake 的 transport —— 这是"真的走了接缝"的最强证据。
    expect(result).toBe(sentinel);
    expect(recorded.smtp).toStrictEqual([{
      host: "smtp.example.test",
      port: 465,
      secure: true,
      transport: "tls",
      username: "person@example.test",
      auth: { kind: "password", secret: ACCOUNT_SECRET },
    }]);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("testAccountConnection 的 IMAP 与 SMTP 两侧都走接缝", async () => {
    await expect(testAccountConnection("person@qq.example", ACCOUNT_SECRET, qqProvider)).resolves.toEqual({
      folders: 3,
      smtp: true,
    });

    expect(recorded.imap).toHaveLength(1);
    expect(recorded.smtp).toHaveLength(1);
    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(transport.verify).toHaveBeenCalledTimes(1);
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe("② 默认实现交给库的线上参数与批次 1 之前逐字相同", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ImapFlow.mockImplementation(function MockImapFlow() { return imapStub(); });
    createTransport.mockReturnValue(smtpStub());
  });

  it("connectionOptions 是冻结的，tls 一并冻结（它是被展开共享的，改一处会关掉全部证书校验）", () => {
    // imap.ts / smtp.ts spread this object; a spread copies the first level only,
    // so `tls` is a shared reference. Without the freeze, one stray
    // `spec.tls.rejectUnauthorized = false` would disable certificate
    // verification for every later connection in the process.
    expect(Object.isFrozen(connectionOptions)).toBe(true);
    expect(Object.isFrozen(connectionOptions.tls)).toBe(true);
    expect(connectionOptions.tls.rejectUnauthorized).toBe(true);
  });

  it("STARTTLS 连接：secure=false 且 doSTARTTLS 强制为真，证书校验与三档超时不变", () => {
    defaultProviderFactory.createImapSession({
      host: "imap.example.test",
      port: 143,
      secure: false,
      transport: "starttls",
      username: "person@example.test",
      auth: { kind: "password", secret: ACCOUNT_SECRET },
    });

    expect(ImapFlow).toHaveBeenCalledWith({
      host: "imap.example.test",
      port: 143,
      secure: false,
      // 缺了它，ImapFlow 会在 STARTTLS 不可用时降级到明文。
      doSTARTTLS: true,
      auth: { user: "person@example.test", pass: ACCOUNT_SECRET },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
      tls: { rejectUnauthorized: true },
    });
  });

  it("TLS 连接：doSTARTTLS 为假、secure 为真，并挂上 error 监听（缺它会让进程被晚到的 socket error 杀死）", () => {
    const session = imapStub();
    ImapFlow.mockImplementation(function MockImapFlow() { return session; });

    defaultProviderFactory.createImapSession({
      host: "imap.example.test",
      port: 993,
      secure: true,
      username: "person@example.test",
      auth: { kind: "oauth2", accessToken: "access-token-1" },
      maxIdleTime: 120_000,
    });

    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({
      secure: true,
      doSTARTTLS: false,
      auth: { user: "person@example.test", accessToken: "access-token-1" },
      socketTimeout: 45_000,
      maxIdleTime: 120_000,
    }));
    expect(session.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("SMTP：STARTTLS 强制 requireTLS，OAuth 用 Nodemailer 的 OAuth2 形状", () => {
    defaultProviderFactory.createSmtpTransport({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      transport: "starttls",
      username: "person@example.test",
      auth: { kind: "oauth2", accessToken: "access-token-1" },
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      // 缺了它，Nodemailer 会在 587 上"尽力而为"地 STARTTLS。
      requireTLS: true,
      auth: { type: "OAuth2", user: "person@example.test", accessToken: "access-token-1" },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
      tls: { rejectUnauthorized: true },
    });
  });
});

describe("③ RuntimeContext.providers 是活的注入点，不是摆设", () => {
  let db: DatabaseHandle;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (db) db.close();
    resetProviderFactory();
  });

  it("buildApp 装上 context.providers，且省略它就恢复真实实现（不留粘性 fake）", async () => {
    db = openDatabase(":memory:");
    const recorded: Recorded = { imap: [], smtp: [] };
    const fake = recordingFactory(recorded, imapStub(), smtpStub());

    app = await buildApp({ db, masterKey: MASTER_KEY, providers: fake });
    expect(activeProviderFactory()).toBe(fake);

    await app.close();
    app = undefined;
    // Deliberately no `resetProviderFactory()` here: the second build must
    // restore the real factory by itself. If it did not, this assertion is the
    // only thing standing between a test file that injects a fake and every
    // later `buildApp` in that file silently running offline.
    app = await buildApp({ db, masterKey: MASTER_KEY });
    expect(activeProviderFactory()).toBe(defaultProviderFactory);
  });
});
