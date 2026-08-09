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

翻译只在当前阅读界面明确请求后处理选中邮件的纯文本正文。主题、地址、附件、HTML 和原始邮件不会通过这些端点传给翻译服务。

### `GET /api/translation/status`

返回当前运行时的可用性，不返回服务地址、API Key、模型缓存路径或邮件内容。

LibreTranslate 兼容运行时示例：

```json
{
  "enabled": true
}
```

Windows 本机 NLLB 运行时示例：

```json
{
  "enabled": false,
  "mode": "local",
  "local": {
    "mode": "local",
    "state": "unprepared",
    "downloadEstimatedBytes": 900000000,
    "progress": null
  }
}
```

`local.state` 为 `unprepared`、`preparing`、`ready` 或 `failed`。只有 `ready` 时 `enabled` 才为 `true`。准备失败时，`local.errorCode` 仅提供稳定的恢复类别，不包含下载 URL、文件路径或底层错误文本。

### `POST /api/translation/prepare`

仅 Windows 本机 NLLB 运行时支持。此请求不包含邮件内容；它只在用户已通过界面明确选择"准备本机翻译"后启动模型加载或下载。请求立即返回 `202 Accepted`，调用方应轮询状态端点，不应重复提交请求。

```json
{
  "ok": true,
  "mode": "local",
  "local": {
    "mode": "local",
    "state": "preparing",
    "downloadEstimatedBytes": 900000000,
    "progress": 42
  }
}
```

当运行时不使用本机模型时返回 `409` 和 `translation_preparation_unavailable`。本机模型无法开始准备时返回 `503`；常见稳定错误码包括：

- `translation_model_download_failed`：检查网络、VPN/代理和防火墙。
- `translation_model_cache_unavailable`：检查 Nami Mail 数据目录的可用空间和写权限。
- `translation_model_unavailable`：重新准备；持续失败时重启 Nami Mail 后再试。

### `POST /api/messages/:id/translate`

请求体：

```json
{
  "targetLocale": "zh-CN"
}
```

成功时返回：

```json
{
  "ok": true,
  "targetLocale": "zh-CN",
  "translatedText": "翻译后的正文"
}
```

外部 LibreTranslate 兼容运行时可以额外返回 `detectedLanguage`。本机 NLLB 不会把语言猜测伪装成检测结果。完整的数据边界、首次模型准备与故障处理见[邮件正文翻译](TRANSLATION.zh-CN.md)。

本机 NLLB 仅在 `local.state` 为 `ready` 时接受此请求。模型为 `unprepared`、`preparing` 或 `failed` 时返回 `409` 和 `translation_preparation_required`，且不会因翻译请求隐式下载或加载模型。调用方必须先向用户展示明确的准备操作，再轮询状态端点直到模型就绪。

## 兼容性与演进

- 调用方必须按 HTTP 状态和稳定 `code` 分支，不能解析中文或英文错误文本。
- `mode` 或 `local` 未出现时，调用方必须按既有外部翻译配置运行时处理，不能假设本机模型存在。
- 此文档只描述 GUI 所需的受保护本机协议。外部 Mail v1 使用独立的 Broker、配对、账户快照和权限契约；对外部 CLI、MCP、IPC 或网络接口的变更必须保持独立威胁模型、权限设计和端到端验证。
