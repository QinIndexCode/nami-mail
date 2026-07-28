# Documentation

[简体中文](README.md) | [English](README.en.md)

Nami Mail currently ships a Windows x64 desktop app. This page organizes the public documentation by task. See the [localization guide](LOCALIZATION.en.md) for UI language packs and documentation translations.

> **Agent interface status: unavailable in this build.** This build does not ship a verifiable native Windows SID-DACL named-pipe adapter, so it provides no external AgentHost, Broker, `namimail` command, PATH shim, client-pairing UI, or MCP stdio launcher. The protocol, schema, and workflow material in the CLI, MCP, and Agent documentation is a future-release security contract and cannot be configured or run today. Experimental local NLLB-200 translation remains separate and is still opt-in through the UI.

## Use Nami Mail

- [Windows installation and updates](INSTALLING.en.md): trusted downloads, installation, updates, uninstallation, and SmartScreen guidance.
- [Email provider setup](EMAIL-PROVIDERS.en.md): OAuth, app passwords, manual IMAP/SMTP setup, and connection troubleshooting.
- [Message translation](TRANSLATION.en.md): optional LibreTranslate-compatible configuration, explicit-send boundary, and privacy considerations.
- [NamiMail Agent](agent/architecture.en.md): the local-first Agent design, current unavailable boundary, and future security contract.
- [Mail RAG](rag/architecture.en.md): ingestion, cleaning, retrieval, deletion synchronization, and consistency.
- [CLI](cli/README.en.md): a future read-only contract for scripts and local Agents; unavailable in this build.
- [MCP Server](mcp/README.en.md): a future local MCP stdio contract; unavailable to configure or start in this build.
- [Privacy and local data](PRIVACY.en.md): local data, encryption boundaries, and third-party connections.
- [Support guide](../SUPPORT.en.md): suitable public reports, redaction requirements, and support boundaries.
- [Security policy](../SECURITY.en.md): the public route for reporting security issues privately.
- [Release notes](releases/README.en.md): user-facing release information and known limitations.

## Contribute

- [Contributing guide](../CONTRIBUTING.en.md): local development, testing, pull requests, and review requirements.
- [Code of conduct](../CODE_OF_CONDUCT.en.md): collaboration rules and reporting conduct issues.
- [Development guide](DEVELOPMENT.en.md): run modes, directories, and the validation baseline.
- [Architecture and trust boundaries](ARCHITECTURE.en.md): process, data, and update boundaries.
- [Windows release guide](RELEASING.en.md): maintainer steps for signing, releases, and real update verification.
- [Agent implementation plan](development/implementation-plan.en.md): module ownership, phases, acceptance criteria, and rollback boundaries.

## Languages and Versions

- [Localization guide](LOCALIZATION.en.md): rules for new UI JSON packs and documentation translations.
- [Changelog](../CHANGELOG.en.md): the English translation of the version history; [the Chinese original](../CHANGELOG.md) remains authoritative.
