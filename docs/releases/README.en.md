# Release Notes

[简体中文](README.md) | [English](README.en.md)

This directory contains reviewable, reusable GitHub Release bodies. Every release note should serve real users rather than copy build logs, CI output, or internal environment variables.

- [v0.1.0](v0.1.0.en.md) is the ready-to-paste text for the first public release.
- [v0.1.2](v0.1.2.en.md) is the current ready-to-paste release note and records the real online automatic-update verification that remains outstanding.
- [v0.1.1](v0.1.1.en.md) corresponds only to an unpublished source tag and must not be used as an installation or automatic-update source.
- [v0.1.1 candidate](v0.1.1-candidate.en.md) remains a pre-release checklist and must not be used as the published Release body.

## Rules of Use

1. After filling in the version title on GitHub Releases, copy the body from the matching note. Do not put private keys, certificates, tokens, test accounts, or local paths in Release Notes.
2. Before describing signature status or known limitations, confirm that the Release page has exactly the five required assets and that the version tag matches the installer name.
3. Do not write that online automatic-update verification is complete in the next note until [real post-release update verification](../RELEASING.en.md#real-post-release-update-verification) is complete and reviewable evidence is retained.
4. If assets, signing, a version, or the update manifest changes, withdraw or mark the Release first, then repeat release verification. Do not silently replace assets while retaining the old notes.

Users should always download `Nami Mail Setup <version>.exe` from a Release. Versioned ZIPs, JSON manifests, `latest.yml`, and `.blockmap` are internal release and automatic-update assets, not manual installers.
