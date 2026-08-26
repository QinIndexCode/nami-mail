# CLI 输出 Schema

[English](output-schema.en.md) | [退出码](exit-codes.md)

> **未来契约，当前不可执行。** 当前构建没有外部 CLI、Broker 或 JSON 命令输出。下列包络定义验证过的 Windows SID-DACL 原生适配器发布后的机器接口；示例不是可调用响应。

接口发布后，`--output json` 将是脚本接口。每次调用将输出一个稳定包络，成功与失败均写入标准输出：

```json
{
  "protocolVersion": "1.0",
  "requestId": "123e4567-e89b-12d3-a456-426614174004",
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "durationMs": 18,
    "version": "0.2.3"
  }
}
```

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `protocolVersion` | 字符串 | 当前 Agent 协议为 `1.0`。不兼容版本必须显式协商或失败。 |
| `requestId` | UUID | 每次调用唯一；用于支持、审计和重试关联。 |
| `success` | 布尔 | `true` 时 `error` 为 `null`；`false` 时 `data` 为 `null`。 |
| `data` | JSON 或 `null` | 成功时由具体宿主 Tool Schema 定义。 |
| `error` | 对象或 `null` | 失败时为稳定错误结构。 |
| `meta.durationMs` | 非负整数 | CLI 可观察的总耗时。 |
| `meta.version` | 字符串 | NamiMail 应用版本，不等同于协议版本。 |

## 错误结构

```json
{
  "code": "HOST_UNAVAILABLE",
  "message": "NamiMail Agent host is not available.",
  "retryable": true,
  "suggestion": "The external Agent interface is unavailable in this build."
}
```

`code` 将是程序处理依据；`message` 和可选 `suggestion` 面向用户，可随本地化改写。`retryable` 仅说明立即重试是否可能有意义，并不保证成功。实现可提供可选 `details` 对象，但调用方不得假设存在，也不得将其写入日志。

常见代码包括 `INVALID_ARGUMENT`、`HOST_UNAVAILABLE`、`UPDATE_IN_PROGRESS`、`PAIRING_REQUIRED`、`PAIRING_REVOKED`、`BROKER_AUTHENTICATION_FAILED`、`BROKER_REPLAY_DETECTED`、`PERMISSION_DENIED`、`SCOPE_DENIED`、`RAG_NOT_READY`、`PROVIDER_UNAVAILABLE` 和 `PROVIDER_TIMEOUT`。完整分组和恢复动作见[排错](troubleshooting.md)。

## 其他格式

| 格式 | 成功输出 | 失败输出 | 适用场景 |
| --- | --- | --- | --- |
| `json` | 一个紧凑 JSON 包络及换行。 | 同一 JSON 包络。 | 脚本和外部 Agent。 |
| `jsonl` | 当前每次调用输出一行完整包络。 | 一行失败包络。 | 可逐行消费的批处理。 |
| `table` | 数组对象时渲染列；其他值渲染文本。 | 标准错误输出。 | 人工查看。 |
| `text` | 字符串原样或格式化 JSON。 | 标准错误输出。 | 人工查看。 |

`jsonl` 目前不承诺把流式 Agent 事件拆成多行。需要流式交互的客户端应使用 MCP 的协商能力或等待后续显式事件协议，而不能猜测行格式。
