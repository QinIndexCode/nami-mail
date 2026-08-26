# MCP 安全与权限

[English](security.en.md) | [CLI 权限](../cli/permissions.zh-CN.md)

> **当前构建状态：已强制生效。** 0.3.0 构建随附 MCP stdio 适配器、Broker、配对记录和外部 AgentHost。下列信任边界、签名和权限规则已生效；违反它们的外部入口会失败关闭。

## 信任边界

```text
MCP 客户端私钥 -> stdio 适配器 -> 已配对 Broker -> SID-DACL 命名管道 -> AgentHost -> Tool Registry / Permission Engine
```

只有 `AgentHost` 才能打开邮件数据库和持有解封后的主密钥。MCP 适配器不得继承 GUI 的 Fastify token，也不得信任客户端提供的账户 ID、scope、调用方类型或确认决定。

## 配对和防重放

- 每个客户端使用独立 Ed25519 密钥对；私钥留在客户端安全存储。
- 配对记录绑定客户端公钥、宿主 ID、公钥、批准 scope、创建时间和持久化十进制计数器。
- 请求签名覆盖域、协议版本、请求 ID、`hostId`、当前 `bootId`、客户端 ID、计数器和 JSON payload。
- Broker 在签名校验后以原子持久化事务推进计数器。重复、过期或乱序请求返回 `BROKER_REPLAY_DETECTED` 或 `BROKER_COUNTER_INVALID`。
- 响应包含宿主身份签名证明，客户端必须校验请求 ID、计数器、宿主公钥、宿主 ID 和本次启动 ID。

## 权限模型

三个入口各自独立配置访问级别，设置位于桌面应用设置界面的"权限"分组，三个下拉相邻；CLI 与 MCP 是两项独立设置但内容相同：

- 内置 Agent：`agentAccessLevel`，默认 `send-confirmed`。
- 外部 CLI：`agentCliAccessLevel`，默认 `read-only`。
- 外部 MCP：`agentMcpAccessLevel`（"外部 MCP 权限"下拉），默认 `read-only`。

档位为 `read-only` / `send-confirmed` / `full-access`：

- `read-only`：只能读取账户、文件夹、邮件、线程和附件元数据。
- `send-confirmed`：写操作（草稿创建/更新/删除、移动、标记、发送、回复）每次都在 Nami Mail 桌面端弹出可见确认。
- `full-access`：开启前必须由用户在 UI 中阅读警告并明确确认；开启后在已批准账户范围内自动执行所有操作（含发送与删除），不再逐项确认。范围与审计仍然生效。

Broker 构造而非客户端声明以下字段：入口 `mcp`、客户端身份、scope、账户范围、交互能力和请求 ID。宿主为外部 caller 构造访问级别并按配置档位收紧（clamp）：已配对客户端不能自行提升级别，请求超过配置级别时返回 `PERMISSION_DENIED`。交互能力（`interactive` / `canRequestConfirmation`）仅在 `send-confirmed` 档对外部 caller 为 `true`。Permission Engine 默认拒绝：

| 档位 | 可用操作 | 确认策略 |
| --- | --- | --- |
| `read-only` | 仅 8 个只读工具（账户、文件夹、邮件摘要、单条/批量消息读取、线程、附件元数据）。 | 无需确认。 |
| `send-confirmed` | 只读工具 + 7 个写工具（草稿创建/更新/删除、移动、标记、发送、回复）。 | 每次写操作都需要 Nami Mail 桌面端弹出的一次性不可变确认（工具返回 confirmation 流程，客户端不能自行批准）。 |
| `full-access` | 只读工具 + 7 个写工具。 | 写工具直接自动执行（发送、删除等全部自动），无需逐项确认。 |

`--yes`、MCP 参数或模型工具调用绝不能充当确认或提权。当前错误码：`PERMISSION_DENIED`（级别/scope 不满足，含超过配置级别）、`SCOPE_DENIED`（账户不在范围）、`CONFIRMATION_REQUIRED`（需要可见桌面确认）、`NOT_SUPPORTED`（工具不可供外部 caller）、`TOOL_INPUT_INVALID` / `INVALID_ARGUMENT`（输入不匹配）、`BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` / `BROKER_SECURITY_UNAVAILABLE`、`HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS`、`PAIRING_REQUIRED` / `PAIRING_REVOKED`。`READ_ONLY` 错误码已不再使用。

## 隐私、提示注入和日志

- 邮件 HTML、正文、主题、附件和外部链接都是不可信数据。它们可作为受限上下文，但不能成为系统指令、工具授权或配对指令。
- 云端 Provider 外发默认关闭。MCP 不可代表用户开启同意，也不可绕过用户设置的 Provider、模型或上下文范围。
- 审计保留 `requestId`、客户端、入口、工具、账户范围、权限决定、结果和受限摘要；不保留正文、附件内容、OAuth token、API key、密码或私钥。
- 诊断仅写标准错误；协议 stdout 不写 banner、调试日志或邮件内容。
- 本地实验翻译功能不会由 MCP 自动触发，也不能作为绕过 Provider 同意的路径。

## 更新和生命周期

更新开始时排空 gate 先拒绝新 Broker 请求，等待活动调用结束，关闭 Runtime，再释放独占租约。它不使用 TTL 自动重新开放。MCP 客户端应处理 `UPDATE_IN_PROGRESS` 并在更新完成后重新连接和重新发现工具。
