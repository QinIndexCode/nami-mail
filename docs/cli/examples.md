# CLI 未来用法示例

[English](examples.en.md) | [外部 Agent 接入](agent-integration.md)

> **当前构建状态：以下示例不可运行。** 当前安装包没有 `namimail` 可执行文件、PATH shim、AgentHost、Broker 或配对入口。示例只用于定义经过验证的 Windows SID-DACL 原生适配器发布后的行为，不应复制到终端或自动化配置中。

## 未来本地版本检查

适配器发布后，预留的 `version` 命令将可在本地返回类似如下的非敏感版本数据，而不读取邮件数据：

```json
{"name":"NamiMail","version":"0.2.0"}
```

## 未来只读查询

发布后的 CLI 将仅允许已配对、范围受限的读取。典型契约包括按账户搜索邮件、检索就绪 RAG 索引，以及以 JSON 包络报告成功、失败和 `requestId`。`acct_work`、查询文本和日期范围都只是示例值；账户 ID 必须处于已批准的账户范围内。

脚本在未来必须只使用 `--output json`，先检查 `success` 再读取 `data`，并按稳定的 `error.code`、`retryable` 与 `requestId` 处理失败。不得依赖 `table` 列顺序、错误人类文本或 PowerShell 格式化结果。

## 未来 MCP 桥接

发布后的 `mcp start` 将把 stdout 专用于 MCP stdio，且仍要求已运行、已配对的宿主。它不会创建配对、隐式启动 Runtime，或回退到 HTTP。具体的未来客户端形状见 [MCP 配置](../mcp/configuration.md)。

## 写操作边界

即使接口发布，外部 CLI 的发送、回复、转发、删除、移动、归档、状态变更、草稿改写和索引重建仍必须返回 `PERMISSION_DENIED`。用户只能在可见 NamiMail UI 中完成草稿、核对和一次性确认；`--yes` 不会改变这一规则。
