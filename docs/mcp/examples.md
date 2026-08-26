# MCP 未来协议示例

[English](examples.en.md) | [配置](configuration.md) | [工具](tools.md)

> **当前构建状态：以下请求不可发送。** 当前安装包没有 MCP stdio 进程、`namimail` 命令、Broker、配对 UI 或可调用的 `tools/list`。这些 JSON 仅说明验证过的 Windows SID-DACL 原生适配器发布后的协议形状，不能用于 IDE、SDK 或终端。

## 未来工具发现

发布后的 MCP 客户端将先完成标准初始化，再发送类似以下的逻辑请求：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

未来运行时返回的名称、描述、`inputSchema` 和可用性将优先于本文。客户端不能从本文、缓存或 CLI 参数猜测未列出的工具。

## 未来只读调用

发布后的受配对客户端可调用如 `namimail_accounts_list`、`namimail_messages_search` 和 `namimail_rag_search` 的只读工具。每个请求都将被账户范围、scope、工具 schema 和 Broker 审计校验。账户 ID、查询文本和限制值只是示例数据，不能扩大权限。

调用方必须根据 `structuredContent.success` 判断结果，并保留 `requestId` 和邮件/线程引用。索引未就绪时应处理 `RAG_NOT_READY`，不得把空结果改写为“没有相关邮件”。

## 未来失败与写入边界

发布后的客户端将只对可重试错误使用有限退避；不能依赖 `HOST_UNAVAILABLE` 自动启动服务，也不能绕过配对或回退到 HTTP。`namimail_mail_send` 等写工具不会暴露给外部 MCP；草稿、核对、发送和高风险操作仍只可在可见 NamiMail UI 中完成。
