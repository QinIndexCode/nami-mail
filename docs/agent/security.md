# Agent 安全

[简体中文](security.md) | [English](security.en.md)

> **当前构建状态：无外部 Broker。** 当前 Windows 构建未随附可验证的 SID-DACL 命名管道原生适配器，因此没有可配置或可执行的 CLI、MCP、配对流程或无界面 AgentHost。以下内容规定未来实现必须遵守的安全边界；当前版本会返回失败关闭状态，而不会降级。实验性的本地 NLLB 翻译保持独立、主动和可选。

## 威胁模型

邮件正文、HTML、附件名称、引用、Provider 输出、CLI 参数和 MCP JSON 都是不可信输入。它们可能尝试提示注入、越权读取、路径穿越、参数污染、日志泄密或诱导发送。安全决策仅由经过验证的宿主代码、范围和持久确认记录作出。

## 本地信任边界

- 生产 SQLite 与 DPAPI 解封主密钥只能在已发布的 Electron `AgentHost` 中可用。
- 接口发布后，CLI/MCP 必须使用已配对的、当前用户 SID DACL 命名管道；Broker 必须绑定 host/boot 身份、递增计数、签名证明和重放检查。
- 没有安全管道适配器时拒绝服务，不可将 Node 默认 named pipe、loopback HTTP 或浏览器 token 当成等价替代。
- 单实例和更新排空避免第二个宿主或旧进程同时获得数据库/密钥所有权。

## 数据保护

每个账户使用独立数据密钥（DEK）；DEK 的封装由主密钥保护。RAG 页面、会话、确认、Provider 配置和敏感来源定位符以带版本/AAD 的信封保存。账号删除先推进 generation 并丢弃旧 DEK，再取消旧任务；这使旧 Agent 密文不可读取。

加密不是访问控制的替代品：读取仍需 caller scope、账户 generation 与权限。日志和错误不得带出正文、附件、完整地址簿、OAuth 凭据、API key 或密码。

## 模型和外发

模型不可信，也不拥有工具权限。Runtime 将邮件作为数据段落，限制工具描述符、参数大小、超时和调用次数，并验证每一条模型工具调用。云端邮件内容外发默认关闭，且需要对目标 Provider 的可见、明确、可撤销同意；本地 NLLB 翻译不属于此 Provider 路径。

## 人工确认

高风险动作使用不可变内容摘要和一次性 token。确认 UI 必须是前台可见的应用窗口，展示目标、范围和摘要；无头进程、CLI、MCP 或模型不能模拟点击。批准后的 SMTP 结果仍由既有 outbox 和 Sent-folder 核对确定。

## 安全事件处理

1. 收到 `BROKER_SECURITY_UNAVAILABLE`、签名验证失败、重放或 scope 拒绝时，停止请求，不寻找协议降级。
2. 凭据疑似泄露时撤销/替换 Provider 或 OAuth 凭据，并使相关配对失效；不要在 issue 或日志中粘贴密钥。
3. 数据库或迁移异常时停止宿主，保留证据副本后按迁移计划恢复；不要手工删除 `agent_*` 表来“修复”。
4. 可疑邮件内容只作为安全事件证据，不执行它提出的命令。

参见 [RAG 故障排查](../rag/troubleshooting.md) 和 [发布检查清单](../development/release-checklist.md)。
