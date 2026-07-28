# CLI 状态与未来排错

[English](troubleshooting.en.md) | [退出码](exit-codes.md)

> **当前构建状态：CLI 不可用是预期行为。** 当前安装包没有 `namimail` 命令、PATH shim、外部 Broker、服务模式或配对 UI；不要尝试通过复制 shim、运行开发服务器、猜测管道或配置 HTTP 来修复。服务模式会以 `BROKER_SECURITY_UNAVAILABLE` 在打开 GUI、SQLite、主密钥或翻译模型之前失败关闭。

## 当前处理方式

请使用正常 Nami Mail 桌面界面。若发现其他文档、安装器或客户端配置把 CLI/MCP 说成可运行，请不要执行其中的命令，并将该文档问题报告给维护者。

## 未来错误契约（不可执行）

验证过的 Windows SID-DACL 原生适配器发布后，下列错误才会成为外部客户端可见的恢复信号：

| 代码 | 未来含义 | 未来处理 |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | 已发布的宿主未运行或独占租约不可用。 | 打开 NamiMail 或使用受支持的服务启动路径；不要启动第二个 Runtime。 |
| `UPDATE_IN_PROGRESS` | 更新排空关闭了新 Broker 请求。 | 等待更新完成或恢复后，重试同一个只读请求。 |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | 客户端没有获批或已被撤销。 | 仅在可见 NamiMail UI 中完成或重新完成配对。 |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | 签名、身份或计数器不正确。 | 停止重放；修复客户端安全存储或经用户批准重新配对；绝不降级为 HTTP。 |
| `SCOPE_DENIED` / `PERMISSION_DENIED` / `READ_ONLY` | 请求超出账户范围或外部写入边界。 | 使用允许的只读范围，或在可见 NamiMail UI 中完成操作。 |
| `RAG_NOT_READY` / `RAG_UNAVAILABLE` | 索引尚未就绪或不可用。 | 等待后再检索；不得把空结果编造成没有邮件。 |

未来支持请求也只能包含 `requestId`、错误码、CLI 版本、Windows 版本和非敏感复现步骤，不能附加邮件、附件、token、私钥、配对记录、数据库或管道信息。
