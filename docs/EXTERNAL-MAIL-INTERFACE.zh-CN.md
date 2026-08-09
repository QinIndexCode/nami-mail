# 外部 Mail 接口

[English](EXTERNAL-MAIL-INTERFACE.en.md) | [文档导航](README.md) | [CLI](cli/README.zh-CN.md) | [MCP](mcp/README.zh-CN.md)

Nami Mail 外部 Mail v1 是 Windows 桌面版提供的本机、已配对接口（默认只读，可在桌面设置中提升）。它面向本机脚本和 MCP 客户端，不是 Web API，也不能替代桌面界面。

## 开始使用

1. 安装并打开 Nami Mail，或显式运行 `namimail service start` 启动本机 AgentHost。
2. 从 CLI 或 MCP 客户端发起配对请求，并在可见的 Nami Mail 窗口中核对并批准该客户端。首次批准会固化当时获批的账户 ID 列表；每个客户端配置文件都有独立身份和授权。
3. 使用已配对的配置文件调用下列 v1 工具。普通读取命令不会自动启动宿主；MCP stdio 也不会创建配对或启动服务。
4. 对不再使用、疑似泄露或需要扩大账户范围的客户端运行 `namimail revoke --profile <name>`，再运行 `namimail pair --profile <name>` 并在桌面窗口确认。撤销立即阻止后续请求；新增账户不会自动进入旧配置文件的范围。

不要复制数据库、发现文件、管道名、配对状态或本机 API token 到客户端配置、环境变量、日志或 issue。Nami Mail 不接受这些项目作为替代凭据。

## v1 工具面

这 15 项工具（8 个只读 + 7 个写）是外部 Mail v1 的完整能力集。输入对象使用严格 schema，未知字段会被拒绝；首次配对固化的账户 ID 快照决定账户范围，请求参数不能扩大权限。之后新增的账户不可由旧配置文件访问，需撤销并重新配对。

| Tool | CLI | MCP | 严格输入 | Scope |
| --- | --- | --- | --- | --- |
| `accounts.list` | `accounts list` | `namimail_accounts_list` | `{}` | `read:accounts` |
| `folders.list` | `folders list --account <accountId>` | `namimail_folders_list` | `{ "accountId": "..." }` | `read:folders` |
| `messages.list` | `messages list` | `namimail_messages_list` | 可选 `mailbox`、`unread`、`flagged`、`sender`、`after`、`before`、`limit`、`cursor` | `read:messages` |
| `mail.summarize` | `mail summarize` | `namimail_mail_summarize` | 可选 `mailbox`、`unread`、`sender`、`after`、`before`、`limit` | `read:messages` |
| `messages.get` | `messages get --message <messageId>` | `namimail_message_get` | `{ "messageId": "..." }` | `read:messages` |
| `messages.batch_get` | `messages batch-get --message <id1,id2,...>` | `namimail_messages_batch_get` | `{ "messageIds": ["...", ...] }`（1..10） | `read:messages` |
| `threads.get` | `threads get --thread <threadId>` | `namimail_threads_get` | `{ "threadId": "..." }` | `read:messages` |
| `attachments.list` | `attachments list --message <messageId>` | `namimail_attachments_list` | `{ "messageId": "..." }` | `read:attachments` |
| `mail.draft.create` | `draft create` | `namimail_draft_create` | `{ "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:drafts` |
| `mail.draft.update` | `draft update` | `namimail_draft_update` | `{ "draftId": "...", "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:drafts` |
| `mail.draft.delete` | `draft delete` | `namimail_draft_delete` | `{ "accountId": "...", "draftId": "..." }` | `write:drafts` |
| `messages.move` | `messages move` | `namimail_messages_move` | `{ "messageId": "...", "target": "archive" \| "trash" }` | `write:mail` |
| `messages.set-flag` | `messages set-flag` | `namimail_messages_set_flag` | `{ "messageId": "...", "flag": "seen" \| "flagged", "value": true \| false }` | `write:mail` |
| `messages.send` | `messages send` | `namimail_messages_send` | `{ "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:mail` |
| `mail.reply` | `mail reply` | `namimail_mail_reply` | `{ "accountId": "...", "messageId": "...", "to"?, "cc"?, "subject"?, "text": "...", "attachmentTokens"? }` | `write:mail` + `read:messages` |

`after` 和 `before` 必须是带时区的 ISO 8601 时间，且 `before` 不得早于 `after`；`limit` 为 `1..50`。正文和线程正文由宿主限制长度，附件操作只返回元数据，不导出文件。

## 写操作与权限档位

外部 CLI 与外部 MCP 在桌面应用设置界面"权限"分组中各自独立配置访问级别（`agentCliAccessLevel` 与 `agentMcpAccessLevel`，默认均 `read-only`），档位与内置 Agent 相同：`read-only` / `send-confirmed` / `full-access`。

- `read-only`：7 个写工具均不可用，调用返回 `PERMISSION_DENIED`；8 个只读工具在任何档位都可用且无需确认。
- `send-confirmed`：每次写操作（草稿创建/更新/删除、移动、标记、发送、回复）都在 Nami Mail 桌面端弹出可见的一次性不可变确认，批准后执行。
- `full-access`：开启前必须由用户在 UI 中阅读明确警告并确认；开启后在已批准账户范围内自动执行所有操作（含发送与删除），不再逐项确认。范围与审计仍然生效。

权限判断位于宿主：宿主为外部 caller 构造访问级别并按配置档位收紧（clamp），已配对客户端不能自行提升；请求超过配置档位返回 `PERMISSION_DENIED`。CLI 的 `--yes`、MCP 参数或模型工具调用都不能充当确认或提权。

## 版本化成功数据

每项成功响应的 `data` 都由 v1 共享 schema 严格校验，不能出现未知字段。CLI JSON 与 MCP `structureContent.data` 使用同一形状：

| Tool | `data` 形状 | 主要字段 |
| --- | --- | --- |
| `accounts.list` | `{ "accounts": [...] }` | 每项含 `id`、`email`、`provider`、`displayName`、`status`、`lastSyncedAt`。 |
| `folders.list` | `{ "folders": [...] }` | 每项含 `accountId`、`path`、`name`、`specialUse`、`total`、`unseen`。 |
| `messages.list` | `{ "messages": [...], "nextCursor"?, "truncated": boolean }` | 元数据含 `id`、`accountId`、`mailbox`、`threadId`、`subject`、`from`、`sentAt`、`snippet`、`flags`、`hasAttachments`。 |
| `mail.summarize` | `{ "messages": [...], "truncated": boolean }` | 每项含 `messageId`、`threadId`、`mailbox`、`subject`、`from`、`sentAt` 和受限 `excerpt`。 |
| `messages.get` | `{ "message": { ... } }` | 消息详情在元数据外增加 `to`、`cc`、纯文本 `text` 和 `bodyTruncated`。 |
| `messages.batch_get` | `{ "messages": [...], "notFound": [...] }` | `messages` 为受限消息详情（1..10 条）；`notFound` 列出无法定位的请求 ID。 |
| `threads.get` | `{ "threadId": "...", "messages": [...], "truncated": boolean }` | `messages` 为上述受限消息详情。 |
| `attachments.list` | `{ "messageId": "...", "attachments": [...], "truncated": boolean }` | 每项含 `partId`、`filename`、`contentType`、`size`、`disposition`。 |

公开数据不会包含 `htmlBody`、原始附件、凭据、数据库路径、文件路径或引用对象。当前 v1 上限是：账户 100、文件夹 500、邮件列表 50、单次 batch_get 10、附件 100、单线程消息 25、正文 8,000 字符、摘要 1,500 字符。`truncated` 或 `bodyTruncated` 为 `true` 时，调用方应把数据视为受限结果，而不是完整邮箱副本。

下列功能不属于外部 v1：`messages.search`、所有 `rag.*`、附件导出、`agent.chat`、`agent.run`。它们不受权限档位影响——无论访问级别如何都不可用；不会出现在 MCP `tools/list`，也不能通过 CLI 参数、HTTP、TCP、文件 URI、SQLite 或本机 Fastify token 绕过。

## 信任边界

- Broker 使用仅当前 Windows 用户 SID 可访问的命名管道。CLI 和 MCP 只通过该管道访问正在运行的宿主。
- 每个客户端使用独立的受保护身份、宿主身份绑定、签名和单调计数器。重放、身份不匹配和已撤销配对会被拒绝。
- Broker 根据配对记录构造调用方、scope 和账户范围，不信任 CLI 或 MCP 提供的权限、账户范围、数据库路径或令牌。
- 本机 Fastify 服务仅服务桌面渲染器；动态回环端口和 `x-nami-api-token` 不是第三方集成凭据。详见[本机 Mail API 契约](LOCAL-API.zh-CN.md)。
- 更新开始时，Broker 先停止接收新请求并等待已接受的操作完成。客户端应处理 `UPDATE_IN_PROGRESS`，在更新恢复后重新提交新的请求，而不是重放旧签名帧。
- 任何已配对客户端都可以在任何权限档位调用 `host.shutdown`。它是 Broker 内部控制命令，不是外部 v1 工具：回复 `{ "status": "stopping" }` 并请求宿主停止，绝不经过外部工具允许列表或邮件桥接，本身也不授予任何邮件访问权限。

## 结果与恢复

成功响应为 `success: true` 和 `error: null`；失败响应为 `success: false` 和 `data: null`。自动化必须按稳定错误码分支，不应解析面向用户的消息文本。

| 错误 | 处理方式 |
| --- | --- |
| `HOST_UNAVAILABLE` | 打开 Nami Mail 或显式运行 `namimail service start`，然后发起新的请求。 |
| `UPDATE_IN_PROGRESS` | 等待更新完成或恢复后重新调用；不要重放已签名请求。 |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | 在 Nami Mail 可见窗口中完成或重新完成配对。 |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` | 停止调用，检查本机客户端安全存储，必要时撤销并重新配对；不要降级到 HTTP。 |
| `SCOPE_DENIED` / `PERMISSION_DENIED` | 目标账户不在范围，或调用方级别/scope 不足、请求超过配置档位；调整权限设置，或在桌面应用中完成该操作。 |
| `TOOL_INPUT_INVALID` / `NOT_SUPPORTED` | 以本页和 MCP `tools/list` 的 schema 为准；`NOT_SUPPORTED` 表示工具不可供外部调用，移除未支持字段或操作。 |

错误、审计和支持材料不得包含邮件正文、附件、OAuth token、密码、私钥、数据库路径或本机 API token。

## 翻译边界

实验性本地 NLLB-200 翻译与外部 Mail v1 分离。它仅在桌面阅读器中由用户主动准备和触发，模型未就绪时不会隐式下载或发送邮件正文；它不是 CLI/MCP 工具，也不会因配对而启用。详见[邮件正文翻译](TRANSLATION.zh-CN.md)。
