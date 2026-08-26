# Agent/RAG 测试计划

[简体中文](testing-plan.md) | [English](testing-plan.en.md)

## 原则

测试结果只证明已执行的层级。Node 单测、Web 构建、Electron 主进程、安装包、真实更新与实际安全 IPC 是不同证据，不能互相替代。夹具必须是合成邮件，不含真实正文、凭据或验证码。

## 常用命令

在 Windows 使用 `npm.cmd`：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run verify:node-sqlite
npm.cmd run verify:electron-sqlite
npm.cmd run smoke:runtime
npm.cmd run smoke:desktop
npm.cmd run smoke:package
npm.cmd run smoke:installer
```

按风险可运行单个 workspace，例如 `npm.cmd --workspace @nami/server run test`。Electron `better-sqlite3` ABI 与 Node ABI 不同；在 Electron smoke 前必须运行相应验证/重建步骤，不能将 ABI 故障误判为 Agent 逻辑失败。

## 测试矩阵

| 层级 | 重点 |
| --- | --- |
| 契约/核心单元 | schema、错误信封、工具解析、默认拒绝、确认 hash、审计缺失拒绝、Provider 错误归一化 |
| RAG 单元 | HTML/纯文本清洗、引用/签名、CJK token 估算、确定性分块、加密 AAD、来源事件 claim/重试/去重 |
| 存储集成 | V1/V2 迁移、账号 generation、DEK 丢弃、会话/确认/审计不可变、同事务邮件事件 |
| 邮件集成 | 同步 upsert/delete、移动/归档、未知发件状态、Sent-folder 核对不被 Agent 改写 |
| Provider/Runtime | 未配置、未同意外发、超时、TLS/网络、认证、限流、取消、非法工具调用、流终止 |
| CLI/MCP | parser、JSON envelope、只读拒绝、配对/重放/范围、stdio schema、GUI 未运行错误 |
| GUI | 范围选择、加载/错误/空状态、可选择/复制文本与来源、可见确认、无模糊遮罩/无白色焦点条 |
| Desktop/安装 | 单实例、服务模式、SID-DACL 适配器、更新排空/恢复、SQLite ABI、安装/卸载/更新 ZIP 清理 |

## 必测攻击与故障

- 邮件 HTML/正文中伪造“系统指令”或工具调用。
- CLI/MCP 伪造 scope、重放 counter、错误 host/boot 签名。
- 账号删除与进行中的摄取、查询、确认、发送并发。
- 数据库锁、进程崩溃、重复/乱序来源事件、迁移失败、内存索引丢失。
- Provider 返回无效 JSON、过大 frame、超大工具参数、401/429/5xx、TLS/离线。
- 更新开始后新请求、排空失败、安装器启动失败和恢复。

## 发布前人工验证

至少在安装版 Windows 应用中验证安全管道真实 DACL（不是 mock）、CLI/MCP 只读访问、用户可见确认、账号删除不可读取旧内容、更新排空、应用重启后的 RAG 重建以及本地 NLLB 翻译仍是可选主动功能。没有这些证据，不得将功能标记为 release-ready。

参见 [发布检查清单](release-checklist.md) 和 [RAG 故障排查](../rag/troubleshooting.md)。
