# RAG Chunking

[Chinese](chunking.zh-CN.md) | [English](chunking.en.md)

## Goal

Chunking turns cleaned mail into stable, citeable, budget-bounded retrieval pages. It is not arbitrary character slicing and does not depend on a remote tokenizer for reproducibility; pages serve both lexical retrieval and the optional local semantic index, and semantic embeddings do not change the chunking rules.

## Current rules

- Identify subject, paragraphs, lists, tables, and mixed blocks first.
- Use a local estimate over CJK characters, words, and punctuation for target/maximum token budgets.
- Prefer paragraph and sentence boundaries; split oversized blocks at sentence or safe character boundaries.
- Every block has deterministic `chunkId`, index, kind, text, token estimate, content hash, and `MAIL_CHUNKER_VERSION`.
- `messageId`, source revision, subject, and cleaned text determine page identity; identical input yields identical ordering and hashes.

The current defaults are about 360 target and 520 maximum tokens. This is a local budget, not an exact model-token count; Runtime trims context again for provider-specific limits.

## Subject and citations

A subject can stand alone as a small block or attach to first content for explainable retrieval. Every block maps to message, revision, and chunk index; a citation shows a necessary excerpt rather than a model-invented source.

## Version migration

Changing recognition, budgets, or ID generation changes index semantics. After a `MAIL_CHUNKER_VERSION` bump, write new revisions, run controlled backfill, and retire older active pages in consistency checks. Do not overwrite an old ciphertext record in place while a conversation may cite it.

## What it does not do

It does not auto-translate text before chunking. Experimental NLLB translation remains separate and user-triggered, never an implicit RAG-ingestion step.

See [Retrieval](retrieval.en.md) and [Ingestion](ingestion.en.md).
