# MCP 工具

[English](tools.en.md) | [输出 Schema](output-schema.zh-CN.md) | [安全](security.zh-CN.md)

> **当前构建状态：可用。** 0.3.0 构建随附可用的 `tools/list`。下列十五个工具名和 schema 语义已生效（八个只读 + 七个写）；`tools/list` 返回的 `description`、`inputSchema` 和可用性仍是权威依据。

## 发现优先

MCP 客户端必须先调用 `tools/list`，并以其返回的 `description`、`inputSchema` 和可用性为准。宿主可以因版本、账户范围或 Provider 隐私设置而不暴露某个工具；未列出时不得调用或猜测参数。

已发布的只读工具执行模式均为 `read`、无需确认，且都携带 `annotations.readOnlyHint`。七个写工具不携带 `readOnlyHint`，其中 `namimail_draft_delete` 携带 `destructiveHint`；它们的确认策略按访问档位决定，见下文"写工具"小节。没有任何工具重建索引或调用未获同意的外部服务。

| 工具 | 描述 | 输入 schema 的语义字段 | 成功 `data` | 必需 scope |
| --- | --- | --- | --- | --- |
| `namimail_accounts_list` | 列出已配对调用方可见的账户。 | 无。 | `{ accounts, truncated }`。上限 100 个账户。 | `read:accounts` |
| `namimail_folders_list` | 列出某个账户内的文件夹。 | `accountId`（必填）。 | `{ folders, truncated }`。上限 500 个文件夹。 | `read:folders` |
| `namimail_messages_list` | 在调用方账户范围内列出邮件元数据。 | `mailbox`、`unread`、`flagged`、`sender`、`after`、`before`、`limit`、`cursor`。 | `{ messages, nextCursor?, truncated }`。上限 50 封邮件。 | `read:messages` |
| `namimail_mail_summarize` | 抓取近期匹配邮件的紧凑摘要（主题、发件人、日期、有界摘要片段），适合模型直接总结。 | `mailbox`、`unread`、`sender`、`after`、`before`、`limit`。 | `{ messages, truncated }`。上限 10 封邮件、每条摘要片段 2000 字符。 | `read:messages` |
| `namimail_message_get` | 读取一封已授权邮件的纯文本内容。 | `messageId`（必填）。 | `{ message }`。正文上限 8000 字符，超出以 `bodyTruncated` 标记。 | `read:messages` |
| `namimail_messages_batch_get` | 一次调用读取最多 10 封已授权邮件的完整纯文本内容。 | `messageIds`（必填，1..10）。 | `{ messages, notFound }`。每封正文上限 8000 字符，超出以 `bodyTruncated` 标记；`notFound` 列出无法定位的请求 ID。 | `read:messages` |
| `namimail_threads_get` | 读取一个已授权线程的纯文本内容。 | `threadId`（必填）。 | `{ threadId, messages, truncated }`。上限 25 封邮件。 | `read:messages` |
| `namimail_attachments_list` | 列出一封邮件的附件元数据。 | `messageId`（必填）。 | `{ messageId, attachments, truncated }`。上限 100 个附件。 | `read:attachments` |

字段名、必填性、枚举和最大长度以运行中的 `tools/list` JSON Schema 为准。工具输入只接受 JSON object；ID 是不透明值，不能从路径、SQL、邮箱密码、URL 或命令片段构造。

`after` 和 `before` 接受带偏移量的 ISO 8601 时间戳（例如 `2026-07-01T10:00:00+08:00`）。它们按真实时刻而非文本顺序比较；当 `before` 早于 `after` 时服务器返回 `TOOL_INPUT_INVALID`。

## 写工具

七个写工具仅在 `send-confirmed` 及以上档位可用（见[安全](security.zh-CN.md)）；`read-only` 档调用它们返回 `PERMISSION_DENIED`。确认策略：`send-confirmed` 档每次写操作都需要 Nami Mail 桌面端弹出的一次性不可变确认（工具返回 confirmation 流程，客户端不能自行批准）；`full-access` 档写工具直接自动执行（发送、删除等全部自动），无需逐项确认。`--yes`、MCP 参数或模型工具调用不能充当确认或提权。

| 工具 | 描述 | 输入 schema 的语义字段 | 成功 `data` | 必需 scope | 确认策略 |
| --- | --- | --- | --- | --- | --- |
| `namimail_draft_create` | 在已配对调用方范围内为某个账户创建草稿，不发送邮件。 | `accountId`、`to[]`、`cc?`、`subject`、`text`、`attachmentTokens?`。 | `{ draft: { id, accountId, subject, recipients, updatedAt } }`。 | `write:drafts` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_draft_update` | 替换一封草稿的收件人、主题或正文，不发送邮件。 | `draftId`、`accountId`、`to[]`、`cc?`、`subject`、`text`、`attachmentTokens?`。 | `{ draft: { id, accountId, subject, recipients, updatedAt } }`。 | `write:drafts` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_draft_delete` | 删除已配对调用方范围内的一封草稿。 | `accountId`、`draftId`。 | `{ accountId, draftId, deleted: true }`。 | `write:drafts` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_messages_move` | 将一封邮件移动到归档或废纸篓。 | `messageId`、`target`（`"archive"` 或 `"trash"`）。 | `{ messageId, target }`。 | `write:mail` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_messages_set_flag` | 设置一封邮件的已读（`seen`）或星标（`flagged`）状态。 | `messageId`、`flag`（`"seen"` 或 `"flagged"`）、`value`（boolean）。 | `{ messageId, flag, value }`。 | `write:mail` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_messages_send` | 撰写并通过账户的 SMTP Provider 发送一封邮件；消息只提交一次，重试复用同一持久化 submission。 | `accountId`、`to[]`、`cc?`、`subject`、`text`、`attachmentTokens?`。 | `{ submissionId, deliveryStatus }`。 | `write:mail` | `send-confirmed` 需桌面确认；`full-access` 自动。 |
| `namimail_mail_reply` | 为原邮件创建回复草稿，不发送邮件；收件人默认取原发件人，主题默认 `Re: <原标题>`。 | `accountId`、`messageId`、`to?`、`cc?`、`subject?`、`text`、`attachmentTokens?`。 | `{ draft: { id, accountId, subject, recipients, updatedAt } }`。 | `write:mail` + `read:messages` | `send-confirmed` 需桌面确认；`full-access` 自动。 |

`to[]` / `cc[]` 的元素为 `{ address, name? }`；`attachmentTokens` 是用户上传文件的 `out_...` 不透明 token，最多 10 个。字段名、必填性、枚举和最大长度以运行中的 `tools/list` JSON Schema 为准。

## 统一输出

每个工具的 NamiMail 结构化结果都使用[输出 Schema](output-schema.zh-CN.md)的成功/失败包络。调用方先检查 `success`；只有为 `true` 时才读取 `data`。工具不会把错误伪装为空数组或空对象。`truncated` 结果绝不冒充完整列表。

## 不可用与失败

| 情况 | 稳定结果 |
| --- | --- |
| 工具未在 `tools/list` 中出现或宿主不支持 | `NOT_SUPPORTED` 或 `TOOL_NOT_FOUND` |
| 输入不符合当前 schema | `TOOL_INPUT_INVALID` 或 `INVALID_ARGUMENT` |
| 访问级别为 `read-only` 时调用写工具 | `PERMISSION_DENIED` |
| 调用方缺少 scope / 账户范围 | `PERMISSION_DENIED` 或 `SCOPE_DENIED` |
| 写操作需要可见桌面确认（`send-confirmed` 档） | `CONFIRMATION_REQUIRED` |
| 适配器、宿主或 Broker 中断 | `HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS` 或传输错误 |

不要用另一个工具、CLI 直连、HTTP 或本地数据库读取来绕过这些结果。
