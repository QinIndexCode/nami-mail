# CLI 退出码

[English](exit-codes.en.md) | [输出 Schema](output-schema.zh-CN.md)

> **当前构建状态：已实现。** 0.3.0 构建随附 `namimail` CLI，并向终端提供下列退出码。

退出码方便 shell 控制流；结构化 JSON 中的 `error.code` 才是精确分类。即使退出码为非零，也应先解析 JSON 包络再决定是否重试。

| 退出码 | 含义 | 典型错误代码 | 建议 |
| --- | --- | --- | --- |
| `0` | 成功 | 无 | 使用 `data`。 |
| `1` | 未归类的 Agent、Broker、Provider 或工具错误 | `BROKER_SECURITY_UNAVAILABLE`、`PROVIDER_*`、`TOOL_*` | 读取 JSON `error.code`；不要仅按 `1` 猜测原因。 |
| `2` | 命令或参数无效 | `INVALID_ARGUMENT`、`TOOL_INPUT_INVALID` | 修正命令、选项或 Tool Schema 输入。 |
| `3` | 宿主或独占租约不可用 | `HOST_UNAVAILABLE`、`HOST_LEASE_UNAVAILABLE` | 打开 NamiMail 或运行 `namimail service start`；不要启动第二个 Runtime。 |
| `4` | 配对、签名或重放防护失败 | `PAIRING_REQUIRED`、`PAIRING_REVOKED`、`PAIRING_EXPIRED`、`BROKER_AUTHENTICATION_FAILED`、`BROKER_REPLAY_DETECTED`、`BROKER_COUNTER_INVALID` | 重新配对、撤销失效客户端或修复客户端计数器；不要重放请求。 |
| `5` | 更新排空中 | `UPDATE_IN_PROGRESS` | 等待安装或恢复完成后重试。 |
| `6` | 权限或 Runtime 边界违规 | `PERMISSION_DENIED`、`SCOPE_DENIED`、`CLI_RUNTIME_FORBIDDEN` | 使用可见 GUI 处理写操作，或改用允许的只读范围；不要改用数据库直连。 |

未来新增错误码可能继续映射到 `1`，以保留现有 shell 兼容性。因此自动化必须同时保存退出码和 `requestId`，并根据稳定的 `error.code` 决策。
