# CLI 状态与排错

[English](troubleshooting.en.md) | [退出码](exit-codes.zh-CN.md)

> **当前构建状态：可用。** 0.3.0 安装包随附 `namimail` 命令、PATH shim、外部 Broker、服务模式和配对 UI。下列错误码是活动 CLI 客户端的恢复信号。服务模式仍会以 `BROKER_SECURITY_UNAVAILABLE` 在打开 GUI、SQLite、主密钥或翻译模型之前失败关闭。

## 当前处理方式

安装 Nami Mail 后，运行 `namimail pair` 并在可见窗口中批准请求，保持 Agent 宿主运行（打开 Nami Mail 或运行 `namimail service start`），再使用文档化的只读命令。若其他文档、安装器或客户端配置把不支持的命令说成可运行，请不要执行其中的命令，并将该文档问题报告给维护者。

## 错误契约

| 代码 | 含义 | 处理 |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | Agent 宿主未运行或独占租约不可用。 | 打开 NamiMail 或运行 `namimail service start`；不要启动第二个 Runtime。 |
| `UPDATE_IN_PROGRESS` | 更新排空关闭了新 Broker 请求。 | 等待更新完成或恢复后，重试同一个只读请求。 |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | 客户端没有获批或已被撤销。 | 仅在可见 NamiMail UI 中完成或重新完成配对。 |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | 签名、身份或计数器不正确。 | 停止重放；修复客户端安全存储或经用户批准重新配对；绝不降级为 HTTP。 |
| `SCOPE_DENIED` / `PERMISSION_DENIED` | 请求超出账户范围或外部写入边界。 | 使用允许的只读范围，或在可见 NamiMail UI 中完成操作。 |
| `BROKER_SECURITY_UNAVAILABLE` / `CLI_RUNTIME_FORBIDDEN` | 所需的安全 IPC 不可用。 | 重新安装或更新 Nami Mail；不要用 HTTP 或数据库直连替代。 |

支持请求只能包含 `requestId`、错误码、CLI 版本、Windows 版本和非敏感复现步骤，不能附加邮件、附件、token、私钥、配对记录、数据库或管道信息。
