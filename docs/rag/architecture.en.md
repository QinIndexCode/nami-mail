# RAG Architecture

[Chinese](architecture.zh-CN.md) | [English](architecture.en.md)

## Goal

NamiMail RAG provides citeable local retrieval over authorized mail. It does not create a persistent vector service detached from the mailbox lifecycle, replace IMAP sync or the mail database, or treat a retrieval hit as write authorization.

## Components

```mermaid
flowchart LR
  Mail["Local mail-state transaction"] --> Outbox["Source-event outbox"]
  Outbox --> Worker["Generation-fenced index worker"]
  Worker --> Clean["Cleaning"]
  Clean --> Chunk["Deterministic chunking"]
  Chunk --> Pages["Encrypted RAG pages"]
  Pages --> Lexical["SQLite inverted index"]
  Pages --> Semantic["In-memory semantic index"]
  Embed["Default provider embedding endpoint"] -.-> Semantic
  Query["Authorized query"] --> Lexical
  Query --> Semantic
  Lexical --> Cite["Citations"]
  Semantic --> Cite
```

| Layer | Persistence | Key boundary |
| --- | --- | --- |
| Mail primary data | Existing mail SQLite | Still owned by IMAP/mail services |
| Source events | Agent SQLite outbox | Enqueued in the same transaction as local mail state |
| RAG pages | Per-account DEK encryption | Rebuildable from source events |
| Lexical index | SQLite inverted table (inside the Agent store, `agent_rag_index`/`agent_rag_index_stats`) | Derived tokens and tf counts only, no message plaintext; incrementally rebuildable from encrypted pages |
| Semantic index | Memory only | Vectors never persisted; filled only by the user-configured default provider embedding endpoint |
| Citations | Structured metadata/necessary excerpt | Links back to authorized mail or page |

## Account isolation

Each page carries `account_id`, `account_generation`, page ID, revision, state, content digest, and encrypted payload. Queries, workers, conversations, and citations all require the current generation. Account deletion advances generation, cancels old work, and discards its DEK, so old pages cannot be decrypted even if physical rows remain.

## Current implementation and validation boundary

Cleaning, chunking, encrypted page storage, source events, generation lifecycle, citations, lexical retrieval, and optional semantic retrieval have independently testable implementations. The lexical index is persisted as SQLite inverted tables inside the Agent store (`agent_rag_index`/`agent_rag_index_stats`), holding only derived tokens and tf counts with no message plaintext; queries fetch postings per term and score them with BM25, decrypting payloads only for the top candidate pool, and warm-up after a restart backfills only the missing pages instead of decrypting the whole account. Semantic retrieval is driven by the default model provider's embedding endpoint (`openai-compatible`/`ollama` kinds; cloud endpoints require explicit authorization for cloud mail content), and vectors live in memory only. The normal server/runtime also starts `AgentService` and its RAG worker, while existing sync/mail-state paths write message source events and the embedded GUI query path consumes retrieval results. There is no attachment-body ingestion. That wiring exists in the current source, but it is not release-grade user-feature proof: the same build still requires packaged-desktop, real account/provider, deletion and rebuild lifecycle, and security confirmation-flow validation.

## Non-goals

- No browser-reachable RAG HTTP service.
- Semantic retrieval is enabled by authorization: mail text goes only to the user-configured default provider embedding endpoint; local endpoints such as Ollama never egress, and cloud endpoints require explicit authorization for cloud mail content.
- No long-lived plaintext, vector, or attachment copy outside the account-DEK lifecycle.
- No bypass of account scope, mail state, or user confirmation based on a retrieval result.

See [Ingestion](ingestion.en.md), [Retrieval](retrieval.en.md), and [Consistency](consistency.en.md).
