# MCP 状态与排错

[English](troubleshooting.en.md) | [安全](security.zh-CN.md)

> **当前构建状态：可用。** 0.3.0 安装包随附 `namimail` 命令、PATH shim、MCP stdio 子进程、Broker、服务模式和配对 UI。下列错误码是活动 MCP 客户端的恢复信号。外部服务模式仍会以 `BROKER_SECURITY_UNAVAILABLE` 在打开 GUI、SQLite、主密钥或翻译模型之前失败关闭。

## 当前处理方式

安装 Nami Mail 后，保持 Agent 宿主运行（打开 Nami Mail 或运行 `namimail service start`），运行 `namimail pair` 并在可见窗口中批准，再把[配置](configuration.zh-CN.md)中的 stdio 配置粘贴到 MCP 客户端。若其他文档把不支持的命令说成可启动，请报告该文档问题。

## 错误契约

| 代码 | 含义 | 处理 |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | Agent 宿主未运行或独占租约不可用。 | 打开 NamiMail 或使用受支持的服务启动路径；不要创建第二个 Runtime。 |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | 客户端未获批准或已被撤销。 | 仅在可见 NamiMail UI 中完成或重新完成配对。 |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | 签名、身份或计数器状态无效。 | 停止该连接，修复安全存储或经用户批准重新配对；不可增加 URL/TCP 降级。 |
| `UNSUPPORTED_PROTOCOL` / `VERSION_MISMATCH` | 适配器与宿主协议不兼容。 | 更新到同一 NamiMail 安装版本，重启客户端并重新发现工具。 |
| `TOOL_NOT_FOUND` / `SCOPE_DENIED` / `PERMISSION_DENIED` | 工具、账户或读取范围未获批准。 | 以 `tools/list` 为权威，只使用允许范围；不要猜测工具或参数。 |
| `BROKER_SECURITY_UNAVAILABLE` / `CLI_RUNTIME_FORBIDDEN` | 所需的安全 IPC 不可用。 | 重新安装或更新 Nami Mail；不要用 HTTP 或数据库直连替代。 |

支持请求只能包含 MCP 客户端版本、NamiMail 版本、Windows 版本、错误 `code`、`requestId` 和非敏感复现步骤。不得发送 JSON 会话原文、邮件、附件、token、私钥、配对记录、数据库或管道信息。
