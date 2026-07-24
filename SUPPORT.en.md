# Support Guide

[简体中文](SUPPORT.md) | [English](SUPPORT.en.md)

Nami Mail is a local-first mail client. It connects directly to the mail providers you configure; it does not operate a Nami Mail cloud account system that hosts mail or resets passwords.

## Check These First

1. In the app, confirm whether the provider requires IMAP/SMTP to be enabled, an app password, a client authorization code, or OAuth sign-in.
2. Read the [email provider setup guide](docs/EMAIL-PROVIDERS.en.md), [Windows installation and update guide](docs/INSTALLING.en.md), and official provider help linked by the app.
3. For Google or Microsoft OAuth, if secure sign-in is unavailable, use the provider guide to check public-client configuration and organization policy. Do not enter a client secret.
4. For network or TLS errors, check the network, DNS, proxy, security software, and system time before checking the server address and encryption method.
5. For the Windows desktop app, make sure you are using a supported installed release, not an unknown portable copy or modified build.

## Suitable Issues

- A functional problem that reproduces reliably in the current version.
- A verified provider compatibility problem.
- A suggestion to improve interaction, accessibility, translation, or documentation.
- A feature request with clear user value, constraints, and alternatives.

Use the repository issue template and include the version, system, runtime, reproduction steps, actual result, and expected result. Keep logs limited to error categories relevant to the problem. Remove addresses, subjects, bodies, attachment names, `Message-ID`, OAuth parameters, tokens, and passwords.

## Do Not Post Publicly

- Passwords, app passwords, client authorization codes, OAuth codes, refresh tokens, or client secrets.
- Real mail, contacts, attachments, screenshots, or local databases without authorization.
- Details that bypass a security boundary. Report those privately under the [security policy](SECURITY.en.md).
- Requests for a mail provider to change account policy, recover an account, or explain billing. Contact that provider directly.

## Support Boundary

Maintainers make a best effort to reproduce issues with sufficient information, but do not currently promise response times, remote takeover, account recovery, or paid support. GitHub Discussions availability depends on the public repository configuration; when it is not enabled, use the issue template that matches the problem type.

For local data, encryption boundaries, provider connections, and GitHub Release update checks, read [privacy and local data](docs/PRIVACY.en.md) and the [Windows release guide](docs/RELEASING.en.md).
