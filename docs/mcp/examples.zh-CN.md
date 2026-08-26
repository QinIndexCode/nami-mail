# MCP 协议示例

[English](examples.en.md) | [配置](configuration.zh-CN.md) | [工具](tools.zh-CN.md)

> **当前构建状态：可发送。** 0.3.0 安装包随附 MCP stdio 进程、`namimail` 命令、Broker、配对 UI 和可调用的 `tools/list`。下面的 JSON 针对已配对、正在运行的 Agent 宿主执行。

## 工具发现

MCP 客户端先完成标准初始化，再发送类似以下的逻辑请求：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

运行时返回的名称、描述、`inputSchema` 和可用性优先于本文。客户端不能从本文、缓存或 CLI 参数猜测未列出的工具。

## 只读调用

在默认只读档位，受配对客户端可调用八个只读工具：`namimail_accounts_list`、`namimail_folders_list`、`namimail_messages_list`、`namimail_mail_summarize`、`namimail_message_get`、`namimail_messages_batch_get`、`namimail_threads_get` 和 `namimail_attachments_list`。在桌面设置的「权限」分组中将「外部 MCP 权限」提升为「操作前确认」或「完全自动」后，`tools/list` 还会额外列出七个写工具（草稿创建/更新/删除、移动、标记、发送、回复）：操作前确认档每次写操作都会在 Nami Mail 桌面端弹窗确认，完全自动档直接执行。每个请求都会被账户范围、scope、工具 schema 和 Broker 审计校验。账户 ID、查询文本和限制值只是示例数据，不能扩大权限。

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"namimail_folders_list","arguments":{"accountId":"account_1"}}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"namimail_messages_list","arguments":{"mailbox":"INBOX","after":"2026-07-01T00:00:00Z","limit":20}}}
```

调用方必须根据 `structuredContent.success` 判断结果，并保留 `requestId`。被拒绝或失败的工具调用绝不会返回成功；失败时读取 `error.code`。

## 失败与写入边界

客户端只对可重试错误使用有限退避；不能依赖 `HOST_UNAVAILABLE` 自动启动服务，也不能绕过配对或回退到 HTTP。`namimail_messages_send` 等写工具需要 `send-confirmed` 或 `full-access` 档位，在 `read-only` 档永不可用。草稿、核对、发送和高风险操作仍只可在可见 NamiMail UI 中完成。
