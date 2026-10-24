/**
 * The provider seam (architecture contract §4.4, batch 1).
 *
 * Every ImapFlow and Nodemailer construction in the server resolves through
 * `activeProviderFactory()`, so a test can replace the network with a fake
 * without rewriting the 29 test files that mock `../src/mail.js` wholesale —
 * and without the 11 modules that call `imapClientForAccount` having to thread
 * a factory through their own signatures.
 *
 * The holder is process-global on purpose. The account-level functions in
 * `mail.ts` take no shared context object, so "pure constructor injection"
 * would mean changing every call site; that is the trade the contract rejected.
 * Consequences to know before using it:
 *   - last writer wins for the whole process;
 *   - `buildApp` assigns it on every call, so an app built without `providers`
 *     restores the real factory rather than inheriting a previous app's fake;
 *   - a test that calls `setProviderFactory` **directly** (not through
 *     `buildApp`) must pair it with `resetProviderFactory()` in `afterEach`, or
 *     the next test in the same file silently talks to the fake (vitest isolates
 *     modules per test file, so it cannot leak further).
 */
import { createImapSession } from "./imap.js";
import { createSmtpTransport } from "./smtp.js";
import type { ProviderFactory } from "./types.js";

export { connectionOptions, resolveTransport } from "./connection.js";
export type {
  ImapConnectionSpec,
  ImapSession,
  MailAuth,
  MailServerSpec,
  MailTransportKind,
  ProviderFactory,
  SmtpConnectionSpec,
  SmtpTransport,
} from "./types.js";

/** The real implementations. Tests may also spy on this object's members. */
export const defaultProviderFactory: ProviderFactory = {
  createImapSession,
  createSmtpTransport,
};

let active: ProviderFactory = defaultProviderFactory;

export function activeProviderFactory(): ProviderFactory {
  return active;
}

/** Replaces transport construction for this process. See the header for the rules. */
export function setProviderFactory(factory: ProviderFactory): void {
  active = factory;
}

export function resetProviderFactory(): void {
  active = defaultProviderFactory;
}
