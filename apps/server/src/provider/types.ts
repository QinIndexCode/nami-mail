/**
 * The provider seam's vocabulary (architecture contract §4.4).
 *
 * Everything here describes **transport construction**: what a connection needs
 * and what the two libraries hand back. Nothing in this directory knows about
 * accounts, folders, or tasks — it is a leaf module (contract §5 rule 3).
 *
 * Naming is deliberately distinct from `../providers.js`, which is the
 * preset/autoconfig module and already exports `MailTransport` for the
 * `"tls" | "starttls"` union. Here `SmtpTransport` is the Nodemailer object and
 * `ImapSession` the ImapFlow client, so the two meanings cannot be confused.
 */
import type { ImapFlow } from "imapflow";
import type nodemailer from "nodemailer";

export type MailTransportKind = "tls" | "starttls";

export type MailAuth =
  | { kind: "password"; secret: string }
  | { kind: "oauth2"; accessToken: string };

/** The server shape a preset (`MailServerConfig`) and an account row both reduce to. */
export type MailServerSpec = {
  host: string;
  port: number;
  /** Kept for ImapFlow/Nodemailer callers; `transport` is authoritative. */
  secure: boolean;
  /**
   * Optional here although `providers.ts`'s `MailServerConfig` requires it: a
   * spec built without it resolves through `resolveTransport`'s `secure` branch,
   * which is the exact answer the pre-seam code gave. Omitting it therefore
   * cannot produce a weaker posture than the old code did — it is the
   * conservative direction. Every in-repo producer sets it anyway.
   */
  transport?: MailTransportKind;
};

export type ImapConnectionSpec = MailServerSpec & {
  username: string;
  auth: MailAuth;
  /** Overrides `connectionOptions.socketTimeout` when present. */
  socketTimeout?: number;
  /** Overrides ImapFlow's IDLE budget when present. */
  maxIdleTime?: number;
};

export type SmtpConnectionSpec = MailServerSpec & {
  username: string;
  auth: MailAuth;
};

/**
 * Batch 1 keeps this an exact alias of `ImapFlow`: `imapClientForAccount` still
 * returns that client, and 11 modules drive it through
 * `Awaited<ReturnType<typeof imapClientForAccount>>`. Narrowing it to the
 * structural slice those callers actually use is batch 2/5 work — doing it now
 * would change the mail module's public return type for no behavioral gain.
 * Fakes therefore still cast, exactly as the 29 `vi.mock("../src/mail.js")`
 * files do today.
 */
export type ImapSession = ImapFlow;
/** Exactly what `nodemailer.createTransport` returns, so `sendMail` keeps its inferred result. */
export type SmtpTransport = ReturnType<typeof nodemailer.createTransport>;

export type ProviderFactory = {
  createImapSession(spec: ImapConnectionSpec): ImapSession;
  createSmtpTransport(spec: SmtpConnectionSpec): SmtpTransport;
};
