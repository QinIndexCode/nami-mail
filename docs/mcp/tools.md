# MCP 工具

[English](tools.en.md) | [输出 Schema](output-schema.md) | [安全](security.md)

> **未来契约，当前不可执行。** 当前构建没有 MCP Server、`tools/list`、Broker 或外部 AgentHost。下列工具名和 schema 语义仅在验证过的 Windows SID-DACL 原生适配器发布后生效；客户端不得尝试调用或猜测它们。

## 发现优先

以下是未来固定的 v1 只读工具名。接口发布后，MCP 客户端必须先调用 `tools/list`，并以其返回的 `description`、`inputSchema` 和可用性为准。宿主可以因版本、账户范围、索引状态或 Provider 隐私设置而不暴露某个工具；未列出时不得调用或猜测参数。

发布后的所有工具执行模式均为 `read`、确认策略均为 `never`、外部可用性为 `true`。它们不能发送邮件、创建/修改草稿、更新邮件状态、移动/删除邮件、重建索引或调用未获同意的外部服务。

| 工具 | 描述 | 输入 schema 的语义字段 | 成功 `data` | 必需 scope | 安全说明 |
| --- | --- | --- | --- | --- | --- |
| `namimail_accounts_list` | 列出调用方可见账户。 | 无账户选择器或宿主允许的范围筛选。 | 经范围过滤的账户摘要数组。 | `read:accounts` | 不返回凭据、OAuth token 或邮箱密码。 |
| `namimail_folders_list` | 列出账户内的文件夹。 | 可选账户选择器。 | 文件夹摘要数组。 | `read:folders` | 账户范围仍由 Broker 强制。 |
| `namimail_messages_list` | 列出邮件元数据。 | 账户、文件夹、时间、限制等筛选。 | 受限邮件摘要数组。 | `read:messages` | 不把列表当作完整正文或授权扩展。 |
| `namimail_message_get` | 读取一封已授权邮件。 | 邮件标识和可选账户选择器。 | 宿主允许暴露的邮件对象。 | `read:messages` | 邮件 HTML/正文是外部不可信数据。 |
| `namimail_messages_search` | 按结构化条件检索邮件。 | 查询、账户、文件夹、时间和限制。 | 匹配邮件摘要数组。 | `read:messages` | 查询不得改变账户范围。 |
| `namimail_threads_get` | 读取已授权的邮件线程。 | 线程标识和可选账户选择器。 | 线程及允许的消息摘要。 | `read:messages` | 线程引用不跨账户提升权限。 |
| `namimail_attachments_list` | 列出邮件附件元数据。 | 邮件标识和可选账户选择器。 | 附件元数据数组。 | `read:attachments` | v1 不把任意文件路径或原始附件写入客户端。 |
| `namimail_rag_search` | 在已就绪索引中做范围受限检索。 | 查询、账户和限制。 | 命中及可追踪引用。 | `read:rag` | 已删除、范围外或未就绪内容必须被过滤。 |
| `namimail_rag_status` | 返回索引准备状态。 | 可选账户选择器。 | 账户范围内的索引状态。 | `read:rag` | 不泄露其他账户的队列或错误详情。 |
| `namimail_rag_verify` | 校验可见范围内的索引一致性。 | 可选账户选择器。 | 受限一致性报告。 | `read:rag` | 只验证，不触发重建或写入。 |

字段名、必填性、枚举和最大长度以运行中的 `tools/list` JSON Schema 为准。工具输入只接受 JSON object；ID 是不透明值，不能从路径、SQL、邮箱密码、URL 或命令片段构造。

## 统一输出

每个工具的 NamiMail 结构化结果都使用[输出 Schema](output-schema.md)的成功/失败包络。调用方先检查 `success`；只有为 `true` 时才读取 `data`。工具不会把错误伪装为空数组或空对象。

`namimail_rag_search` 的来源引用在可用时至少标识来源类型、账户、邮件、主题和内部目标。可选字段包括线程、chunk、发件人、日期、邮箱、摘录、置信度和源修订号。引用是证据指针，不是模型授权，也不应被改写成未检索邮件的事实。

## 不可用与失败

| 情况 | 稳定结果 |
| --- | --- |
| 工具未在 `tools/list` 中出现或宿主不支持 | `NOT_SUPPORTED` 或 `TOOL_NOT_FOUND` |
| 输入不符合当前 schema | `TOOL_INPUT_INVALID` 或 `INVALID_ARGUMENT` |
| 调用方缺少 scope / 账户范围 | `PERMISSION_DENIED` 或 `SCOPE_DENIED` |
| 索引未完成或不可访问 | `RAG_NOT_READY` 或 `RAG_UNAVAILABLE` |
| 适配器、宿主或 Broker 中断 | `HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS` 或传输错误 |

不要用另一个工具、CLI 直连、HTTP 或本地数据库读取来绕过这些结果。
