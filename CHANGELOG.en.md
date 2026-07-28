# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

This is the English translation of the Chinese source changelog. `CHANGELOG.md` remains the authoritative version history. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories and Semantic Versioning.

## [0.2.1] - 2026-07-28

### Added

- Added the experimental embedded NamiMail Agent workspace, with OpenAI-compatible or Ollama provider configuration and local lexical retrieval with citations inside an explicit account scope.
- The Agent can read accounts, folders, messages, threads, and attachment metadata, and can create, edit, or delete drafts. Provider settings are available from both Agent and Settings.

### Improved

- Refined sidebar navigation: All accounts has a distinct aggregation icon, sending status has its own status icon, and system folders use icons that reflect their actual purpose.
- Strengthened account selected, hover, and keyboard-focus states without a left-side accent strip. Account and folder regions now scroll independently when space is constrained while keeping Settings and local-encryption status reachable.
- Tightened public Agent/RAG boundaries to state the actual status of lexical retrieval, attachment-body ingestion, and external interfaces.

### Fixed

- Fixed the nested Windows release-smoke timeout race so a cold-start failure retains an actionable desktop diagnostic.
- Fixed the case where pressing `Esc` on an expanded themed select in Settings could also close the Settings dialog.

### Documentation

- Added publishable [v0.2.1 release notes](docs/releases/v0.2.1.en.md) and maintained the paired Chinese note.
- Changed download guidance to refer to the Windows `.exe` installer displayed on the Release page, avoiding confusion between local build filenames and remote asset display names.

## [0.2.0] - 2026-07-28 (unpublished)

`v0.2.0` remains only an unpublished source tag whose release validation did not complete. It has no public GitHub Release or update assets and must not be used as an installation or automatic-update source; its user-visible changes continue in `0.2.1`.

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
