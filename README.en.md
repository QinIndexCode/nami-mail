# Nami Mail

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="build/icon.png" alt="Nami Mail" width="112" />
</p>

Nami Mail is a local-first, multi-account mail client. It brings Gmail, iCloud, QQ, 163, Outlook/Hotmail, Yahoo, AOL, Fastmail, Yandex, and other IMAP/SMTP-capable accounts into one inbox that runs on your own machine. Common providers use app passwords or client authorization codes; configured Google and Microsoft accounts can use OAuth 2.0 sign-in.

<p align="center">
  <img src="docs/nami-mail-inbox.png" alt="Nami Mail inbox" width="1200" />
</p>

> The password field is only for long-lived credentials required by the provider: Gmail and iCloud normally require an app password, QQ and NetEase require a client authorization code, and a self-hosted mailbox can require its mailbox password. Credentials are never sent to a service other than Nami Mail and the selected mail provider; they are used only for a direct provider connection. OAuth refresh tokens are also encrypted and stored locally only.

## Get Started

For everyday use, download the Windows x64 `Nami Mail Setup <version>.exe` only from [GitHub Releases](https://github.com/QinIndexCode/nami-mail/releases). The `zip` and `json` assets are verified resources for in-app automatic updates, not manual installers. Running from source is for development and contribution only.

See [Windows installation and updates](docs/INSTALLING.en.md) for first installation, SmartScreen, reinstalling the same version, downgrade protection, retained data, uninstallation, and update behavior. See [email provider setup](docs/EMAIL-PROVIDERS.en.md) for account preparation, provider differences, OAuth prerequisites, and manual configuration.

## Documentation

- [Documentation index](docs/README.en.md): find English and Chinese documentation by user, contributor, or release task.
- [Windows installation and updates](docs/INSTALLING.en.md): downloads, installation, first launch, uninstallation, update prompts, and SmartScreen guidance.
- [Email provider setup](docs/EMAIL-PROVIDERS.en.md): provider preparation, OAuth, manual IMAP/SMTP, and common connection issues.
- [Message translation](docs/TRANSLATION.en.md): optional translation-service configuration, the explicit-send boundary, and privacy considerations.
- [Privacy and local data](docs/PRIVACY.en.md): local data, encryption boundaries, and third-party connections.
- [Support guide](SUPPORT.en.md): account setup, network problems, and suitable issue reports.
- [Security policy](SECURITY.en.md): how and when to report vulnerabilities privately.
- [Contributing guide](CONTRIBUTING.en.md), [code of conduct](CODE_OF_CONDUCT.en.md), [development guide](docs/DEVELOPMENT.en.md), and [architecture and trust boundaries](docs/ARCHITECTURE.en.md): local development, collaboration boundaries, tests, process boundaries, and pull-request requirements.
- [Windows release guide](docs/RELEASING.en.md), [release notes](docs/releases/README.en.md), and the [changelog](CHANGELOG.en.md): signing, GitHub Releases, user-facing version information, and release verification. The Chinese changelog remains the authoritative version history.
- [Localization guide](docs/LOCALIZATION.en.md): maintenance rules for UI JSON packs and documentation translations.

## Run from Source

Node.js 22.14.0 or newer is required.

```powershell
# Run these commands from the project root.
npm.cmd install
npm.cmd run build
npm.cmd start
```

Open [http://127.0.0.1:3187](http://127.0.0.1:3187) in a browser. For development mode:

```powershell
npm.cmd run dev
```

The development service uses the root `better-sqlite3` module directly. On Windows x64, v13 uses the N-API prebuilt module at `prebuilds/win32-x64.node`; command-line Node and Electron each run a real query to validate that module. No ABI-specific binary swapping is required. You can validate the load paths separately:

```powershell
npm.cmd run verify:node-sqlite
npm.cmd run verify:electron-sqlite
npm.cmd run smoke:server-node
```

## Windows Desktop Installer

Nami Mail can run as a native Windows app. Its mail UI, interactions, and animations share the same React/CSS implementation as the Web build.

Regular users should use the Release asset `Nami Mail Setup <version>.exe`, not extract and run an update ZIP. Before installation and whenever Windows shows a trust warning, verify the source and signing state through [Windows installation and updates](docs/INSTALLING.en.md).

```powershell
npm.cmd install
npm.cmd run package:win
```

After the build completes, the installer is at `release-artifacts/<package.json version>/Nami Mail Setup <package.json version>.exe`. The installed app's local database and encrypted master key are stored under `%APPDATA%\Nami Mail\data` for the current Windows user. They are not written to the installation directory, and development `data/` is not packaged.

### Installation, Updates, and Uninstallation

- When the same version is already installed, the interactive installer lets the user reinstall or keep the existing installation. Silent deployment can safely repeat an installation of the same version.
- When the installed version is lower than the installer, the installer clearly describes an upgrade and retains local data.
- When the installed version is higher than the installer, the interactive installer cancels a downgrade by default and continues only after explicit confirmation. A silent downgrade additionally requires `--nami-allow-downgrade`; otherwise it exits with code `3`.
- During uninstallation, the app asks whether to delete the current Windows user's local Nami Mail data and keeps it by default. Deletion removes only `%APPDATA%\Nami Mail`, including the local database, encryption keys, saved settings, and public OAuth configuration. It does not delete mail held by the provider. Silent uninstall keeps data by default; use `Uninstall Nami Mail.exe /S --nami-delete-data` for explicit deletion. A test or custom directory set with `NAMI_MAIL_USER_DATA_DIR` is never removed automatically by the installer.

The desktop app and Web server both use the native SQLite module. `better-sqlite3 13` uses the same N-API prebuilt module on Windows x64. Before desktop startup or packaging, the project performs a real validation that Electron can load the root module.

For public Windows distribution, a timestamped Authenticode signature on the final installer is strongly recommended. An unsigned installer can still use an Ed25519 manifest trust root for updates, but Windows SmartScreen can display an origin warning.

### GitHub Automatic Updates

An installed production Windows build checks [GitHub Releases](https://github.com/QinIndexCode/nami-mail/releases) for a newer stable version after startup and periodically while it is running. Transient network failures use exponential backoff. Checks request public Release metadata only; they do not send a GitHub access token, mail credentials, or mail content to GitHub.

When an update is found, an in-app prompt consistent with the current theme lets the user choose:

- **Update this version**: download a ZIP update and validate it locally, then let the user choose **Restart and update**. The app never downloads or restarts on its own merely because it found an update.
- **Skip this version**: stop offering that version and clear its local ZIP cache if it was already downloaded.
- **Remind me later**: choose a reminder in one hour, tomorrow, one week, or 30 days. The prompt waits while important work such as composing, account setup, settings, or sending status is active instead of taking focus.

The app checks the Release version, asset name, size, and ZIP SHA-512 before and after download. An Ed25519 build first validates the JSON manifest signature and then uses that manifest to bind the ZIP. An Authenticode build also verifies that the extracted installer has the same signer as the current installer. An update ZIP may contain only one NSIS installer at its root; the update helper validates the ZIP again before running a silent upgrade.

After successful installation, the helper attempts cleanup of the downloaded ZIP and temporary extraction directory up to five times, rechecking after an increasing 100-millisecond delay. If files remain, the next version tries again only inside the matching version's update cache: success is reported unobtrusively, while an unresolved cleanup error remains visible. Another process under the same Windows user can still lock or rename files, so deletion cannot be promised absolutely. On installation failure, the helper records only version, failure stage, and time, then tries to reopen the old version after an integrity check. If recovery is not possible, the next manual launch shows recovery status. If the local mail service or outbound queue cannot shut down safely, the update does not start and the app remains usable.

A production release requires at least one trust root: a valid Authenticode signature on the current installer or an Ed25519 public key built into installer resources. The first restricts a new installer to the same signer as the current app; the second requires the GitHub JSON manifest to carry an Ed25519 signature made with the matching private key. A development run or ordinary local installer without GitHub update configuration or a trust root explicitly shows **not enabled** and never contacts an unknown address.

Building a GitHub update package must target the public repository `QinIndexCode/nami-mail` (or a public repository that maintainers explicitly migrate to). Default output is already isolated by the current version under `release-artifacts/<package.json version>`. A production release or parallel verification should still set `release-artifacts/<version>` explicitly so old build output cannot enter the current asset set:

```powershell
$env:NAMI_MAIL_GITHUB_REPOSITORY="QinIndexCode/nami-mail"
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
# Configure at least one trust root below. The private key exists only in this process or GitHub Secrets.
$env:NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY="<Base64 PKCS#8 Ed25519 private key>"
# Authenticode additionally needs a fixed signing identity.
# $env:CSC_LINK="<certificate path, URL, or base64>"
# $env:CSC_KEY_PASSWORD="<certificate password>"
# $env:NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER="<certificate SimpleName or full Subject>"
# $env:NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT="<40-character SHA-1 thumbprint>"
npm.cmd run package:win:github
```

`package:win:github` verifies that the repository is public, generates the installer, `latest.yml`, blockmap, versioned ZIP, and JSON manifest, and runs an installer smoke test. It does not publish. Publish with `npm.cmd run publish:github` or push the exact tag `v<package.json version>`. Publication first creates a draft Release, then redownloads and checks the size and SHA-256 of these five assets before promoting it to a published Release:

1. `Nami Mail Setup <version>.exe`
2. `Nami Mail Setup <version>.exe.blockmap`
3. `latest.yml`
4. `nami-mail-update-<version>-win-x64.zip`
5. `nami-mail-update-<version>-win-x64.json`

`latest.yml` and the blockmap are electron-builder release metadata. The desktop runtime does not treat them as trust sources for ZIP updates; it uses GitHub `releases/latest`, the versioned JSON manifest, and the ZIP. The repository workflow `.github/workflows/release-windows.yml` validates and publishes when an exact version tag is pushed. It uses the short-lived `GITHUB_TOKEN` supplied by GitHub and optional Windows certificate material plus `NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY` from Secrets. Those values are never written to the app, update configuration, logs, or Release assets. Until the first public Release and a real old-version-to-new-version update verification occur, do not describe local tests as proof that automatic updates work online. See the [Windows release guide](docs/RELEASING.en.md) for complete maintainer steps.

## Add an Email Account

Select **Add account** from the left sidebar and enter an email address. Nami Mail uses the domain plus MX and SRV records to choose servers, and offers manual IMAP/SMTP configuration when needed. Normal setup does not require the user to enter ports or encryption modes.

1. In the account dialog, read the provider guidance and first finish the provider's required two-factor, IMAP-enable, or app-password preparation.
2. Enter the complete address. A recognized provider shows the recommended authentication method, official setup links, and important notes.
3. Prefer Google or Microsoft secure sign-in. For other providers, enter only a long-lived app password, client authorization code, or separate password, never a one-time code.
4. If a preset connection fails, open **Manual IMAP / SMTP configuration** and check the server, encryption, and username for each protocol.

Gmail, Outlook.com, Hotmail, Live, MSN, Microsoft 365 tenant default domains (`*.onmicrosoft.com`), and enterprise or school accounts discovered as Microsoft 365 preferentially show provider OAuth sign-in. After OAuth, Nami Mail uses provider-issued access tokens for IMAP/SMTP. An organization account whose Microsoft administrator disables IMAP still cannot synchronize through IMAP. Other providers show their app-password, client-authorization-code, or separate-password path.

Enter a long-lived provider credential here, not a one-time SMS, email, or authenticator code. Every IMAP/SMTP connection requires TLS or STARTTLS; manual configuration cannot downgrade to plaintext authentication.

| Provider | Authentication | Username | Notes |
| --- | --- | --- | --- |
| Gmail / Google Workspace | Google OAuth2; app password as a compatibility path | Full email address | Prefer Google sign-in for personal Gmail. Identify custom domains through OAuth or MX discovery. Do not enter a normal Google password. |
| Outlook.com / Hotmail / Live / MSN / Microsoft 365 | Microsoft OAuth2 | Full email address | Includes Microsoft 365 tenant default domains, `*.onmicrosoft.com`. Outlook/Microsoft 365 uses Modern Auth; IMAP is a compatibility transport that enterprise administrators can disable. |
| iCloud / me.com / mac.com | Apple app-specific password | Local part before `@` for IMAP; full address for SMTP | iCloud does not support POP; SMTP port 587 uses STARTTLS. |
| QQ / QQ VIP / Foxmail | QQ client authorization code | Full email address | Enable IMAP/SMTP in QQ Mail settings; do not enter the QQ sign-in password. |
| 163 / 126 / yeah / 188 / NetEase VIP | NetEase client authorization password | Full email address | Enable IMAP/SMTP in Web settings, then generate it. `163.net` is not misidentified as NetEase. |
| Yahoo / AOL | App password | Full email address | Nami Mail currently has no Yahoo OAuth integration. Yahoo Japan is a separate service. |
| Fastmail | App password | Full email address | The Basic plan does not provide third-party IMAP/SMTP. JMAP is not yet a synchronization backend. |
| Zoho | App password or account password | Full email address | Nami Mail currently has no Zoho OAuth integration. IMAP availability can differ between free plans and enterprise custom domains. |
| Yandex | App password | Full email address | Enable IMAP in settings, then create a mail-client app password. |
| Sina / Sohu / 139 / 189 / Aliyun | Provider authorization code, separate password, or client password | Usually full email address | Prefer a preset. Use manual configuration when provider pages specify different endpoints. |
| Other enterprise, school, or self-hosted mail | Mail password, app password, or provider authorization | As specified by the provider | Try DNS discovery, then standard endpoints, and manually verify IMAP/SMTP if needed. |

### OAuth Configuration

Google and Microsoft OAuth requires the deployer to register the matching public OAuth clients. Nami Mail uses Authorization Code + PKCE, state, and nonce; it does not accept or store an OAuth client secret. After authorization, the refresh token is stored locally encrypted with the master key and the access token stays in runtime memory only.

For the Windows desktop app, OAuth configuration priority is, from highest to lowest: operating-system environment variables set before Nami Mail starts, `nami-mail.env` in the user data directory, and the project-root `.env` fallback available only for development desktop builds. The standard installed-app configuration file is `%APPDATA%\Nami Mail\nami-mail.env`; it does not read the project-root `.env`. An installed build reads only these four public OAuth settings from that file. It cannot use it to change the listen address, database, or key path. Never put a `client secret` in any location.

```dotenv
NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID=your-google-client-id
NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID=your-microsoft-client-id
# common, organizations, consumers, or a Microsoft Entra tenant ID
NAMI_MAIL_MICROSOFT_TENANT=common
# Authorization request lifetime in seconds (60-900)
NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS=600
```

OAuth callbacks return to local `/api/oauth/google/callback` or `/api/oauth/microsoft/callback`. The development Web service defaults to `http://127.0.0.1:3187`. Before registering a callback for a real client, check the provider's current desktop/loopback-app host and port requirements. When no client ID is configured, the UI clearly explains that OAuth is unavailable and does not pretend that sign-in can work.

- Google: create a Google Cloud **Desktop app** client. Nami Mail uses the native-app loopback flow and at runtime uses `http://127.0.0.1:<dynamic port>/api/oauth/google/callback`. Do not put a Web application client ID in this variable or you will get `redirect_uri_mismatch`. See [Google native-app OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).
- Microsoft: configure a loopback callback under Microsoft Entra **Mobile and desktop applications / public client**, including the `http://localhost` loopback redirect. At runtime, Nami Mail uses `http://localhost:<dynamic port>/api/oauth/microsoft/callback`, handled by a local callback bridge bound only to IPv6 `::1`. Do not change it to `127.0.0.1`; that is a different redirect URI. Before a production release, perform one real sign-in with the target tenant. See [Microsoft redirect URI documentation](https://learn.microsoft.com/entra/identity-platform/reply-url) and the [authorization code flow documentation](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).

## Features

- Unified multi-account inbox, account filtering, search, and unread state.
- Discovery for common providers; adding an account normally needs only two fields.
- Periodic background synchronization and manual synchronization.
- Full initial synchronization of selectable folders; the default cache is the newest 200 messages per folder and can be changed with `SYNC_MESSAGE_LIMIT`.
- Mail reading, plain-text and safe-HTML display, read state, real IMAP starring, and a cross-folder starred view.
- Real IMAP draft saving, editing, send replacement, and close confirmation for unsaved content.
- Attachment metadata and controlled streaming downloads without copying attachment bytes into the local database.
- Compose, reply, and send over SMTP using the matching account.
- System, light, and dark themes; complete offline background presets, a custom background image, and background intensity.
- Configurable Windows desktop notifications, foreground alerts, system/soft/bright/silent notification sounds, and a test button.
- Configurable background-sync period, account removal, restore-default settings, a desktop three-column layout, and responsive mobile layout.
- Local SQLite storage with AES-256-GCM application-layer encryption for credentials, sensitive mail payloads, the outbound queue, and outbound attachments.

## Local Data and Security

- Database: `data/nami-mail.db`.
- Windows desktop master key: `data/master.key.dpapi`. Electron `safeStorage` protects it with the current Windows user's DPAPI. The key is passed to the local runtime only in desktop-process memory and never enters a URL, ordinary environment variable, IPC, or log.
- A legacy desktop `data/master.key` is removed after DPAPI wrapping is written and verified. If DPAPI is unavailable or a protected key cannot be unlocked, the desktop app blocks startup and never falls back to creating a new plaintext key.
- The command-line Node development service still uses an isolated development data path from `MASTER_KEY_PATH`; it is not the Windows desktop protection path.
- Credentials and OAuth refresh tokens are stored with AES-256-GCM encryption. Encrypted mail payloads contain Message-ID, subject, sender, recipients, preview, plain/HTML body, reply-thread fields, and attachment metadata. Legacy plaintext fields are migrated and cleared before the local API starts; WAL truncation and `VACUUM` clear old pages.
- The persistent outbound queue encrypts subject, recipients, body, HTML, Message-ID, and diagnostics with separate purpose-derived keys. Request fingerprints and Message-ID lookup values use a derived-key HMAC. Pending attachment content, names, and MIME types are also encrypted on disk; legacy plaintext attachments migrate at startup. Received attachment bytes are not copied into the local database and are streamed from the provider when downloaded.
- This is not whole-database SQLite encryption. Account address/provider, folders, UID, timestamps, flags, size, delivery state, record identifiers, ordinary app settings, and custom background images can remain plaintext metadata. DPAPI and application-layer encryption substantially reduce leakage from direct static-file reads or offline copies, but cannot stop a malicious process under the same Windows user from calling DPAPI, nor defend an unlocked running app or an administrator. Do not describe the current implementation as whole-database encryption equivalent to SQLCipher.
- The service listens on `127.0.0.1` only and is not exposed to the LAN.
- The master key, database, and outbound attachment directories are covered by `.gitignore`. A backup must protect the whole data directory; the DPAPI-wrapped desktop key is additionally bound to the current Windows user context.
- Mail HTML is sanitized before display and removes remote images, scripts, forms, and embedded content by default to reduce tracking and script risk.

## Public Repository Boundary

Source code is published at [QinIndexCode/nami-mail](https://github.com/QinIndexCode/nami-mail). The repository keeps the npm package setting `private: true` to prevent accidental publication of a desktop app to npm. That does not affect the open source code, issues, releases, or installers on GitHub.

Do not commit `data/`, `.env`, database sidecar files, outbound attachment directories, certificates, private keys, `artifacts/` screenshots, or `release-current/` / `release-artifacts/` build output. The local `.gitignore` excludes them, but run these checks before publishing so the commit contains only intended source and documentation:

```powershell
git remote -v
git status --short --ignored
git check-ignore -v data/master.key data/master.key.dpapi .env release-artifacts/0.1.0/update.zip
```

You can copy `.env.example` to `.env` to change the port, data path, or log level. Mail sync frequency is controlled in app settings and takes effect immediately.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run smoke:runtime
npm.cmd run smoke:desktop
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win
npm.cmd run smoke:installer
npm.cmd audit --omit=dev
```

## Technical Structure

- Web: React, TypeScript, Vite
- API: Fastify, TypeScript
- Mail: ImapFlow, MailParser, Nodemailer
- Storage: SQLite (`better-sqlite3`)
- Key protection: Node.js `crypto` plus AES-256-GCM

The architecture draws on public implementation ideas from [ImapFlow](https://github.com/postalsys/imapflow), [Stork](https://github.com/paperkite-hq/stork), and [MailGo](https://github.com/MengMengCode/MailGo). Nami Mail itself uses a lightweight all-Node.js local architecture and does not depend on MySQL or Redis.

## License

Nami Mail is available under the [MIT License](LICENSE).
