# RAG 架构

[简体中文](architecture.md) | [English](architecture.en.md)

## 目标

NamiMail RAG 为已授权邮件提供可引用的本地检索，不建立一个脱离邮箱生命周期的常驻向量服务。它不替代 IMAP 同步或邮件数据库，也不把检索命中当成写入授权。

## 组成

```mermaid
flowchart LR
  Mail["本地邮件状态事务"] --> Outbox["来源事件 Outbox"]
  Outbox --> Worker["受代际围栏的索引工作者"]
  Worker --> Clean["清洗"]
  Clean --> Chunk["确定性分块"]
  Chunk --> Pages["加密 RAG 页面"]
  Pages --> Memory["内存词法索引"]
  Query["授权查询"] --> Memory
  Memory --> Cite["来源引用"]
```

| 层 | 持久化 | 关键边界 |
| --- | --- | --- |
| 邮件主数据 | 既有邮件 SQLite | 仍由 IMAP/邮件服务拥有 |
| 来源事件 | Agent SQLite Outbox | 与本地邮件状态在同一事务入队 |
| RAG 页面 | 每账号 DEK 加密 | 可由来源事件重建 |
| 词法索引 | 仅内存 | 不存储为第二个明文或独立向量库 |
| 引用 | 结构化元数据/必要片段 | 回链到受授权的邮件或页面 |

## 账户隔离

每个页面携带 `account_id`、`account_generation`、页面 ID、修订、状态、内容摘要和加密 payload。查询、工作者、会话和引用均需要当前代际。账户删除推进 generation、取消旧任务并丢弃 DEK 后，旧页面即使物理文件仍存在也不可解密。

## 当前实现与验证边界

清洗、分块、加密页面存储、来源事件、代际生命周期、引用与词法检索已有可单测实现。当前常规 server/runtime 还会启动 `AgentService` 及其 RAG 工作者，并由既有同步/邮件状态路径写入消息来源事件；嵌入式 GUI 查询路径会使用这些检索结果。当前没有生产语义/embedding 索引，也没有附件正文摄取。该接线存在于当前源码，但尚不是发布级用户功能证明：同一版本仍必须完成打包桌面版、真实账户/Provider、删除与重建生命周期和安全确认流验证。

## 非目标

- 不另启浏览器可访问的 RAG HTTP 服务。
- 当前没有 embedding 流程；未来任何云端相关内容都必须另行同意。
- 不保留与账户 DEK 生命周期无关的长期明文、向量或附件副本。
- 不用检索结果绕过账户范围、邮件状态或用户确认。

参见 [摄取](ingestion.md)、[检索](retrieval.md) 和 [一致性](consistency.md)。
