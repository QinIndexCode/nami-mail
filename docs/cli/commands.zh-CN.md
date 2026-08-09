# CLI 命令

[English](commands.en.md) | [参数](parameters.zh-CN.md) | [输出](output-schema.zh-CN.md)

> **当前构建状态：已实现。** 0.3.0 安装包随附受管理的 `namimail` 命令和 PATH shim。下列语法和命令名已生效；数据命令需要已运行、已配对的 Agent 宿主。

语法：

```text
namimail <组> <操作> [选项]
```

除 `version` 和 `help` 外的每个数据命令都需要已运行、已配对的宿主。命令解析器校验公共选项，并对外部命令拒绝 `--yes`；账户、邮件、文件夹、查询或写输入的具体格式由宿主 Tool Schema 校验，失败时返回 `INVALID_ARGUMENT` 或 `TOOL_INPUT_INVALID`。

## 已实现的命令

| 命令 | 作用 | 外部访问 | 常用输入 |
| --- | --- | --- | --- |
| `version` | 返回 NamiMail 名称和应用版本。 | 本地 | 无 |
| `help` | 显示命令帮助。 | 本地 | 可选的命令词 |
| `doctor` | 报告客户端、宿主和 Broker 可用性。 | 只读 | 无 |
| `status` | 返回宿主和 Agent 状态。 | 只读 | 无 |
| `accounts list` | 列出已配对调用方获批的账户。 | 只读 | 无 |
| `folders list` | 列出某个账户的文件夹。 | 只读 | `--account` |
| `messages list` | 列出邮件元数据。 | 只读 | `--folder`、`--limit`、`--since`、`--before`、`--unread`、`--flagged`、`--sender`、`--cursor` |
| `mail summarize` | 抓取近期匹配邮件的紧凑摘要。 | 只读 | `--folder`、`--limit`、`--since`、`--before`、`--unread`、`--sender` |
| `messages get` | 读取一封邮件允许返回的受限纯文本内容。 | 只读 | `--message` |
| `messages batch-get` | 一次调用读取最多 10 封邮件的受限纯文本内容。 | 只读 | `--message`（逗号分隔的 ID，1-10） |
| `threads get` | 读取线程的受限纯文本内容。 | 只读 | `--thread` |
| `attachments list` | 列出一封邮件的附件元数据。 | 只读 | `--message` |
| `draft create` | 为已配对调用方范围内的账户创建草稿。 | 按权限档位 | `--account`、`--to`（至少 1 个）、`--cc`、`--subject`、`--body` |
| `draft update` | 替换某封草稿的收件人、主题或正文。 | 按权限档位 | `--account`、`--draft`、`--to`、`--cc`、`--subject`、`--body` |
| `draft delete` | 删除已配对调用方范围内的某封草稿。 | 按权限档位 | `--account`、`--draft` |
| `messages move` | 将一封邮件移动到归档或废纸篓。 | 按权限档位 | `--message`、`--target`（`archive`\|`trash`） |
| `messages set-flag` | 设置一封邮件的已读或已标记状态。 | 按权限档位 | `--message`、`--flag`（`seen`\|`flagged`）、`--value`（`true`\|`false`） |
| `messages send` | 撰写并发送一封邮件。 | 按权限档位 | `--account`、`--to`、`--cc`、`--subject`、`--body` |
| `mail reply` | 为某封原邮件创建回复草稿。 | 按权限档位 | `--account`、`--message`、`--to`、`--cc`、`--subject`、`--body` |
| `mcp start` | 在 stdio 上启动 MCP 桥接。 | 启动器 | `--profile`、`--output` |
| `service start` | 显式启动安装包中的无界面 AgentHost。 | 启动器 | `--output` |
| `service stop` | 停止正在运行的 AgentHost。 | 启动器 | `--profile`、`--output` |
| `service restart` | 重启 AgentHost。 | 启动器 | `--profile`、`--output` |
| `pair` | 配对客户端 profile 并获批只读账户范围。 | 启动器 | `--profile`、`--output` |
| `revoke` | 撤销已配对的客户端 profile。 | 启动器 | `--profile`、`--output` |

写命令的收件人参数接受 `地址` 或 `名称 <地址>` 两种形式，多个收件人用逗号分隔。写命令仅在 CLI 权限为 `send-confirmed` 及以上时可用（默认 `read-only`，见[权限](permissions.zh-CN.md)）。

`--account`、`--folder`、`--limit`、`--since`、`--before`、`--unread`、`--flagged`、`--sender` 和 `--cursor` 只会缩小只读查询范围，绝不会扩大已配对客户端的已批准账户范围；带 `--account` 的写命令同样要求账户落在该范围内。

`mcp start` 将 stdout 专用于 MCP stdio，且仍要求已运行、已配对的宿主。`service start` 是唯一允许显式启动无界面 AgentHost 的生命周期命令；两者都不直接读取邮件数据。

## 默认拒绝的写命令（仅当 CLI 权限为只读时）

下列 7 个写命令在 CLI 权限为 `read-only`（默认档位）时返回 `PERMISSION_DENIED`，请求不会转发给 Broker：

```text
draft create | draft update | draft delete
messages move | messages set-flag | messages send
mail reply
```

在桌面设置中把 CLI 权限提升为"操作前确认"（`send-confirmed`）后，这些命令可用，但每次写操作都会在 Nami Mail 桌面端弹出可见确认；确认绑定不可变内容摘要、账户代际和一次性 token，必须由用户在界面中批准。`--yes` 不是授权令牌——解析器对外部命令一律拒绝 `--yes`，因此无法绕过确认。提升为"完全自动"（`full-access`）后自动执行，不再逐项确认，但范围与审计仍然生效。

每个命令的成功 `data` 由宿主注册的 schema 决定。脚本必须将其视为命令特定的 JSON，而不要把表格或文本输出当成 API。完整包络见[输出 Schema](output-schema.zh-CN.md)。
