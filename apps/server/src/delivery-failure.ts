import { mailErrorCode, type MailErrorCode } from "./mail.js";

function smtpCommand(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 2) return undefined;
  const details = error as Record<string, unknown>;
  if (typeof details.command === "string") return details.command.trim().toUpperCase();
  return smtpCommand(details.cause, depth + 1);
}

function isKnownPreAcceptanceFailure(code: MailErrorCode, error: unknown): boolean {
  if ([
    "local_data_invalid",
    "invalid_credential",
    "imap_auth_failed",
    "smtp_auth_failed",
    "imap_disabled",
    "provider_configuration",
    "server_not_found",
    "network_unavailable",
    "connection_refused",
    "tls_certificate_failed",
    "tls_handshake_failed",
    "oauth_required",
    "reauth_required",
  ].includes(code)) return true;

  // Nodemailer labels SMTP protocol failures by command. Explicit SMTP
  // command rejection before message transfer is safe to retry. `CONN` is
  // intentionally excluded: socket timeout/reset errors may be reported with
  // that command even when the final delivery response was lost.
  const command = smtpCommand(error);
  return command === "EHLO" || command === "HELO" || command === "AUTH"
    || command === "MAIL FROM" || command === "RCPT TO" || command === "DATA";
}

export function deliveryFailureStatus(error: unknown): "failed" | "unknown_delivery" {
  const code = mailErrorCode(error);
  return isKnownPreAcceptanceFailure(code, error) ? "failed" : "unknown_delivery";
}

