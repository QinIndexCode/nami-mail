# MCP Resources

[English](resources.en.md) | [工具](tools.md) | [安全](security.md)

> **未来契约，当前不可执行。** 当前构建没有 MCP Server、Broker 或可发现的工具。以下 Resources 边界是验证过的 Windows SID-DACL 原生适配器发布后必须遵守的协议设计，不表示当前存在可调用的 MCP 接口。

未来 NamiMail MCP v1 不会发布 `namimail://accounts`、`namimail://messages/...` 或其他包含邮件数据的 MCP Resource。

这是有意的安全边界：Resource URI 容易被客户端预取、缓存、展示在上下文中或在未绑定账户范围时重复读取。邮件正文、附件和线程只能通过经过调用方 scope、账户范围、Broker 审计和当前 Tool Schema 校验的只读工具返回。

## 替代方式

| 需要 | 使用工具 |
| --- | --- |
| 枚举账户 | `namimail_accounts_list` |
| 查看文件夹 | `namimail_folders_list` |
| 读取邮件或线程 | `namimail_message_get`、`namimail_threads_get` |
| 检索相关邮件 | `namimail_messages_search`、`namimail_rag_search` |
| 列出附件元数据 | `namimail_attachments_list` |

客户端不得把工具输出持久化为伪 Resource、跨用户共享或在配对撤销、账户范围改变、账户删除或应用更新后继续使用。每次新会话都应重新执行 `tools/list`，需要数据时再调用受限工具。

未来若加入 Resource，必须同时提供：调用方和账户范围检查、无可猜测 URI、最小内容暴露、过期/失效语义、审计、删除同步，以及对缓存的明确约束。在这些条件满足前，Resource 保持为空。
