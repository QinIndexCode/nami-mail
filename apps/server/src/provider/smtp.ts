import nodemailer from "nodemailer";
import { connectionOptions, resolveTransport } from "./connection.js";
import type { SmtpConnectionSpec, SmtpTransport } from "./types.js";

/**
 * Builds the SMTP transport used to send mail.
 *
 * Body moved verbatim from `mail.ts` in batch 1: same options, same order.
 *
 * Draft MIME serialization deliberately does NOT come through here — the
 * `streamTransport` in `drafts.ts` never opens a socket, so it is a
 * message-format concern rather than a provider one.
 */
export function createSmtpTransport(spec: SmtpConnectionSpec): SmtpTransport {
  const transport = resolveTransport(spec);
  return nodemailer.createTransport({
    host: spec.host,
    port: spec.port,
    secure: transport === "tls",
    // Nodemailer otherwise uses opportunistic STARTTLS on port 587. Require it
    // so an active downgrade cannot expose credentials or message contents.
    requireTLS: transport === "starttls",
    auth: spec.auth.kind === "oauth2"
      ? { type: "OAuth2" as const, user: spec.username, accessToken: spec.auth.accessToken }
      : { user: spec.username, pass: spec.auth.secret },
    ...connectionOptions,
  });
}
