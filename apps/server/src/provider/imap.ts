import { ImapFlow } from "imapflow";
import { connectionOptions, resolveTransport } from "./connection.js";
import type { ImapConnectionSpec, ImapSession } from "./types.js";

/**
 * Builds the one IMAP client the server ever constructs.
 *
 * Body moved verbatim from `mail.ts` in batch 1: same options, same order, same
 * error listener. Anything that changes here changes every sync, move, flags
 * push, draft append, attachment fetch, backup, and IDLE connection.
 */
export function createImapSession(spec: ImapConnectionSpec): ImapSession {
  const transport = resolveTransport(spec);
  const client = new ImapFlow({
    host: spec.host,
    port: spec.port,
    secure: transport === "tls",
    // A false `secure` value otherwise allows ImapFlow to downgrade to
    // plaintext when STARTTLS is unavailable. This is deliberately mandatory.
    doSTARTTLS: transport === "starttls",
    auth: spec.auth.kind === "oauth2"
      ? { user: spec.username, accessToken: spec.auth.accessToken }
      : { user: spec.username, pass: spec.auth.secret },
    ...connectionOptions,
    ...(spec.socketTimeout !== undefined ? { socketTimeout: spec.socketTimeout } : {}),
    ...(spec.maxIdleTime !== undefined ? { maxIdleTime: spec.maxIdleTime } : {}),
  });

  // ImapFlow reports connection failures both through rejected operations and
  // through EventEmitter. A late socket error without a listener terminates the
  // entire Node.js process even after the HTTP handler has returned an error.
  client.on("error", () => undefined);
  return client;
}
