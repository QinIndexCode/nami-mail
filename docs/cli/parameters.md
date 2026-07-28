# CLI 参数

[English](parameters.en.md) | [命令](commands.md)

> **未来契约，当前不可执行。** 当前构建没有 `namimail` CLI、外部 Broker 或配对入口。下列选项仅定义验证过的 Windows SID-DACL 原生适配器发布后的解析和权限规则；不要把它们用于当前自动化。

接口发布后，选项可写成 `--name value` 或 `--name=value`。同一选项不得重复；未知选项、缺少值、同时出现 `--interactive` 和 `--non-interactive` 都将返回 `INVALID_ARGUMENT`。选项放在命令词后；`--` 后的内容按位置参数原样转交给宿主。

| 参数 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `--output` | `table`、`json`、`jsonl`、`text` | `table` | 选择输出格式。自动化应使用 `json`。 |
| `--account` | 不透明账户 ID | 未设置 | 限制到一个已授权账户。 |
| `--folder` | 文件夹 ID 或宿主认可的引用 | 未设置 | 限制邮件列表或搜索位置。 |
| `--limit` | 整数 `1..1000` | 宿主默认 | 限制结果数量。CLI 本地严格校验范围。 |
| `--since` | 字符串 | 未设置 | 交给宿主 schema 解释的开始边界。 |
| `--before` | 字符串 | 未设置 | 交给宿主 schema 解释的结束边界。 |
| `--query` | 字符串 | 未设置 | 搜索、RAG 或 Agent 请求。 |
| `--message` | 不透明邮件 ID | 未设置 | 目标邮件。 |
| `--thread` | 不透明线程 ID | 未设置 | 目标线程。 |
| `--attachment` | 不透明附件 ID | 未设置 | 目标附件。 |
| `--dry-run` | 布尔开关 | `false` | 请求宿主执行其支持的预检；不授予写权限。 |
| `--yes` | 布尔开关 | `false` | 表示调用方愿意继续非敏感流程；不能绕过权限或 GUI 确认。 |
| `--interactive` | 布尔开关 | `false` | 标记调用方可显示交互；外部 v1 仍不能请求写确认。 |
| `--non-interactive` | 布尔开关 | `false` | 明确关闭交互。不得和 `--interactive` 同用。 |

## 参数解析和范围

- CLI 只将 `--limit` 解析为数字。账户、邮件、线程、文件夹、附件和时间的实际格式由 Broker 后的 Tool Schema 验证。
- 指定 `--account` 不会扩大权限。该账户必须在客户端配对记录的账户范围内，否则返回 `SCOPE_DENIED`。
- 省略 `--account` 也不意味着可读取所有账户。宿主仍根据配对 scope 和调用方账户范围过滤。
- 请求值不应包含令牌、密码、OAuth 回调参数、私钥或完整附件内容。CLI 会在审计中记录受限摘要和 `requestId`，而非这些秘密。

## 未来示例（不可执行）

```text
namimail messages search --account acct_work --query "invoice" --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail rag search --query "renewal date" --limit 5 --output json
```

不要使用未声明的 `--server`、`--database`、`--token` 或 URL 参数。未来 NamiMail 也不接受外部 HTTP 端点或数据库路径。
