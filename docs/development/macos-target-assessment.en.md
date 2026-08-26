# macOS Target Assessment

[简体中文](macos-target-assessment.zh-CN.md) | [English](macos-target-assessment.en.md)

> This document assesses extending Nami Mail from its current Windows-only support to macOS (arm64 / x64). It states only the current state verifiable in the code and the work that would need to be added; it does not present "feasible" as "done".

## Conclusion

macOS is a separate engineering workstream, not a simple electron-builder target switch. The current desktop updater, Broker secure channel, and install/release pipeline are Windows-specific; native dependencies must be rebuilt for darwin. Until an Apple Developer certificate is available, the signing/notarization chain is completed, and the Broker channel is reworked, a macOS build should not be declared a supported target. This report explicitly records the item as **out of scope** (when resources do not allow it) and provides the acceptance checklist required to restore the target.

## Verified current platform posture

The following facts come from the current source (apps/desktop, apps/web, package.json):

| Component | Current state | Platform |
| --- | --- | --- |
| Data directory | `data/` under `app.getPath("userData")`; credentials encrypted with Electron `safeStorage` | Cross-platform |
| Desktop updater | `updater.mts` returns `unavailable/platformUnsupported` when `platform !== "win32"` | Windows only |
| Update installer | `zip-update-installer.mts` depends on Windows file-lock semantics (rstrtmgr) and NSIS silent upgrade | Windows only |
| Broker secure channel | `secure-pipe-relay.mts` uses current Windows user SID-DACL named pipes; `nami-agent-pipe.ps1` is a PowerShell pipe helper | Windows only |
| CLI integration | `namimail.cmd`, `namimail-path.ps1` (PATH shims); packaging targets NSIS `installerLanguages: zh_CN` | Windows only |
| Installer | electron-builder `win.target: nsis`, `signExecutable: false` (signing requires an external certificate and `CSC_*` environment variables) | Windows only |
| Native dependencies | `better-sqlite3` (must be rebuilt for darwin); `sharp` currently pinned to `@img/sharp-win32-x64` | Windows package |
| Notification sound | `playCustomNotificationSound` already has a `darwin` branch (`afplay`) and a Linux fallback (`aplay/paplay`) | darwin branch exists |
| Localization | UI i18n uses the local locale catalog (zh-CN/en-US); the NSIS installer language is zh_CN only | UI is cross-platform |

## Work required to add macOS support

1. **Native dependencies**: rebuild `better-sqlite3` for macOS arm64 and x64; add `@img/sharp-darwin-arm64` / `@img/sharp-darwin-x64` for `sharp`; update `asarUnpack` and `npmRebuild` configuration.
2. **Broker secure channel**: named pipes + SID-DACL are Windows-specific. macOS needs a Unix Domain Socket with file/socket permissions or peer-credential checks providing the same "current user only" guarantee, preserving the invariant "refuse to start when a secure channel cannot be established; never fall back to TCP/HTTP".
3. **CLI and updates**: `namimail` needs a macOS equivalent (e.g., a `bin` symlink or shell wrapper); the updater must drop the `platform !== "win32"` gate and implement an install path for `.zip`/`.app` replacement (rather than NSIS silent upgrade); the Windows file-lock cleanup logic in `zip-update-installer` must be reworked for macOS semantics.
4. **Signing and notarization**: an Apple Developer ID Application certificate is required, with `mac.notarize`, hardened runtime, and entitlements configured in electron-builder; Gatekeeper requires notarization before users can open the app, which is a trust system independent of Windows SmartScreen.
5. **Credentials and notifications**: `safeStorage` uses the Keychain on macOS; Keychain access for account credentials must be verified (including behavior when unlocked); macOS notification permission must be requested.
6. **Release pipeline**: add `dmg`/`zip` targets, `latest-mac.yml` update-manifest generation, and the corresponding smoke acceptance; the release checklist must cover both platforms.

## Acceptance checklist (if the target is restored)

- [ ] `npm run package:mac` produces `dmg` + versioned ZIP + `latest-mac.yml` for both macOS arm64 and x64.
- [ ] The signed package passes `spctl --assess` and notarization verification (`stapler validate`).
- [ ] The Broker implements "current user only" over a non-Windows channel, and the macOS equivalent of `secure-pipe-relay.windows.test.ts` passes.
- [ ] The desktop updater completes and records one real "old → new" update acceptance on macOS.
- [ ] All smoke items (macOS equivalents of desktop/package/installer) pass.

## Scope statement

Until an Apple Developer certificate, a notarization account, and a macOS build machine are available, the macOS target assessment stays at this document; macOS is not claimed to be supported, and no macOS download appears in the Release notes.
