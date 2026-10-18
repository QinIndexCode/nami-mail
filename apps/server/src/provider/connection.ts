/**
 * The network posture of every mail connection Nami opens.
 *
 * Kept in one place because these values are security-relevant: certificate
 * verification and the mandatory-STARTTLS flags in `imap.ts` / `smtp.ts` are
 * what stop a downgrade from silently exposing credentials or message bodies.
 * Moving the construction here must not change any of them.
 *
 * Frozen, and `tls` frozen with it: `imap.ts` / `smtp.ts` spread this object
 * into every connection spec, and a spread copies the top level only — so
 * without the freeze, one `spec.tls.rejectUnauthorized = false` anywhere in the
 * process would turn certificate verification off for every later connection.
 */
import type { MailServerSpec, MailTransportKind } from "./types.js";

export const connectionOptions = Object.freeze({
  logger: false as const,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 45_000,
  tls: Object.freeze({ rejectUnauthorized: true }),
});

/**
 * The single place that decides TLS vs STARTTLS, for both protocols.
 *
 * `transport` is authoritative when present; `secure` is the older field both
 * ImapFlow and Nodemailer callers still read, so a value written before
 * `transport` existed resolves to exactly the answer it always did.
 */
export function resolveTransport(server: MailServerSpec): MailTransportKind {
  return server.transport ?? (server.secure ? "tls" : "starttls");
}
