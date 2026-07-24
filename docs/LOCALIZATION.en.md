# Localization Guide

[简体中文](LOCALIZATION.md) | [English](LOCALIZATION.en.md)

This guide defines the localization conventions for Nami Mail UI copy and repository documentation. Email subjects and bodies, senders, recipients, attachment names, and user-created folder names are user data. Do not translate them or put them into a locale pack.

## UI Language Packs

UI packs live in `apps/web/src/locales/*.json`. They are auto-discovered at build time with `import.meta.glob`; the app does not load language packs from a user's disk, a network URL, or arbitrary uploads at runtime.

Every file must be valid JSON with this shape:

```json
{
  "meta": {
    "locale": "en-US",
    "nativeName": "English (United States)"
  },
  "messages": {
    "settings.language": "Language",
    "mail.unreadCount": "{count} unread"
  }
}
```

- `meta.locale` must use a canonical BCP-47 language tag and be unique across locale packs. The filename must match it exactly: `en-US.json` must contain `"locale": "en-US"`; aliases such as `en-us` and surrounding whitespace are rejected.
- `meta.nativeName` is the language's native display name for the language picker.
- `messages` uses flat, dot-separated keys. Keys describe stable product meaning, not the current Chinese or English sentence.
- Keep `{name}` placeholders with the same name and meaning in every language. Do not rely on string concatenation to form sentence order.
- `zh-CN` is the required fallback pack and the baseline for new keys. Every non-`zh-CN` pack must have exactly the same key set as the baseline: no missing keys, no undefined extra keys, and no changed placeholder names for any key.

### Runtime Fallback And CI / Release Validation

The runtime `zh-CN` fallback protects language resolution and individual copy lookups in a shipped app, so a supported language cannot turn a user-facing surface into a blank value. It is not an acceptance rule for incomplete locale packs and must not become the normal way missing translations are displayed.

Merge and release validation is stricter. `scripts/build-locale-catalog.mjs` checks canonical locale identifiers, duplicate canonical identifiers, and the required `zh-CN` pack, then compares every non-baseline pack's complete key set and placeholder names. Pull-request validation runs `node scripts/build-locale-catalog.mjs --check`; desktop and server builds, typechecks, and tests run the same validation. Any missing or extra key, placeholder-name drift, non-canonical locale, or stale generated catalog blocks CI / release.

## Add a UI Language

1. Add a JSON file under `apps/web/src/locales/`, named clearly for its locale, for example `ja-JP.json`.
2. Copy the complete `zh-CN` key set, then provide `meta` and translations while preserving variables, HTML semantics, and product names that must not be translated.
3. Add tests or manual checks for long text, plural forms, dates, relative time, and narrow-window layout. Do not rely on a static screenshot alone.
4. Run `node scripts/build-locale-catalog.mjs --check`, the project's Web tests, typecheck, and build. A new language is ready only when its JSON is valid, its key set exactly matches `zh-CN`, its placeholder names match, and the build succeeds.

Locale packs ship with an application build. A new JSON file appears in the app after it is added and rebuilt; it is not a runtime plug-in that end users can install without a release.

## Native And Server Copy

The same JSON locale packs also provide copy for Electron native UI and narrowly scoped server pages. `scripts/build-locale-catalog.mjs` validates the packs in a stable order and generates these version-controlled build artifacts:

- `apps/desktop/src/native-locale-catalog.generated.mts`: only `native.*` keys for tray menus, the close prompt, system notifications, and startup-failure messaging;
- `apps/server/src/locale-catalog.generated.ts`: only server-safe `oauth.callback.*` keys for the OAuth callback completion page.

Do not edit generated files manually. After adding a locale pack or changing these native/server keys, run `node scripts/build-locale-catalog.mjs`, then `node scripts/build-locale-catalog.mjs --check`, followed by the relevant app typecheck and tests. The generator validates the complete web catalog before exporting the small native/server subsets, so a missing, redundant, or placeholder-invalid web key is rejected by the non-renderer CI gate as well. `--check` also confirms that the version-controlled generated catalogs are current.

The generator deliberately does not export the full web copy catalog or read user disks, networks, or email data. Only reviewed `native.*` and `oauth.callback.*` copy may reach non-renderer processes; mail content and other user data are never translation resources.

## Documentation Languages

Existing Chinese paths without a suffix remain stable entry points, such as `README.md` and `docs/INSTALLING.md`. English translations use an adjacent `.en.md` file, such as `README.en.md` and `docs/INSTALLING.en.md`, so existing Chinese links do not need to move.

When adding another documentation language:

1. Use a language suffix in the source document's directory, for example `INSTALLING.ja-JP.md`.
2. Add a short two-way language switch directly below the title in both source and translation.
3. Keep version numbers, commands, asset names, paths, link targets, and security boundaries exact when translating user-facing security, privacy, installation, provider, and release documentation.
4. When a behavior claim, procedure, or link changes in one language, check its published counterparts in the same change.
5. Keep the Chinese `CHANGELOG.md` as the authoritative version history. When publishing an English or other-language translation, update it in the same change and identify the Chinese original as the source of version facts. Maintain each user-facing release note in every published language.

Do not interleave large bilingual sections in one Markdown file. Adjacent translations preserve clean heading anchors, links, and GitHub reading flow while sharing icons, screenshots, and other binary assets.
