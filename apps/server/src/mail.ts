import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { decryptSecret } from "./crypto.js";
import { loginUsername, type DetectedProvider } from "./providers.js";
import type { AccountRecord } from "./types.js";

const connectionOptions = {
  logger: false as const,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 45_000,
  tls: { rejectUnauthorized: true },
};

export function createImapClient(
  email: string,
  password: string,
  provider: Pick<DetectedProvider, "imap" | "usernameMode">,
): ImapFlow {
  const client = new ImapFlow({
    host: provider.imap.host,
    port: provider.imap.port,
    secure: provider.imap.secure,
    auth: {
      user: loginUsername(email, provider as DetectedProvider),
      pass: password,
    },
    ...connectionOptions,
  });

  // ImapFlow reports connection failures both through rejected operations and
  // through EventEmitter. A late socket error without a listener terminates the
  // entire Node.js process even after the HTTP handler has returned an error.
  client.on("error", () => undefined);
  return client;
}

export async function testMailboxConnection(
  email: string,
  password: string,
  provider: DetectedProvider,
): Promise<{ folders: number }> {
  const client = createImapClient(email, password, provider);
  try {
    await client.connect();
    const folders = await client.list();
    return { folders: folders.length };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

export function imapClientForAccount(account: AccountRecord, masterKey: Buffer): ImapFlow {
  return createImapClient(account.email, decryptSecret(account.encrypted_password, masterKey), {
    imap: {
      host: account.imap_host,
      port: account.imap_port,
      secure: Boolean(account.imap_secure),
    },
    usernameMode: account.username_mode,
  } as DetectedProvider);
}

export async function sendMail(
  account: AccountRecord,
  masterKey: Buffer,
  message: { to: string[]; cc?: string[]; subject: string; text: string; html?: string },
) {
  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: Boolean(account.smtp_secure),
    auth: {
      user: account.email,
      pass: decryptSecret(account.encrypted_password, masterKey),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
    tls: { rejectUnauthorized: true },
  });
  return transport.sendMail({
    from: account.email,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export function friendlyMailError(error: unknown, hint?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const normalized = [
    raw,
    details.code,
    details.responseStatus,
    details.responseText,
    details.serverResponseCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    details.authenticationFailed === true ||
    normalized.includes("auth") ||
    normalized.includes("credentials") ||
    normalized.includes("login")
  ) {
    return `邮箱拒绝了登录凭据。${hint ? ` ${hint}` : "请确认使用的是客户端授权码或应用专用密码。"}`;
  }
  if (normalized.includes("certificate") || normalized.includes("tls")) {
    return "无法验证邮箱服务器的 TLS 证书，已拒绝不安全连接。";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("timedout")) {
    return "连接邮箱服务器超时，请检查网络或稍后重试。";
  }
  if (normalized.includes("getaddrinfo") || normalized.includes("enotfound")) {
    return "无法找到该邮箱的 IMAP 服务器。";
  }
  return "连接邮箱服务器失败，请检查邮箱是否已开启 IMAP 服务。";
}
