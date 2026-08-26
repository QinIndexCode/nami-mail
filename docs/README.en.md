# Documentation

[English](README.en.md) | [简体中文](README.zh-CN.md)

Nami Mail currently ships a Windows x64 desktop app. This page organizes the public documentation by task. See the [localization guide](LOCALIZATION.en.md) for UI language packs and documentation translations.

> **External Mail v1: paired, local, read-only.** CLI and MCP access Nami Mail through a Broker reachable only by the current Windows user; they do not reuse the local Fastify token, provide no HTTP/SQLite fallback, and never write mail. Optional free translation and AI translation remain separate and are opt-in through the UI only.

## Use Nami Mail

- [Windows installation and updates](INSTALLING.en.md): trusted downloads, installation, updates, uninstallation, and SmartScreen guidance.
- [Email provider setup](EMAIL-PROVIDERS.en.md): OAuth, app passwords, manual IMAP/SMTP setup, and connection troubleshooting.
- [Message translation](TRANSLATION.en.md): optional free translation and AI translation configuration, explicit-send boundary, and privacy considerations.
- [Local Mail API contract](LOCAL-API.en.md): the protected protocol between the desktop UI and the local service, translation status, and model-readiness endpoints; not a public network API.
- [External Mail interface](EXTERNAL-MAIL-INTERFACE.en.md): pairing, revocation, eight read-only tools, security boundary, and recovery.
- [NamiMail Agent usage](agent/usage.en.md): conversations, mail scope, source citations, and confirmations.
- [NamiMail Agent model providers](agent/providers.en.md): OpenAI-compatible/Ollama/Claude/Gemini models, API keys, and cloud mail-content consent.
- [NamiMail Agent external MCP servers](agent/mcp-servers.en.md): connecting external MCP servers to extend the assistant's tools.
- [NamiMail Agent architecture](agent/architecture.en.md): the local-first Agent design, embedded workspace, and external Broker boundary.
- [Mail RAG](rag/architecture.en.md): ingestion, cleaning, retrieval, deletion synchronization, and consistency.
- [CLI reference](cli/README.en.md): commands, parameters, output formats, and examples for the `namimail` CLI.
- [MCP Server](mcp/README.en.md): local MCP stdio integration, tool discovery, and security boundaries.
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
- [Changelog](../CHANGELOG.en.md): the English translation of the version history; [the Chinese original](../CHANGELOG.zh-CN.md) remains authoritative.
