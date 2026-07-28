const sensitiveEnvironmentNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_RELEASE_TOKEN",
  "CSC_LINK",
  "CSC_NAME",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY",
  "NAMI_MAIL_GOOGLE_OAUTH_CLIENT_SECRET",
  "NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_SECRET",
  "NAMI_MAIL_TRANSLATION_API_KEY",
  "NAMI_MAIL_LOCAL_API_TOKEN",
];

export function redactSmokeDiagnosticText(value, environment = process.env) {
  let redacted = String(value);
  for (const name of sensitiveEnvironmentNames) {
    const secret = environment[name]?.trim();
    if (secret && secret.length >= 4) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}
