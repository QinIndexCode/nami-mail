# CLI 参数

[English](parameters.en.md) | [命令](commands.zh-CN.md)

> **当前构建状态：已实现。** 0.3.0 构建随附 `namimail` CLI。下列选项是当前生效的解析和权限规则，可用于现有自动化。

选项可写成 `--name value` 或 `--name=value`。同一选项不得重复；未知选项或缺少值返回 `INVALID_ARGUMENT`。选项放在命令词后；位置参数会被拒绝。

| 参数 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `--output` | `table`、`json`、`jsonl`、`text` | `table` | 选择输出格式。自动化应使用 `json`。 |
| `--profile` | 字符串 | `default` | 选择 NamiMail Agent 客户端 profile。 |
| `--account` | 不透明账户 ID | 未设置 | `folders list` 必需；必须处于已配对账户范围内。 |
| `--folder` | 文件夹路径 | 未设置 | 将邮件列表限制到某个邮箱。 |
| `--limit` | 整数 `1..50` | 宿主默认 | 限制结果数量。CLI 本地严格校验范围。 |
| `--since` | ISO 8601 字符串 | 未设置 | 开始边界；按真实时刻比较，偏移量会归一化。 |
| `--before` | ISO 8601 字符串 | 未设置 | 结束边界；按真实时刻比较，偏移量会归一化。 |
| `--unread` | `true` 或 `false` | 未设置 | 筛选未读或已读邮件。 |
| `--flagged` | `true` 或 `false` | 未设置 | 筛选已标记或未标记邮件。 |
| `--sender` | 字符串 | 未设置 | 按发件人地址或名称筛选邮件。 |
| `--cursor` | 字符串 | 未设置 | 上一次响应的分页游标。 |
| `--message` | 不透明邮件 ID | 未设置 | `messages get` 或 `attachments list` 的目标邮件。 |
| `--thread` | 不透明线程 ID | 未设置 | `threads get` 的目标线程。 |

## 参数解析和范围

- CLI 只将 `--limit` 解析为数字。账户、邮件、线程、文件夹和时间的实际格式由宿主 Tool Schema 验证。
- 指定 `--account` 不会扩大权限。该账户必须在客户端配对记录的账户范围内，否则返回 `SCOPE_DENIED`。
- 省略 `--account` 也不意味着可读取所有账户。宿主仍根据配对 scope 和调用方账户范围过滤。
- 请求值不应包含令牌、密码、OAuth 回调参数、私钥或完整附件内容。CLI 会在审计中记录受限摘要和 `requestId`，而非这些秘密。

## 示例

```text
namimail messages list --folder INBOX --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail folders list --account acct_work --output table
```

不要使用未声明的 `--server`、`--database`、`--token`、`--query`、`--yes` 或 URL 参数。NamiMail 接口不接受外部 HTTP 端点或数据库路径。
