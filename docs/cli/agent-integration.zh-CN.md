# 外部 Agent 接入状态与契约

[English](agent-integration.en.md) | [MCP 接入](../mcp/README.zh-CN.md)

> **当前构建状态：已接入。** 0.3.0 构建随附 Broker、`namimail` 可执行文件、PATH shim、配对 UI 和 MCP 启动器。脚本、IDE Agent 和自动化任务可调用文档化接口；默认只读，可在桌面设置的「权限」分组中提升。

## 当前限制

外部 Agent 使用文档化的 `namimail` 命令；默认档位为只读，写命令仅在把「外部 CLI 权限」提升为「操作前确认」或「完全自动」后可用。不得读取、复制、备份或同步 NamiMail 数据目录、SQLite、配对记录或密钥材料。不得尝试 `--server`、本地 HTTP、TCP、文件 URI、环境变量 token 或命名管道猜测作为替代路径。

实验性的本地 NLLB-200 翻译仍需用户在 UI 中主动触发。它不是外部 Agent 通道，也不会自动翻译邮件或向模型发送邮件内容。

## 调用契约

外部 Agent 在用户完成独立配对并批准账户范围后，使用进程参数数组调用文档化的命令。调用必须请求 JSON 包络，先检查 `success`，并只根据 `error.code`、`retryable` 和 `requestId` 处理失败；不得从退出码、人类可读错误或表格输出推断邮件事实。

重试仅代表条件可能暂时恢复。对 `HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS`、`PROVIDER_TIMEOUT` 或 `PROVIDER_RATE_LIMITED` 可采用有限指数退避并保留原 `requestId`。`PAIRING_REVOKED`、`BROKER_REPLAY_DETECTED`、`PERMISSION_DENIED` 和 `SCOPE_DENIED` 不能靠重试修复。

写命令在只读档会被外部 CLI 拒绝；将「外部 CLI 权限」提升为「操作前确认」后，每次写操作都会在 Nami Mail 桌面端弹窗确认，提升为「完全自动」后直接执行。`--yes`、已配对身份或模型建议都不能绕过用户确认——`--yes` 对外部命令一律不被接受。
