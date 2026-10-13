# Agent 工具

[简体中文](tools.zh-CN.md) | [English](tools.en.md)

## 统一注册表

工具使用小写点分标识符和版本化描述符注册。描述符至少声明分类、执行模式、必需 scope、账户访问要求、是否可外部调用、超时和确认策略。Provider 只提出工具调用；只有宿主的 Tool Registry 与 Permission Engine 可以解析和执行它。

| 模式 | 典型用途 | 外部 CLI/MCP v1 | 确认 |
| --- | --- | --- | --- |
| `read` | 账户、文件夹、邮件、线程、附件元数据、RAG 查询 | 允许，且必须在配对范围内 | 不需要 |
| `draft` | 创建/更新/删除草稿 | 允许（`send-confirmed` 及以上，7 个写工具之一） | 每次写操作需可见确认，直至 `full-access` |
| `write` | 标记、移动、归档 | 允许（`send-confirmed` 及以上） | 每次写操作需可见确认，直至 `full-access` |
| `high-risk` | 发送、转发、永久删除、批量写入、内容外发 | 仅 `mail.reply` / `messages.send` 对外开放 | 必须一次性 GUI 确认和持久审计 |

外部 CLI/MCP v1 共 16 个工具：9 个只读 + 7 个受限写入（草稿创建/更新/删除、移动、标记、发送、回复）。默认 `read-only` 档只开放只读；提升档位后写工具可用。命令行的 `--yes`、MCP 参数、已配对身份或模型输出都不会放宽权限档位或代替确认。

## 核心工具目录

宿主内置了邮件、日历、通讯录、长期记忆、自动回复审计与系统实用等领域的完整工具集。所有工具均通过强类型 Zod Schema 校验输入输出，并受权限引擎与一次性确认流程严格约束。

### 1. 邮件工具 (`mail.*` / `messages.*` / `accounts.*` / `folders.*` / `threads.*` / `attachments.*`)

邮件工具接入既有 `MailApplicationService` 外观，复用远端同步、outbox 和状态核对路径，不创建平行 SQLite/SMTP 链路。

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `accounts.list` | `read` | `read:accounts` | 允许 | 无需确认 | 列出调用方可见的配置账户及同步状态。 |
| `accounts.delete` | `write` | `write:accounts` | 仅内部 | 一次性 GUI 确认 (`delete-account`) | 移除指定邮箱账户及其本地缓存。 |
| `folders.list` | `read` | `read:folders` | 允许 | 无需确认 | 列出指定账户的邮箱文件夹树。 |
| `messages.list` | `read` | `read:messages` | 允许 | 无需确认 | 分页列出邮件元数据（支持发件人、未读、星标等过滤）。 |
| `messages.get` | `read` | `read:messages` | 允许 | 无需确认 | 获取指定邮件详情与正文内容（有界截断保护）。 |
| `messages.batch_get` | `read` | `read:messages` | 允许 | 无需确认 | 一次性批量获取最多 10 封邮件正文。 |
| `messages.search` | `read` | `read:messages` | 允许 | 无需确认 | 全文检索邮件并返回围绕关键词的摘要片段。 |
| `mail.summarize` | `read` | `read:messages` | 允许 | 无需确认 | 抓取近期匹配邮件的紧凑摘要用于大模型总结。 |
| `threads.get` | `read` | `read:messages` | 允许 | 无需确认 | 获取指定会话线程的邮件流。 |
| `attachments.list` | `read` | `read:attachments` | 允许 | 无需确认 | 列出指定邮件的附件元数据列表。 |
| `mail.draft.create` | `draft` | `write:drafts` | 允许 | 一次性 GUI 确认 (`create-draft`) | 创建新草稿（不触发发送）。 |
| `mail.draft.update` | `draft` | `write:drafts` | 允许 | 一次性 GUI 确认 (`update-draft`) | 更新现有草稿的主题、收件人或正文。 |
| `mail.draft.delete` | `draft` | `write:drafts` | 允许 | 一次性 GUI 确认 (`delete-draft`) | 删除指定草稿。 |
| `messages.move` | `write` | `write:messages` | 允许 | 一次性 GUI 确认 (`move-mail`) | 将邮件移动到归档、废纸篓或目标文件夹。 |
| `messages.set-flag` | `write` | `write:messages` | 允许 | 一次性 GUI 确认 (`set-flag`) | 标记邮件已读状态（`seen`）或星标（`flagged`）。 |
| `messages.send` | `high-risk` | `write:messages` | 允许 | 一次性 GUI 确认 (`send-mail`) | 撰写并通过账户 SMTP 发送新邮件。 |
| `mail.reply` | `high-risk` | `write:messages` | 允许 | 一次性 GUI 确认 (`reply-mail`) | 针对现有邮件起草并发送回复。 |

### 2. 日历工具 (`calendar.*`)

日历工具用于调度和管理本机日程。所有日程数据均在本地使用 AES-256-GCM 加密落盘，不与第三方云端日历服务同步。

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `calendar.list` | `read` | `read:calendar` | 仅内部 | 无需确认 | 检索指定时间重叠区间（`after`/`before`）的日程事件。 |
| `calendar.create` | `write` | `write:calendar` | 仅内部 | 一次性 GUI 确认 (`create-calendar-event`) | 创建新本地日程（标题、时间、地点、全天等）。 |
| `calendar.update` | `write` | `write:calendar` | 仅内部 | 一次性 GUI 确认 (`update-calendar-event`) | 更新已有日程的时间、描述或属性。 |
| `calendar.delete` | `write` | `write:calendar` | 仅内部 | 一次性 GUI 确认 (`delete-calendar-event`) | 删除指定的本地日程。 |

### 3. 通讯录工具 (`contacts.*`)

通讯录工具用于检索和维护本地联系人名册。数据同样在本地高强度加密存储。

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `contacts.search` | `read` | `read:contacts` | 仅内部 | 无需确认 | 按关键词模糊匹配联系人姓名或邮件地址。 |
| `contacts.create` | `write` | `write:contacts` | 仅内部 | 一次性 GUI 确认 (`create-contact`) | 在通讯录中新建联系人。 |
| `contacts.update` | `write` | `write:contacts` | 仅内部 | 一次性 GUI 确认 (`update-contact`) | 更新联系人信息（姓名、邮箱、备注等）。 |
| `contacts.delete` | `write` | `write:contacts` | 仅内部 | 一次性 GUI 确认 (`delete-contact`) | 删除指定联系人。 |

### 4. 长期记忆工具 (`memory.*`)

长期记忆系统允许 Agent 沉淀跨会话有效的事实、约定与偏好（例如发件习惯、项目术语等）。记忆存储在本机加密数据库中，操作完全可逆。

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `memory.list` | `read` | `manage:memory` | 仅内部 | 无需确认 | 查询已保存的长期记忆列表，支持关键词过滤。 |
| `memory.save` | `write` | `manage:memory` | 仅内部 | 无需确认 | 保存一条精简的长期记忆笔记。 |
| `memory.update` | `write` | `manage:memory` | 仅内部 | 无需确认 | 更新或合并已存在的记忆笔记（解决事实陈旧或冲突）。 |
| `memory.delete` | `write` | `manage:memory` | 仅内部 | 无需确认 | 删除指定的记忆项。 |

### 5. 自动回复审计工具 (`auto-reply.*`)

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `auto-reply.declined.search` | `read` | `audit:auto-reply` | 仅内部 | 无需确认 | 查询因离线规则初筛或模型评估而放弃回复的审计记录与拦截理由。 |

### 6. 系统与通用工具 (`time.*` / `web.*` / `settings.*`)

| 工具标识 | 模式 | 必需 Scope | 外部 CLI/MCP | 确认策略 | 功能说明 |
| --- | --- | --- | --- | --- | --- |
| `time.now` | `read` | `time:read` | 允许 | 无需确认 | 获取精准的当前本地时间、ISO 时间戳及 UTC 时区偏移量。 |
| `web.search` | `read` | `web:search` | 仅内部 | 无需确认 | 检索互联网公开信息（DuckDuckGo）；严格禁止携带用户私密邮件内容。 |
| `settings.update` | `write` | `manage:settings` | 仅内部 | 无需确认 | 调整应用外观（主题、背景预设、密度）及通知偏好等安全设置。 |

### 7. 动态外部 MCP 扩展

在桌面设置的 MCP 服务器管理中添加第三方 MCP 服务后，宿主 `AgentMcpServerManager` 会自动握手并动态注册其暴露的工具集合。外部 MCP 工具调用遵循独立的凭据验证与权限隔离机制。

## 输入、输出与来源

工具输入由 Zod schema 校验，并且必须限制账户、消息 ID、列表页大小和取消信号。工具结果是统一的成功、拒绝、失败、不支持或取消状态；错误使用稳定码和建议。

读取邮件正文或 RAG 页面时，结果应包含可回到应用内消息的来源引用，而非把未受控的整封内容隐式塞进模型。引用包含账号、消息/页面、修订和必要片段；UI 必须支持选择、复制和打开来源。

## 新工具的准入清单

1. 使用现有邮件服务或明确的只读查询，不创建平行 SMTP/IMAP/SQLite 路径。
2. 写出描述符、输入 schema、范围解析、最大成本和取消行为。
3. 选择最小权限 scope；默认 `availableToExternal: false`。
4. 高风险工具必须定义不可变预览、内容摘要、确认动作和审计事件。
5. 为授权、越权、取消、重复提交、账户删除和 Provider 伪造调用编写测试。

参见 [权限与确认](permissions.zh-CN.md) 和 [CLI/MCP 文档](../cli/README.zh-CN.md)。
