# 0004: Recovery, portable backups and mail image authorization

[简体中文](0004-recovery-backup-image-privacy.zh-CN.md) | [English](0004-recovery-backup-image-privacy.en.md)

Status: accepted, 2026-11-07. Scope: local mail client. Microsoft OAuth configuration is excluded.

## Context

Durable task results need user recovery actions. The EML ZIP export cannot restore application data. An image proxy still contacts sender-controlled unique URLs, so authorization must precede that contact.

## Decisions

- Retry unfinished flags/move items through existing acceptance functions with current identity checks; retain the original task. Never automatically resend unknown delivery. Recover send content from the sealed request and report unavailable attachments explicitly.
- Keep EML export and add an authenticated portable application format: fixed-cost scrypt plus ordered AES-256-GCM frames, an authenticated end marker, a SQLite snapshot, the data key and referenced outbound attachments/background. Accept only application-owned file paths.
- Validate restores in isolated generation directories and activate only after preview and explicit confirmation, on next startup. Protect the generation pointer and data key with the existing host key; keep DPAPI and the running database untouched. Retain the old generation.
- Stop restored unfinished remote writes, mark unresolved sends for verification, and disable automatic replies and filters to prevent replaying external effects from an old snapshot.
- Store a separate sealed image policy: block by default, allow one message, trust an exact sender address and revoke authorization. Add message identity to existing proxy rewriting and enforce policy again on the server. Preserve inline images.

## Consequences and boundaries

Activation requires an application/service restart. The snapshot includes local database contents, not undownloaded provider attachments, logs, temporary image caches, desktop pairing credentials or renderer preferences. A lost backup password cannot be recovered. The UI describes scope, version, counts and paused work. File/request budgets are explicit; fixtures are isolated.

## Validation

Cover wrong passwords, tampering, truncation, unsafe paths, cross-key restore, restart activation, preservation of the original store, paused sends, retry content/attachment recovery, stale targets, and zero upstream image requests before authorization or after revocation.
