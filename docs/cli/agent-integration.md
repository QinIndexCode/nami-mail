# 外部 Agent 接入状态与未来契约

[English](agent-integration.en.md) | [MCP 接入](../mcp/README.md)

> **当前构建状态：外部 Agent 不能接入。** 此 Windows 构建没有可验证的 SID-DACL 命名管道原生适配器、Broker、`namimail` 可执行文件、PATH shim、配对 UI 或 MCP 启动器。不要从脚本、IDE Agent 或自动化任务调用、封装或猜测该接口。

## 当前限制

外部 Agent 只能使用用户已明确提供的其他受支持入口；不得读取、复制、备份或同步 NamiMail 数据目录、SQLite、配对记录或密钥材料。不得尝试 `--server`、本地 HTTP、TCP、文件 URI、环境变量 token 或命名管道猜测作为替代路径。

实验性的本地 NLLB-200 翻译仍需用户在 UI 中主动触发。它不是外部 Agent 通道，也不会自动翻译邮件或向模型发送邮件内容。

## 未来调用契约（不可执行）

适配器发布后，外部 Agent 才可在用户完成独立配对并批准只读账户范围后，使用进程参数数组调用预留的 CLI 命令。未来调用必须请求 JSON 包络，先检查 `success`，并只根据 `error.code`、`retryable` 和 `requestId` 处理失败；不得从退出码、人类可读错误或表格输出推断邮件事实。

重试仅代表条件可能暂时恢复。未来对 `HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS`、`PROVIDER_TIMEOUT` 或 `PROVIDER_RATE_LIMITED` 可采用有限指数退避并保留原 `requestId`。`PAIRING_REVOKED`、`BROKER_REPLAY_DETECTED`、`PERMISSION_DENIED` 和 `SCOPE_DENIED` 不能靠重试修复。

即使接口发布，写命令也必须被外部 CLI 拒绝。`--yes`、已配对身份或模型建议都不能绕过可见 NamiMail UI 中的用户确认。
