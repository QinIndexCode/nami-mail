# Privacy and Local Data

[简体中文](PRIVACY.md) | [English](PRIVACY.en.md)

This document describes how the current Nami Mail code paths handle data. It does not replace the privacy policies of your mail provider, OAuth provider, GitHub, operating system, or enterprise administrator. Nami Mail is designed to be local-first: the project does not operate a hosted mail backend.

## Where Data Goes

The current code connects to third-party services only when needed:

- your configured mail provider, for IMAP retrieval and synchronization, SMTP sending, drafts, flags, and attachments;
- DNS, for provider discovery on custom domains;
- Google or Microsoft, only when you choose their OAuth sign-in, for authorization, token refresh, and the related mail permissions;
- your configured Agent model provider, only after you explicitly enable **Allow mail content to cloud models** for a remote Provider in Agent settings. The Agent can then send the current prompt, the necessary excerpts retrieved from the selected mail scope, and earlier turns in the current conversation that already contain mail context. An excerpt can include a subject, sender, timestamp, and cleaned body excerpt. This switch is off by default and stored per Provider. Turning it off or revoking consent stops future retrieval excerpts and prevents prior conversation turns marked as mail-context-bearing from being sent again. It cannot retrieve data a Provider received earlier; that Provider's own policy governs its handling. Nami Mail does not operate the model service or use it as a hosted mail backend. Loopback Ollama is not remote egress under this rule;
- your configured LibreTranslate-compatible translation service, only in a runtime that has not injected local translation and when you explicitly select message-body translation, for the current message's plain-text body. Nami Mail does not translate automatically or switch services automatically. The service address, timeout, and optional API key are encrypted on this device, and translation results are not persistently cached. See [message translation](TRANSLATION.en.md).
- NLLB-200 model assets, when the Windows desktop app first uses experimental local translation. The translation runtime can download the model assets needed for `Xenova/nllb-200-distilled-600M` into an on-device cache. This network request does not include mail body content; the body is then processed by the local model and is not sent to a translation endpoint. The model-asset cache is not a mail-body or translation-result cache;
- GitHub Releases, only when an installed desktop build with update configuration and a valid trust root checks or downloads an update. Update checks read public Release metadata only. The app downloads a versioned ZIP and JSON manifest only after you choose to update; it does not upload mail credentials, mail content, the local database, or a GitHub access token.

The codebase currently contains no Nami Mail analytics SDK, crash-reporting service, or centralized mail API. This does not mean that third-party services, networks, proxies, security software, or operating systems cannot record network metadata; their own policies apply.

## Local Data

| Data category | Storage and treatment |
| --- | --- |
| Account credentials and OAuth refresh tokens | Stored with application-layer AES-256-GCM encryption derived from the master key. Access tokens stay in runtime memory only. |
| Sensitive mail payload | Message-ID, subject, addresses, preview, body, reply thread, and attachment metadata are stored in encrypted payloads. |
| Outbound queue and outbound attachments | Subject, recipients, body, diagnostics, and attachment content are encrypted with separate purpose-derived keys. |
| Received attachment content | Not copied into the local SQLite database; it is streamed from the mail provider under control when you download it. |
| Agent Provider, conversations, and RAG pages | Provider configuration, including an optional API key, is encrypted under the root key. Conversation records, source citations, and cleaned local RAG chunks are encrypted under the corresponding account data key. On first enablement, cached local mail is indexed through a bounded background queue. This neither rewrites original mail nor sends mail to a model provider merely because it is indexed. |
| Local NLLB-200 model assets | Used only by the Windows desktop app and cached under Electron's user-data `translation-models` directory. These are local machine-translation model files, not mail bodies or translation results; deleting user data removes them too. |
| Runtime metadata | Account addresses/providers, folders, UIDs, timestamps, flags, sizes, delivery states, record identifiers, ordinary settings, and background images can remain in plaintext. |

For the Windows desktop app, Electron `safeStorage` protects the master key with the current Windows user's DPAPI. The file is in the user data directory at `data/master.key.dpapi`. The desktop app does not fall back to creating a new plaintext master key. The command-line development service is different: it uses a separate development data path from `MASTER_KEY_PATH` and is not equivalent to desktop DPAPI protection.

This is not SQLCipher or full-disk encryption. Application-layer encryption reduces the risk of reading static files directly or copying them offline, but it cannot defend against an administrator, a malicious process able to call DPAPI as the same Windows user, or an already unlocked and running app.

## Local and UI Protections

- The local service binds to `127.0.0.1` by default. The desktop app uses a dynamic loopback port and a local API access token regenerated on every launch.
- Local API responses use `no-store`; desktop startup clears any HTTP or Service Worker cache that could retain mail responses.
- Mail HTML is sanitized before display to remove untrusted scripts, forms, embedded content, and images. This is not an absolute guarantee of mail safety.
- `.gitignore` excludes `.env`, databases, keys, mail exports, logs, and release output. Ignore rules do not replace human review before committing.
- Downloaded update ZIP files are temporarily stored in the current Windows user's app data directory. Skipping a version removes its cache. After a successful install, the updater makes bounded retry and existence checks for the ZIP and temporary extraction directory. If leftovers remain, the next version makes another best effort only in that target-version directory and shows status. Other processes on the system or under the same user can still lock or rename files, so do not treat the cache as long-term backup storage and do not describe cleanup as an absolute guarantee.

## Data Control and Backups

- Before removing an account, discarding a draft, or deleting local data, understand the local and remote effects in the UI. Nami Mail should not delete mail held by the provider unless you explicitly perform the corresponding remote mail action.
- Windows uninstallation retains user data by default. Choosing to delete data removes `%APPDATA%\Nami Mail`. Back up required data first.
- DPAPI protection is bound to the current Windows user context. When backing up or moving a data directory, consider whether the original Windows account can still unlock the protected master key.

If you discover data transfer, storage, or permission behavior that contradicts this document, report it privately through the [security policy](../SECURITY.en.md).
