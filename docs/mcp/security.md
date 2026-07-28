# MCP 安全与权限

[English](security.en.md) | [CLI 权限](../cli/permissions.md)

> **未来契约，当前不可执行。** 当前构建没有 MCP stdio 适配器、Broker、配对记录或外部 AgentHost。以下信任边界、签名和权限规则只在验证过的 Windows SID-DACL 原生适配器发布后适用；当前构建拒绝外部入口且不降级。

## 信任边界

```text
MCP 客户端私钥 -> stdio 适配器 -> 已配对 Broker -> SID-DACL 命名管道 -> AgentHost -> Tool Registry / Permission Engine
```

发布后的 `AgentHost` 才可打开邮件数据库和持有解封后的主密钥。MCP 适配器不得继承 GUI 的 Fastify token，也不得信任客户端提供的账户 ID、scope、调用方类型或确认决定。

## 配对和防重放

- 每个客户端使用独立 Ed25519 密钥对；私钥留在客户端安全存储。
- 配对记录绑定客户端公钥、宿主 ID、公钥、批准 scope、创建时间和持久化十进制计数器。
- 请求签名覆盖域、协议版本、请求 ID、`hostId`、当前 `bootId`、客户端 ID、计数器和 JSON payload。
- Broker 在签名校验后以原子持久化事务推进计数器。重复、过期或乱序请求返回 `BROKER_REPLAY_DETECTED` 或 `BROKER_COUNTER_INVALID`。
- 响应包含宿主身份签名证明，客户端必须校验请求 ID、计数器、宿主公钥、宿主 ID 和本次启动 ID。

## 权限模型

发布后的外部 MCP caller 将固定为 `read-only`。Broker 构造而非客户端声明以下字段：入口 `mcp`、客户端身份、scope、账户范围、交互能力和请求 ID。Permission Engine 默认拒绝：

| 操作类型 | MCP v1 |
| --- | --- |
| 账户、文件夹、邮件、附件元数据、RAG 只读查询 | 仅在对应 `read:*` scope 和账户范围允许时可用。 |
| 草稿、移动、标记、归档、删除、重建 | 拒绝。 |
| 发送、回复、转发、批量写入、上传邮件内容、外部网络 | 拒绝；只能由可见 GUI 发起一次性不可变确认。 |
| `--yes`、MCP 参数或模型工具调用 | 绝不能充当确认或提权。 |

## 隐私、提示注入和日志

- 邮件 HTML、正文、主题、附件和外部链接都是不可信数据。它们可作为受限上下文，但不能成为系统指令、工具授权或配对指令。
- 云端 Provider 外发默认关闭。MCP 不可代表用户开启同意，也不可绕过用户设置的 Provider、模型或上下文范围。
- 审计保留 `requestId`、客户端、入口、工具、账户范围、权限决定、结果和受限摘要；不保留正文、附件内容、OAuth token、API key、密码或私钥。
- 诊断仅写标准错误；协议 stdout 不写 banner、调试日志或邮件内容。
- 本地实验翻译功能不会由 MCP 自动触发，也不能作为绕过 Provider 同意的路径。

## 更新和生命周期

接口发布后，更新开始时排空 gate 先拒绝新 Broker 请求，等待活动调用结束，关闭 Runtime，再释放独占租约。它不使用 TTL 自动重新开放。MCP 客户端应处理 `UPDATE_IN_PROGRESS` 并在更新完成后重新连接和重新发现工具。
