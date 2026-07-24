# Contributing Guide

[简体中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

Thank you for helping improve Nami Mail. This project handles real email, account credentials, and local caches. Every contribution must put user-data boundaries, recoverability, and verifiability ahead of feature speed.

## Before You Start

- Read the [README](README.en.md), [Privacy and Local Data](docs/PRIVACY.en.md), [Security Policy](SECURITY.en.md), [Code of Conduct](CODE_OF_CONDUCT.en.md), and [Localization Guide](docs/LOCALIZATION.en.md) before contributing.
- Do not open a public issue for a vulnerability, credential exposure, or a path that could read another person's email. Report it privately through the process in [SECURITY.en.md](SECURITY.en.md).
- Never commit real mail, attachments, complete addresses, OAuth callback parameters, access tokens, app passwords, `.env`, or anything under `data/`. Redact screenshots and logs used for reproduction.
- For substantial changes to a provider, sync semantics, encryption format, database migration, OAuth permissions, or automatic updates, describe the problem and approach first, confirm the scope, then implement.

## Local Development

The project requires Node.js 22.14.0 or later. Run the following from the repository root:

```powershell
npm.cmd ci
npm.cmd run dev
```

Development mode uses the Vite frontend (normally `http://127.0.0.1:5173`) and a local Fastify service. To run the built local service:

```powershell
npm.cmd run build
npm.cmd start
```

Start the Windows desktop shell with:

```powershell
npm.cmd run dev:desktop
```

Copy [`.env.example`](.env.example) to `.env` before filling in only the local development configuration you need. Google and Microsoft configuration accepts public client IDs only. Do not put a client secret in that file or in any issue.

Use the project scripts to verify the real Node and Electron loading paths. Do not run a general `npm rebuild` beside a running desktop app:

```powershell
npm.cmd run verify:node-sqlite
npm.cmd run verify:electron-sqlite
```

See the [Development Guide](docs/DEVELOPMENT.en.md) for layout, testing, and packaging details.

## Making Changes

1. Keep changes focused. Do not reorder unrelated code while fixing one UI or copy issue.
2. Add targeted tests for new behavior. A defect fix should first have a test that reproduces the defect.
3. For UI interactions, check focus, keyboard operation, text overflow, themes, and accessible names in at least a desktop and narrow window.
4. Treat mail content as untrusted input. Do not weaken HTML sanitization, remote-resource restrictions, local API access-token controls, or cache policies.
5. For local storage changes, remain compatible with existing databases and encrypted payloads. Every migration must be detectable, retryable, and must not rewrite sensitive fields as plaintext.

Before opening a pull request, run at least the checks relevant to the change. The full baseline is:

```powershell
npm.cmd run build:brand:check
npm.cmd run typecheck
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run build
npm.cmd run smoke:runtime
```

See the [Release Guide](docs/RELEASING.en.md) for additional Windows installer, signing, and release steps.

## Forks and Pull Requests

1. Fork the upstream repository and create a clearly named feature or fix branch from the latest `main`. Do not push commits directly to upstream `main`.
2. Commit focused changes in your fork. Do not push `.env`, test accounts, OAuth callback parameters, tokens, app passwords, certificates, build artifacts, or local data.
3. Run the complete local checks below before submitting. They match the commands used by GitHub's `Validate Pull Request / validate`. For documentation-only changes, run the relevant checks at minimum and state any checks not run in the PR.
4. Open a pull request against upstream `main`. Use the template to describe the related issue, user-visible changes, validation evidence, and remaining risks. Validation workflows from forks use read-only tokens and cannot read release or signing credentials. Do not ask a PR workflow to expose those credentials.
5. Wait for `Validate Pull Request / validate` to pass before requesting review. The current `main` rules require a PR, resolved discussions, at least one valid approval, and `validate` based on the latest `main`. New commits dismiss prior approvals. `.github/CODEOWNERS` routes PRs to maintainers automatically, but it does not replace remote rules or human review. Regular collaborators cannot push directly or force-push. Administrators should bypass the rules only in an emergency and leave an auditable follow-up PR.

Complete local checks:

```powershell
npm.cmd ci
npm.cmd run build:brand:check
node --test scripts/release-policy.test.mjs
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run smoke:runtime
npm.cmd audit --omit=dev --audit-level=high
```

## Pull Request Requirements

- Use the repository PR template and describe user-visible changes, validation, and risks not covered.
- Include redacted screenshots or recordings for UI changes, and name the window sizes and themes checked.
- For mail-provider changes, document the provider, authentication method, server protocol, and test conditions. Never upload real account information.
- Explain dependency changes, license impact, and the source of security updates.
- Update README, privacy, security, or release documentation only when the actual behavior changes.

Maintainers will focus on data safety, error recovery, compatibility, and reproducible validation, not merely whether a screen renders.

## Review and Merge

- Reviewers should verify that the linked issue, user impact, test results, and uncovered risks in the PR description match the change. Green CI does not replace a real check of a mail provider, OAuth, or installation/update path.
- Before merging, confirm `validate` is still successful for the current PR commit, all discussions are resolved, and no approval was dismissed by a later commit. If rebasing on `main` is required, update the branch and wait for checks and approval again.
- Do not give release credentials, signing material, production accounts, or real user data to a PR workflow. Releases are made only by protected tag workflows in the release environment.
