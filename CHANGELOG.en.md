# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

This is the English translation of the Chinese source changelog. `CHANGELOG.md` remains the authoritative version history. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories and Semantic Versioning.

## [0.1.2] - 2026-07-24

### Fixed

- Prevented Windows checkout line-ending differences from falsely marking generated locale catalogs as stale.
- Set an explicit, bounded 30-second limit for the two security migration tests that perform SQLite `VACUUM` and physical WAL checks, avoiding false timeouts on constrained Windows runners.

## [0.1.1] - 2026-07-24

### Added

- Added user-triggered message-body machine translation to the current interface language, with hide/show/copyable results and an explicit machine-translation accuracy notice.
- Added LibreTranslate-compatible translation service settings with encrypted local storage for the service address, timeout, and optional API key; saving requires a valid address, removal requires explicit confirmation, and the body is sent only after the user chooses Translate.
- Added JSON interface language packs, localization validation, and maintenance rules for paired Chinese and English public documentation.

### Improved

- Improved state presentation across Inbox, Archive, sending status, and settings to avoid unnecessary list jumps while reading unread mail.
- Improved account setup, selectable message content, verification-code extraction, and actionable network/TLS error guidance.
- Unified themed menus, selects, tooltips, and dialogs; dialogs use a translucent overlay instead of a blurred background.

### Documentation

- Added user guidance for installation from GitHub Releases, first launch, update choices, uninstallation, and Windows SmartScreen warnings.
- Added provider guidance for authentication preparation, OAuth boundaries, manual IMAP/SMTP setup, and troubleshooting.
- Added publishable [v0.1.1 release notes](docs/releases/v0.1.1.en.md), clearly separating published assets from the automatic-update path that still requires real online verification.
- Set the security policy and GitHub Issue contact path to GitHub's enabled private vulnerability reporting flow rather than an unconfigured contact address.

## [0.1.0] - 2026-07-22

- Local-first multi-account IMAP/SMTP aggregation, reading, drafts, sending, and synchronization.
- Public-client OAuth for Google and Microsoft, plus app-password and authorization-code guidance for common providers.
- Windows desktop app, local data encryption, and GitHub Release ZIP update infrastructure.
- Startup checks, update/skip/remind-later choices, ZIP integrity verification, and post-update cache cleanup.
- Open-source contribution, security, privacy, support, development, and release documentation.

See the user-facing [v0.1.0 release notes](docs/releases/v0.1.0.en.md) for the initial release details.

Release assets and the local update path still require separate real-network validation. Do not treat this entry as proof of an online automatic-update path until a public upgrade from the prior version has completed successfully.
