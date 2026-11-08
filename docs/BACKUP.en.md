# Application backup and restore

[简体中文](BACKUP.zh-CN.md) | [English](BACKUP.en.md)

Settings → Data and privacy provides password-protected `.namibak` snapshots. Existing EML ZIP export remains available for original-message export and does not restore the application.

## Scope

Includes local database mail bodies and metadata, accounts and credentials, contacts, calendar, templates, filters, settings, Agent configuration, conversations and memory, plus referenced local outbound attachments and custom backgrounds. Undownloaded incoming attachments remain with the provider. Logs, temporary image caches, desktop pairings and renderer preferences are excluded.

Backups contain sensitive credentials. Use at least 12 password characters and repeat the password for export; store the password separately. Lost passwords cannot be recovered. Limits: 3 GiB and 20,000 files. Browser downloads retain the complete file in memory; large backups need sufficient memory. SQLite snapshot creation can briefly occupy the local service.

## Export and restore

1. Enter and repeat a password, then download the `.namibak` file.
2. In this installation or a fresh installation on another machine, select the file, enter its original password and validate the preview. Validation failures leave current data unchanged.
3. Check the timestamp, database schema and data counts, then explicitly confirm activation.
4. Fully quit and reopen the desktop app, or restart the local service in browser development mode. Startup selects the validated isolated generation and retains the previous data.

Restore switches the complete application snapshot rather than merging databases. Changes made in the old database after confirmation are not carried over: back up the current state first and restart promptly. Closing a preview attempts to remove inactive staging data; activated generations are retained.

## External operations after restore

Unfinished remote tasks stop. Pending or submitting sends require delivery verification in the provider Sent folder and are never automatically resent because of restore. Automatic replies and filters are disabled until reviewed and re-enabled. Previously submitted sends retain their recorded result, which describes the backup time.

## Encryption and migration

Fixed-cost scrypt derives the password key; ordered AES-256-GCM frames and an authenticated end marker protect contents and completeness. Both the encrypted database and its data key are inside the password-protected file. Import protects the data key and startup pointer with the target installation host key without copying or replacing its Windows DPAPI record. The new machine does not need the original Windows user's DPAPI context. Original data and previous restore generations remain sensitive retained data.

See [ADR 0004](development/decisions/0004-recovery-backup-image-privacy.en.md).
