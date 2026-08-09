# CLI 用法示例

[English](examples.en.md) | [外部 Agent 接入](agent-integration.zh-CN.md)

> **当前构建状态：可运行。** 0.3.0 安装包随附 `namimail` 可执行文件和 PATH shim。下列示例针对已配对、正在运行的 Agent 宿主执行。

## 本地版本检查

`version` 可在本地返回非敏感版本数据，无需宿主也不读取邮件数据：

```text
namimail version
```

```json
{"name":"NamiMail","version":"0.3.0"}
```

## 只读查询

CLI 仅允许已配对、范围受限的读取。七个外部命令为 `accounts list`、`folders list`、`messages list`、`mail summarize`、`messages get`、`threads get` 和 `attachments list`。`acct_work` 和日期范围只是示例值；账户 ID 必须处于已批准的账户范围内。

```text
namimail accounts list --output json
namimail folders list --account acct_work --output json
namimail messages list --folder INBOX --since 2026-07-01T00:00:00Z --limit 20 --output json
namimail mail summarize --folder INBOX --since 2026-07-01T00:00:00Z --limit 10 --output json
namimail messages get --message msg_1 --output json
namimail threads get --thread thr_1 --output json
namimail attachments list --message msg_1 --output json
```

脚本必须只使用 `--output json`，先检查 `success` 再读取 `data`，并按稳定的 `error.code`、`retryable` 与 `requestId` 处理失败。不得依赖 `table` 列顺序、错误人类文本或 PowerShell 格式化结果。

## MCP 桥接

`mcp start` 将 stdout 专用于 MCP stdio，且仍要求已运行、已配对的宿主。它不会创建配对、隐式启动 Runtime，或回退到 HTTP。客户端形状见 [MCP 配置](../mcp/configuration.zh-CN.md)。

## 写操作边界

外部 CLI 的发送、回复、转发、删除、移动、归档、状态变更、草稿改写和索引重建操作返回 `PERMISSION_DENIED`。用户只能在可见 NamiMail UI 中完成草稿、核对和一次性确认；`--yes` 不会改变这一规则。
