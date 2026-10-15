# 本机 Mail API 契约

[简体中文](LOCAL-API.zh-CN.md) | [English](LOCAL-API.en.md)

本页记录 Nami Mail 桌面界面与本机 Fastify 服务之间的受保护协议。它不是面向第三方应用、浏览器扩展或网络客户端的公开 API，也不能替代独立的已配对外部 Mail v1 CLI、MCP 或 Agent Broker 接口。

## 访问边界

- Windows 桌面版只在 `127.0.0.1` 的系统分配端口运行服务。监听地址和端口不稳定，不应作为集成地址保存或猜测。
- 除 `GET /api/health`、OAuth 一次性回调和 CORS 预检外，所有 `/api/*` 请求都需要本次启动生成的 `x-nami-api-token`。
- 该令牌只由 Electron 主进程在确认当前本机主窗口后注入，不写入 URL、用户数据目录、日志或普通配置。第三方程序、CLI、MCP 和浏览器扩展不能复用它。
- 开发模式可在无桌面令牌时运行同一服务，但仍必须限制在本机回环地址。不得据此扩大监听地址、CORS 来源或将本协议发布为远程 HTTP 服务。

更多进程和数据边界见[架构与信任边界](ARCHITECTURE.zh-CN.md)。外部调用方应使用[外部 Mail 接口](EXTERNAL-MAIL-INTERFACE.zh-CN.md)及其 CLI/MCP 说明；它们不会复用本机 HTTP token。

## 翻译能力

翻译只在当前阅读界面明确请求后处理选中邮件的纯文本正文。主题、地址、附件、HTML 和原始邮件不会通过这些端点传给翻译服务。运行时的三种翻译路径（内置免费翻译、LibreTranslate 兼容服务、LLM 翻译）见[邮件正文翻译](TRANSLATION.zh-CN.md)。

### `GET /api/translation/status`

返回当前运行时的可用性，不返回服务地址、API Key 或邮件内容。可能的响应形状：

未管理翻译配置的运行时（例如未开启受管配置时，`enabled` 取决于底层服务是否已配置，可为 `true` 或 `false`）：

```json
{
  "enabled": true
}
```

已管理翻译配置且未配置外部服务时，内置免费翻译（Google Translate + MyMemory 回退）始终可用：

```json
{
  "enabled": true,
  "mode": "builtin"
}
```

已配置外部服务时返回启用状态；配置存在错误时附带稳定的 `configurationError` 类别：

```json
{
  "enabled": false,
  "configurationError": "configuration_invalid_endpoint"
}
```

### `GET /api/translation/configuration` 与 `PUT /api/translation/configuration`

获取或更新翻译设置（包含 `primary`、`backup`、`endpoint` 及是否已配置 API key 等摘要）。未开启受管配置的运行时返回 `409` (`translation_configuration_managed`)；格式校验不通过时 `PUT` 返回 `400` (`translation_configuration_invalid`)。

### `POST /api/messages/:id/translate`

请求体：

```json
{
  "targetLocale": "zh-CN"
}
```

正文超过全局上限 50,000 字符（`MAX_TRANSLATION_TEXT_LENGTH`）时直接拒绝并返回 `413` (`translation_request_too_large`)。

正文不超过单块上限 5,000 字符时返回单个 JSON 结果：

```json
{
  "ok": true,
  "targetLocale": "zh-CN",
  "translatedText": "翻译后的正文"
}
```

外部 LibreTranslate 兼容运行时可以额外返回嵌套对象格式的 `detectedLanguage`。正文在 5,000 到 50,000 字符之间时会被智能拆分为多个分块，响应改为 `text/event-stream` 的 SSE 事件流：结果按块以事件形式推送，调用方必须按事件流消费，不能按 JSON 解析。

### `POST /api/translate-segments`

用于界面碎片化文本片段（例如邀请摘要等）的批量翻译，请求体包含 `segments: string[]` 与 `targetLocale: string`。

### `POST /api/messages/:id/translate-llm`

大语言模型流式翻译专属端点，通过 SSE 实时向阅读界面推送模型生成的 Markdown/文本。该端点受用户模型配置与云端内容授权开关严格门控，正文同样受 50,000 字符上限约束（超限返回 `413`）。完整的数据边界、三条翻译路径与故障处理见[邮件正文翻译](TRANSLATION.zh-CN.md)。

## 兼容性与演进

- 调用方必须按 HTTP 状态和稳定 `code` 分支，不能解析中文或英文错误文本。
- 未出现 `mode: "builtin"` 时，调用方必须按既有外部翻译配置运行时处理；`mode: "builtin"` 表示未配置外部服务，内置翻译始终可用。
- 此文档只描述 GUI 所需的受保护本机协议。外部 Mail v1 使用独立的 Broker、配对、账户快照和权限契约；对外部 CLI、MCP、IPC 或网络接口的变更必须保持独立威胁模型、权限设计和端到端验证。
