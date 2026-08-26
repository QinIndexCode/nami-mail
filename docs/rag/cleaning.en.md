# RAG Cleaning

[Chinese](cleaning.zh-CN.md) | [English](cleaning.en.md)

## Principle

Cleaning creates a retrieval copy only. It never changes original encrypted mail, renders HTML, or executes its resources. It prefers meaningful `textBody` and converts constrained HTML to text only when plain text is absent. Output records version, source, truncation, removed quotes/signatures, and a content hash.

## Current cleaning pipeline

1. Normalize line endings, Unicode NFC, and control characters.
2. For HTML, remove scripts, styles, forms, iframes, embedded objects, SVG, images, hidden nodes, comments, and tags while retaining readable block/table/list text.
3. Decode constrained HTML entities and remove common tracking parameters.
4. Remove quote boundaries, `>` quotations, obvious signatures, and Chinese/English confidentiality notices.
5. Normalize whitespace and adjacent duplicate paragraphs, then truncate at a natural boundary where possible.
6. Hash final text rather than treating raw HTML or external links as semantic content.

The cleaner does not guarantee removal of every disclaimer or injection string. Its security role is to reduce and normalize context; models must still treat output as untrusted mail data.

## Versions and change

`MAIL_CLEANER_VERSION` is part of RAG-page reproducibility. A rule, maximum-length, or parser behavior change needs a version bump, controlled backfill, and comparable old/new tests. Do not silently overwrite existing pages with new rules without updating revision/digest.

## Test boundary

Cover plain-text preference, hostile HTML, hidden text, CJK, long content, quotations, signatures, tracking URLs, invalid Unicode, and empty bodies. Fixtures must not contain real mail, credentials, or attachments.

See [Security](../agent/security.en.md) and [Chunking](chunking.en.md).
