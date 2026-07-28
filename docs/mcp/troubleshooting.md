# MCP 状态与未来排错

[English](troubleshooting.en.md) | [安全](security.md)

> **当前构建状态：MCP 不可用是预期行为。** 当前安装包没有 `namimail` 命令、PATH shim、MCP stdio 子进程、Broker、服务模式或配对 UI。不要复制可执行文件、运行开发服务、猜测管道或配置 HTTP 来绕过此限制；外部服务模式会以 `BROKER_SECURITY_UNAVAILABLE` 在打开 GUI、SQLite、主密钥或翻译模型之前失败关闭。

## 当前处理方式

请使用正常 Nami Mail 桌面界面。不要把任何 `namimail mcp start`、`service start` 或 MCP JSON 配置粘贴到客户端中。若其他文档把 MCP 说成可启动，请报告该文档问题。

## 未来错误契约（不可执行）

验证过的 Windows SID-DACL 原生适配器发布后，下列错误才会成为 MCP 客户端的恢复信号：

| 代码 | 未来含义 | 未来处理 |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | 已发布的宿主未运行或独占租约不可用。 | 打开 NamiMail 或使用受支持的服务启动路径；不要创建第二个 Runtime。 |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | 客户端未获批准或已被撤销。 | 仅在可见 NamiMail UI 中完成或重新完成配对。 |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | 签名、身份或计数器状态无效。 | 停止该连接，修复安全存储或经用户批准重新配对；不可增加 URL/TCP 降级。 |
| `UNSUPPORTED_PROTOCOL` / `VERSION_MISMATCH` | 适配器与宿主协议不兼容。 | 更新到同一 NamiMail 安装版本，重启客户端并重新发现工具。 |
| `TOOL_NOT_FOUND` / `SCOPE_DENIED` / `PERMISSION_DENIED` | 工具、账户或读取范围未获批准。 | 以 `tools/list` 为权威，只使用允许范围；不要猜测工具或参数。 |
| `RAG_NOT_READY` / `RAG_UNAVAILABLE` | 索引未就绪或不可用。 | 等待后再检索；不得把空结果改写为没有相关邮件。 |

未来支持请求只能包含 MCP 客户端版本、NamiMail 版本、Windows 版本、错误 `code`、`requestId` 和非敏感复现步骤。不得发送 JSON 会话原文、邮件、附件、token、私钥、配对记录、数据库或管道信息。
