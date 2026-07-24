# Windows Installation and Updates

[简体中文](INSTALLING.md) | [English](INSTALLING.en.md)

This guide is for people using Nami Mail on Windows. The current desktop release scope is Windows x64. A Web session or development desktop session started from source is not the installed release and is not evidence that automatic updates work.

## Install from a Trusted Source

1. Open [GitHub Releases](https://github.com/QinIndexCode/nami-mail/releases) and confirm that the repository is `QinIndexCode/nami-mail`.
2. Download the `Nami Mail Setup <version>.exe` asset matching the version you want. Do not download or run `nami-mail-update-*.zip`, `.json`, `latest.yml`, or `.blockmap` by hand. They are internal release-validation or in-app update assets.
3. Close a running copy of Nami Mail, then run the installer. You can choose the installation directory during setup.

Early or unsigned Windows installers can be labeled as an "unknown publisher" by SmartScreen. That is neither proof that a file is trustworthy nor a reason to bypass a Windows warning. Return to the official Release page, check the repository, version, and Release Notes, and stop if the source, version, or signing state is unclear. Report the issue through the [support guide](../SUPPORT.en.md).

## Installed Versions

- When the same version is already installed, the installer lets you reinstall or keep the existing installation.
- Installing a newer version is treated as an upgrade and keeps local data.
- Starting an older installer shows a downgrade warning and cancels by default. Continue only after explicit confirmation so newer data is not accidentally handed to an older build.
- Nami Mail allows one desktop instance only. Opening it again restores and focuses the existing window instead of starting another mail sync process or local database.

## First Launch and Adding an Account

1. Open Nami Mail from the Start menu or desktop shortcut.
2. Select **Add account**, enter the complete email address, and wait for provider discovery or the manual configuration option.
3. Follow the provider's current guidance for secure sign-in, an app password, a client authorization code, or an account password. A one-time SMS or email code is not a mail-client credential.
4. After a connection succeeds, wait for the first sync. Enterprise, school, and custom-domain accounts can be limited by administrator policy.

Google and Microsoft OAuth sign-in depends on a configured public client ID. A disabled button does not mean that your password is wrong. Check whether the deployer supplied the required OAuth configuration, or choose an authentication method that the provider supports in the [provider guide](EMAIL-PROVIDERS.en.md). Never put an OAuth client secret, one-time code, or normal Web sign-in password in a mismatched field.

## Automatic Updates

Only installed Windows releases with a configured public GitHub Release channel and a valid update trust root check for updates. Development sessions, ordinary local builds, and installs without update configuration explicitly show that updates are unavailable.

When a newer stable version is found, the app offers three choices:

- **Update this version**: download and verify the ZIP update in the background. After the download, you still choose when to **Restart and update**; merely finding an update never restarts the app.
- **Skip this version**: stop offering that version and clear any downloaded update cache for it.
- **Remind me later**: choose a reminder in one hour, tomorrow, one week, or 30 days.

Before installation, updates check the version, asset name, size, SHA-512, and release trust chain. The app also closes its local service and outbound queue safely. On success it attempts to remove the update ZIP and temporary extraction directory. Windows file locks can defer cleanup until the next launch; this does not affect installed mail data. A failed update should leave the app usable and show an actionable error. Do not download a replacement ZIP from an unknown link.

## Local Data, Closing, and Uninstalling

Desktop data is stored under `%APPDATA%\Nami Mail` for the current Windows user, not in the installation directory. Sensitive mail data, credentials, OAuth refresh tokens, the outbound queue, and outbound attachments use application-layer encryption. The Windows master key is protected with the current user's DPAPI. Read [privacy and local data](PRIVACY.en.md) for encryption scope, plaintext metadata, and threat boundaries.

When you close the window, the app setting determines whether it exits or minimizes to the tray. Minimizing to the tray keeps synchronization running; exiting or updating shuts down the local service cleanly first.

Uninstallation keeps local data by default. Choosing **also delete local data** only removes the current Windows user's Nami Mail data directory, including the local database, keys, and settings. It does not delete mail held by the provider. Back up anything you need before deleting data, and understand that DPAPI-protected data is bound to the current Windows user context.

## Get Help

For connection or TLS failures, first check the network, DNS, proxy, security software, system time, server address, and encryption method. For authentication failures, make sure IMAP/SMTP is enabled and regenerate the provider-required app password or authorization code. An issue report should include only redacted version, runtime, error category, and minimal reproduction details. Never upload real mail, addresses, attachment names, OAuth parameters, tokens, or passwords. See the [support guide](../SUPPORT.en.md).
