# CLI 权限与安全

[English](permissions.en.md) | [MCP 安全](../mcp/security.md)

> **未来契约，当前不可执行。** 当前构建没有外部 CLI、Broker、配对记录或客户端权限授予。以下默认拒绝、scope 和审计要求在验证过的 Windows SID-DACL 原生适配器发布后才适用于外部接口；当前构建在该入口前失败关闭。

## 默认拒绝

未来外部 CLI 的 v1 access level 将为 `read-only`。Broker 将在每个请求中建立不可由命令行伪造的调用方上下文，包括客户端身份、入口 `cli`、批准 scope、账户范围、交互能力和请求 ID。Tool Registry 与 Permission Engine 将在访问邮件服务前再次校验这些字段。

| access level | 允许的工具模式 | CLI v1 状态 |
| --- | --- | --- |
| `read-only` | `read` | 发布后的唯一外部模式。 |
| `draft-only` | `read`、`draft` | 仅为桌面 UI 预留。 |
| `mail-write` | 读、草稿、一般写入 | 仅为桌面 UI 预留。 |
| `send-confirmed` | 含高风险操作 | 仅为桌面 UI 预留，仍需确认。 |
| `full-access` | 管理能力 | 不授予外部 v1 CLI。 |

常见 scope 有 `read:accounts`、`read:folders`、`read:messages`、`read:attachments` 和 `read:rag`。更高权限 scope 如 `write:drafts`、`write:mail`、`send:mail`、`manage:rag`、`external:network` 或 `admin:host` 不会让外部 v1 CLI 获得写能力。

## 账户范围

未来配对记录可允许所有账户、选定账户或无账户。任意请求的账户 ID 都必须属于该范围：

- 无账户范围读取账户数据会被拒绝。
- 选定范围不能通过省略 `--account`、传递多个 ID 或构造位置参数扩大。
- 删除账户会使其 Agent 生命周期代际失效，旧上下文和旧确认不能复用。

## 可见确认

发送、回复、转发、永久删除、批量移动/状态/标签变更、上传邮件内容和外部网络调用需要 NamiMail 可见窗口中的一次性、不可变确认。确认包含摘要、字段预览、账户、内容 SHA-256 摘要、到期时间和单次消费约束。

外部 CLI 不可请求、批准、复用或伪造该确认。`--yes` 仅是参数，不是授权令牌。

## 传输与审计

- 发布后的 Windows AgentHost 必须先取得只允许当前用户 SID 的独占命名管道租约，再打开 Runtime 或数据库。
- 发布后的客户端请求和宿主响应均必须使用 Ed25519 签名。请求绑定当前 `bootId` 和严格递增的持久化计数器，防止重放。
- 发布后的 Broker、CLI 与 MCP 绝不接受渲染器 Fastify token，也不允许 HTTP、TCP、SQLite 或文件系统降级路径。
- 审计记录 `requestId`、调用入口、工具、账户范围、权限决定、结果和受限摘要；不记录邮件正文、附件内容、OAuth token、API key、邮箱密码或私钥。

邮件与附件始终是外部不可信数据。它们可作为受限上下文，但不会成为系统指令或工具授权。
