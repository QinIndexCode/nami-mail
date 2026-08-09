# MCP 输出 Schema

[English](output-schema.en.md) | [工具](tools.zh-CN.md)

> **当前构建状态：已实现。** 0.3.0 构建随附 MCP stdio Server、Broker 和 `tools/list`。下列包络可由当前客户端获得。

MCP 的外层消息遵循客户端与 stdio Server 协商的 MCP 协议。NamiMail 在工具结果中保留相同的稳定 Agent 成功/失败语义；支持结构化内容的客户端应把以下对象作为程序接口：

```json
{
  "protocolVersion": "1.0",
  "requestId": "123e4567-e89b-12d3-a456-426614174004",
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "contractVersion": 1,
    "durationMs": 18
  }
}
```

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `protocolVersion` | 字符串 | Agent wire protocol，当前为 `1.0`。 |
| `requestId` | UUID | NamiMail 审计和支持关联 ID。 |
| `success` | 布尔 | 为 `true` 时 `error` 是 `null`；为 `false` 时 `data` 是 `null`。 |
| `data` | JSON 或 `null` | 由 `tools/list` 中相应工具的输出 schema 定义。 |
| `error` | 对象或 `null` | 稳定 Agent 错误。 |
| `meta.contractVersion` | 整数 | 当前为 `1`。 |
| `meta.durationMs` | 非负整数 | 宿主执行耗时。 |

错误对象：

```json
{
  "code": "SCOPE_DENIED",
  "message": "The requested account is outside the caller account scope.",
  "retryable": false,
  "suggestion": "Choose an account approved during pairing."
}
```

`code` 是机器处理字段；`message` 和可选 `suggestion` 可被本地化。可选 `details` 不是稳定应用协议，客户端不得依赖或记录它。

## MCP 外层映射

- 成功工具调用在 MCP 外层为正常工具结果，`structuredContent`（若客户端支持）包含上述包络。
- 失败工具调用保留相同错误包络，并由 MCP 标记为工具错误；客户端仍应读取 `error.code`，而不能只看自然语言内容。
- 面向不支持结构化内容的客户端，文本内容仅是同一包络的可读表示，不是第二套可解析 schema。
- 流式文本、工具调用进度、引用和完成事件由未来协商的 MCP 扩展承载；v1 客户端不得把 stdio 行猜作 NamiMail 自定义事件流。
