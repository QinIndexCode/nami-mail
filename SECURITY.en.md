# Security Policy

[简体中文](SECURITY.md) | [English](SECURITY.en.md)

Nami Mail handles account credentials, OAuth refresh tokens, and local mail caches. Do not publish a security issue, real mail, tokens, attachments, or data that could identify a user in a public issue, discussion, or pull request.

## Supported Scope

| Version | Status |
| --- | --- |
| Current `0.1.x` line | Security reports are accepted and fixes are assessed by impact. |
| Older versions or self-modified builds | No fix commitment; upgrade or reproduce on the current line first. |

The project does not promise a fixed remediation timeline. After confirming a report, maintainers will share progress without exposing other users' data.

## How to Report

Create a report through [GitHub private vulnerability reporting](https://github.com/QinIndexCode/nami-mail/security/advisories/new). The repository has private vulnerability reporting enabled; reports enter a private advisory flow visible only to the reporter and authorized maintainers.

Do not open a public issue, discussion, or pull request for a security problem. Do not send credentials, tokens, real mail, or exploit details through public channels. The project has not published a separate security email address. Use the private GitHub route above rather than guessing or looking for unpublished contact details.

A useful report normally includes:

- the affected Nami Mail version, Windows version, and runtime (installed desktop app or development service);
- security impact and attack prerequisites, not only an exception stack;
- minimum reproduction steps without real mail, passwords, tokens, or personal addresses;
- optional mitigation suggestions or security tests.

If sensitive evidence must be shared, first ask in the private advisory how to transfer it. Base64, redacted screenshots, and archives are not substitutes for access control.

## Common Security Boundaries

Current security-relevant scope includes:

- Windows desktop DPAPI master-key protection, application-layer AES-256-GCM encryption, and data migration;
- the local loopback API, Electron preload/IPC, single-instance behavior, and cache policy;
- IMAP/SMTP TLS, account authentication, OAuth loopback callbacks, and token storage;
- mail HTML sanitization, attachment downloads, and local file handling;
- the GitHub Release update source, ZIP/manifest integrity, Authenticode or Ed25519 trust roots, installer validation, and safe shutdown before update installation.

The following are normally outside what this project can fix independently, but can still be discussed privately first: a compromised provider account, an administrator or malicious process under the same Windows user, an operating-system or Electron upstream vulnerability, a user-installed unsigned third-party build, or the provider's own IMAP/SMTP/OAuth availability.

Local encryption is not full database encryption and cannot defend against an unlocked application, an administrator, or a malicious process able to call DPAPI as the same Windows user. See [privacy and local data](docs/PRIVACY.en.md).

## Coordinated Disclosure

Do not disclose exploit details before a fix is released. Maintainers will assess impact, reproduce, fix, and run regression checks; after both sides agree, they may describe affected versions, mitigations, and acknowledgements through Release Notes, the changelog, or a security advisory. No disclosure date is promised when the issue cannot be reproduced, no fix exists, or users could still be at risk.
