# 权限与确认

[简体中文](permissions.zh-CN.md) | [English](permissions.en.md)

## 默认拒绝

权限判断位于宿主，不位于模型、提示词、CLI 前端或 MCP 客户端。每次调用同时检查调用方身份、访问级别、必需 scope、账户范围、是否可外部调用和确认策略；任一条件缺失即拒绝。

`CallerContext` 至少绑定 `callerId`、入口类型、访问级别、scope、账户范围、是否交互和 session。它由 GUI 会话或已配对 Broker 构造，外部参数不能自行声明更高权限。

| 访问级别 | 可达能力上限 |
| --- | --- |
| `read-only` | 已授权范围内的只读工具 |
| `send-confirmed` | 所有写操作（含发送）每次都在界面请求一次性确认 |
| `full-access` | 自动执行所有操作（含发送与删除），不再逐项确认；仍不绕过范围与审计 |

`accountScope` 是 `none`、`selected` 或 `all`。选定范围绝不能通过空参数、批量列表、线程引用或 RAG 结果扩大为其他账户。

## 一次性 GUI 确认

确认策略按档位决定：`read-only` 档不做任何确认（写操作被拒绝）；`send-confirmed` 档每次写操作（含发送）都在可见的应用内 UI 弹出一次性不可变确认；`full-access` 档在开启前由用户阅读明确警告并确认，之后自动执行、不再逐项确认。确认记录是不可变事件，而不是可编辑的布尔值。

请求快照包含操作标题、用户可读摘要、关键字段、账号、工具、`requestId`、不可变 payload hash 和到期时间。批准时必须同时匹配：

1. 同一个确认 ID 和请求 ID；
2. 同一个已授权的交互式 GUI caller；
3. 未改变的 payload hash；
4. 仍有效的账户代际和未过期记录；
5. 尚未消费的一次性 token。

拒绝、取消、超时、内容变更、帐号删除或已经消费都会使确认无效。不可用 GUI、CLI、MCP、自动化、`--yes`、或模型工具调用批准确认。

## 审计

高风险工具在真正执行前写入耐久 intent，随后追加确认、执行成功、失败或取消事件。审计记录不可更新/删除；其加密详情只保留足以解释行为的摘要，不记录密钥、令牌、密码、完整正文或附件。

审计必须可回答：谁从哪个入口请求了什么工具、范围为何、是否经过确认、结果/错误码为何、发生于何时。它不能被用来绕过已删除账户的密钥或恢复原始邮件内容。

## 外部调用方

三个入口各自独立配置访问级别：内置 Agent 使用 `agentAccessLevel`（默认 `send-confirmed`），外部 CLI 使用 `agentCliAccessLevel`（默认 `read-only`），外部 MCP 使用 `agentMcpAccessLevel`（默认 `read-only`）。档位均为 `read-only` / `send-confirmed` / `full-access`；设置项位于桌面应用设置界面"权限"分组，三个下拉相邻，CLI 与 MCP 是两项独立设置但内容相同。

CLI/MCP v1 支持三档模型。权限判断位于宿主：宿主为外部 caller 构造访问级别并按配置档位收紧（clamp），已配对客户端不能自行提升级别；请求超过配置级别返回 `PERMISSION_DENIED`。CLI 的 `--yes`、MCP 参数或模型工具调用都不能充当确认或提权。`send-confirmed` 档每次写操作都在桌面端弹出可见的一次性不可变确认；`full-access` 档开启前必须由用户在 UI 中阅读明确警告并确认，开启后在已批准账户范围内自动执行所有操作（含发送与删除），范围与审计仍然生效。内置 Agent 的 `full-access` 同样需要开启前警告。

## 错误语义

- `PERMISSION_DENIED`：访问级别或 scope 不满足。
- `SCOPE_DENIED`：目标账号不属于调用方范围。
- `NOT_SUPPORTED`：工具不可供外部 caller（如 `messages.search`、`rag.*`、`agent.chat`、`agent.run`、附件导出）。
- `CONFIRMATION_REQUIRED`：操作需要正在运行的 GUI 确认。
- `BROKER_SECURITY_UNAVAILABLE`：无法证明安全本地 IPC，不能降级。

参见 [安全](security.zh-CN.md) 和 [工具](tools.zh-CN.md)。
