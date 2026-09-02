# CLI 权限与安全

[English](permissions.en.md) | [MCP 安全](../mcp/security.zh-CN.md)

> **当前构建状态：已强制生效。** 0.3.0 构建随附外部 CLI、Broker、配对记录和按入口配置的客户端权限授予。下列访问级别、scope 和审计要求适用于外部接口；超过配置级别的请求会失败关闭。

## 访问级别

三个入口各自独立配置访问级别：内置 Agent（`agentAccessLevel`，默认 `send-confirmed`）、外部 CLI（`agentCliAccessLevel`，默认 `read-only`）和外部 MCP（`agentMcpAccessLevel`，默认 `read-only`）。设置项位于桌面应用设置界面的"权限"分组，三个下拉框相邻；CLI 与 MCP 是两项独立设置，但选项内容相同。

对每个请求，Broker 都会建立命令行参数无法伪造的调用方上下文，包括客户端身份、入口（`cli` / `mcp` / `agent`）、批准 scope、账户范围、交互能力和请求 ID。Tool Schema 与 Permission Engine 会在访问邮件服务前再次校验这些字段。

| 档位 | 允许的能力 | CLI v1 状态 |
| --- | --- | --- |
| `read-only` | 仅读取账户、文件夹、邮件、线程和附件元数据。 | 默认档位。 |
| `send-confirmed` | 写操作（草稿创建/更新/删除、移动、标记、发送、回复）每次都在 Nami Mail 桌面端弹出可见确认。 | 可在设置中启用；每次写操作需桌面确认，`--yes` 无法绕过。 |
| `full-access` | 在已批准账户范围内自动执行所有操作（含发送与删除），不再逐项确认。 | 开启前须在 UI 中阅读警告并明确确认；开启后自动执行。 |

宿主为外部 caller 构造访问级别，并按配置档位收紧（clamp）；已配对客户端不能自行提升级别。请求超过配置级别时返回 `PERMISSION_DENIED`。交互能力（`interactive` / `canRequestConfirmation`）仅对外部 caller 在 `send-confirmed` 档为 `true`。

外部工具面共 15 个（v1）：8 个只读工具使用 `read:accounts`、`read:folders`、`read:messages` 和 `read:attachments` 这些 scope；7 个写工具（`mail.draft.create`、`mail.draft.update`、`mail.draft.delete`、`messages.move`、`messages.set-flag`、`messages.send`、`mail.reply`）在 `send-confirmed` 及以上档位可用，`read-only` 档调用返回 `PERMISSION_DENIED`。

## 错误码

当前实现的错误码包括：

- `NOT_SUPPORTED`：工具不可供外部 caller 使用。
- `PERMISSION_DENIED`：访问级别或 scope 不满足（含超过配置级别）。
- `SCOPE_DENIED`：账户不在已批准范围内。
- `CONFIRMATION_REQUIRED`：需要可见的桌面确认。
- `TOOL_INPUT_INVALID` / `INVALID_ARGUMENT`：输入与 Tool Schema 不匹配。
- `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` / `BROKER_SECURITY_UNAVAILABLE`：Broker 安全校验失败。
- `HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS`、`PAIRING_REQUIRED` / `PAIRING_REVOKED`：宿主、更新或配对状态异常。

## 账户范围

配对记录可允许所有账户、选定账户或无账户。任意请求的账户 ID 都必须属于该范围：

- 无账户范围时，读取账户数据会被拒绝。
- 选定范围不能通过省略 `--account`、传递多个 ID 或构造位置参数扩大。
- 删除账户会使其 Agent 生命周期代际失效，旧上下文和旧确认不能复用。
- 范围约束在所有档位生效，包括 `full-access`。

## 可见确认

在 `send-confirmed` 档，写操作（草稿创建/更新/删除、移动、标记、发送、回复）每次都会在 Nami Mail 桌面端弹出可见、一次性、不可变的确认。确认包含摘要、字段预览、账户、内容 SHA-256 摘要、到期时间和单次消费约束；确认必须由用户在桌面界面中完成。

外部 CLI 在 `send-confirmed` 档可以发起写操作，但每次都必须等待桌面端确认后才能执行；若无法取得可见确认，请求返回 `CONFIRMATION_REQUIRED`。`--yes` 不是授权令牌——解析器对外部命令一律拒绝 `--yes`，因此任何档位都无法绕过确认。`full-access` 档开启后自动执行所有操作，不再逐项确认，但范围与审计仍然生效。

## 传输与审计

- Windows AgentHost 必须先取得只允许当前用户 SID 的独占命名管道租约，再打开 Runtime 或数据库。
- 客户端请求和宿主响应均使用 Ed25519 签名。请求绑定当前 `bootId` 和严格递增的持久化计数器，防止重放。
- Broker、CLI 与 MCP 绝不接受渲染器 Fastify token，也不允许 HTTP、TCP、SQLite 或文件系统降级路径。
- 审计记录 `requestId`、调用入口、工具、账户范围、权限决定、结果和受限摘要；不记录邮件正文、附件内容、OAuth token、API key、邮箱密码或私钥。

邮件与附件始终是外部不可信数据。它们可作为受限上下文，但不会成为系统指令或工具授权。
