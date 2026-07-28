# CLI 命令

[English](commands.en.md) | [参数](parameters.md) | [输出](output-schema.md)

> **未来契约，当前不可执行。** 当前安装包没有 `namimail` 命令、PATH shim、可启动的 AgentHost 或 Broker；下列语法和命令名只保留给通过验证的 Windows SID-DACL 原生适配器发布后的接口。不要复制到终端执行。

未来语法：

```text
namimail <组> <操作> [选项] [-- <位置参数...>]
```

接口发布后，除 `version` 外的每个数据命令都将需要已运行、已配对的宿主。命令解析器只校验公共选项；具体的账户、邮件、文件夹或查询要求将由宿主 Tool Schema 校验，失败时返回 `INVALID_ARGUMENT` 或 `TOOL_INPUT_INVALID`。

## 预留命令（未来）

| 命令 | 未来作用 | 未来外部访问 | 常用输入 |
| --- | --- | --- | --- |
| `version` | 将返回 NamiMail 名称和应用版本。 | 本地 | 无 |
| `doctor` | 将报告客户端、宿主和 Broker 可用性。 | 只读 | 无 |
| `status` | 将返回宿主和 Agent 状态。 | 只读 | 无 |
| `accounts list` | 列出已授权账户。 | 只读 | `--account` 可缩小范围 |
| `folders list` | 列出文件夹。 | 只读 | `--account` |
| `messages list` | 列出邮件元数据。 | 只读 | `--account`、`--folder`、`--limit`、时间范围 |
| `messages get` | 读取单封邮件及允许返回的内容。 | 只读 | `--message`、`--account` |
| `messages search` | 按结构化条件搜索邮件。 | 只读 | `--query`、范围、`--limit` |
| `threads get` | 读取线程。 | 只读 | `--thread`、`--account` |
| `attachments list` | 列出附件元数据。 | 只读 | `--message`、`--account` |
| `attachments export` | 导出获准读取的附件。 | 只读 | `--attachment`、`--message`、`--account` |
| `rag search` | 对已就绪索引执行受账户范围限制的检索。 | 只读 | `--query`、`--account`、`--limit` |
| `rag status` | 返回索引状态。 | 只读 | `--account` |
| `rag verify` | 验证索引一致性。 | 只读 | `--account` |
| `agent chat` | 在现有 Provider 与隐私同意条件下运行只读聊天。 | 只读 | 查询或位置参数 |
| `agent run` | 执行一次只读 Agent 请求。 | 只读 | 查询或位置参数 |
| `mcp start` | 在 stdio 上启动 MCP 桥接。 | 只读桥接 | 无 |
| `service start` | 显式启动安装包中的无界面 AgentHost。 | 生命周期 | 无 |

`mcp start` 和 `service start` 都不访问邮件数据本身。适配器发布后，前者不会自动启动宿主，后者才会是唯一可显式启动宿主的命令；当前两者均不能执行。

## 被拒绝的写命令

下列命令名保留用于一致的产品语义。接口发布后，v1 外部 CLI 将返回 `PERMISSION_DENIED`，不会把请求转给 Broker：

```text
drafts create | drafts update | drafts delete
mail reply | mail forward | mail send
mail archive | mail move | mail trash
mail mark-read | mail mark-unread
rag rebuild
```

`--yes`、`--interactive`、已配对身份或模型建议都不能放宽限制。用户必须在 NamiMail 可见 Agent 工作区发起并批准需要确认的动作；确认绑定不可变内容摘要、账户代际和一次性 token。

每个命令的未来成功 `data` 由宿主注册的 schema 决定。脚本必须将其视为命令特定的 JSON，而不要把表格或文本输出当成 API。完整包络见[输出 Schema](output-schema.md)。
