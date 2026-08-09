# NamiMail Agent 实施计划

[简体中文](implementation-plan.zh-CN.md) | [English](implementation-plan.en.md)

## 范围与不变量

本计划为本地优先的 NamiMail Agent、邮件检索、命令行和 MCP 接入定义实现顺序。它不改变现有 IMAP 同步、SMTP 幂等提交或“已发送”文件夹核对语义。

- Electron `AgentHost` 是桌面生产环境中唯一持有 DPAPI 解封主密钥、SQLite、同步、更新生命周期和 Agent Runtime 的进程。
- GUI、CLI 与 MCP 使用同一套 `@nami/agent-core` 工具注册表和权限引擎；CLI/MCP 绝不直接打开 SQLite，也不复用渲染器的本地 API 令牌。
- 外部调用仅通过配对后的本地 Broker。不能安全建立当前用户 SID DACL 命名管道时，功能必须拒绝启动，不回退到 TCP/HTTP。
- 邮件和附件是非可信数据。模型只能把它们当作上下文，不能把正文中的内容当作系统指令或权限。
- 云端模型外发默认关闭；用户须在可见设置中针对 Provider 明确授权后，才会将选定上下文发送到该 Provider。
- 发送、转发、永久删除和批量写入只能经一次性、不可变、可见的 GUI 确认。`--yes`、MCP 或模型输出都不能绕过它。
- 实验性本地 NLLB-200 翻译保持独立且可选。它不会成为 Agent 的默认模型、不会自动翻译邮件，也不改变现有主动翻译提示。

## 分期

| 阶段 | 输出 | 验收 | 回滚 |
| --- | --- | --- | --- |
| 1. 共享基础 | 版本化 contracts、工具注册表、默认拒绝权限引擎、Provider 能力模型 | contracts/core 单测；无 Provider 时失败可解释 | 不创建 Agent 数据即可停用 |
| 2. 安全持久层 | Agent 专属版本表、账户代际围栏、加密 DEK、来源事件 Outbox、会话与审计记录 | 迁移可重复；删除账户后旧 DEK 不能解密 | 停止 Runtime；主邮件库不受影响 |
| 3. 只读工具与 RAG | 邮件清洗、结构化分块、加密页面、内存检索、来源引用、增量/删除处理 | 同步更新和删除均产生可追踪事件；检索不返回已删除数据 | 清理 Agent 索引后可重建 |
| 4. 应用内聊天 | 会话、流式状态、来源、范围选择、上下文、停止/重试、确认面板 | 键盘可用、主题一致、无 Provider 时可恢复提示 | 关闭 Agent 工作区，不影响邮件界面 |
| 5. 写入工具 | 草稿、回复/转发草稿、标记、移动、归档和发送确认 | 高风险写入未经确认被拒绝；复用现有发件幂等性 | 禁用写工具，保留只读 Agent |
| 6. CLI 与 MCP | 配对、Broker、只读 CLI/MCP、稳定 JSON 错误与审计 | GUI 未启动时明确失败或显式启动服务；不访问 SQLite | 注销 PATH shim，撤销配对 |
| 7. 发布准备 | 文档、迁移/故障测试、Electron/安装包验证 | Node、Electron、安装版与更新排空路径均验证 | 不发布远程仓库或 Release |

## 文件职责

| 模块 | 目录 | 职责 |
| --- | --- | --- |
| 协议 | `packages/agent-contracts` | 可版本化 schema、错误、事件、Caller 与确认契约 |
| 核心 | `packages/agent-core` | 工具注册、权限决策、Provider 适配和运行时编排 |
| RAG 存储 | `apps/server/src/agent` | SQLite schema、加密、生命周期围栏、事件和检索服务 |
| 邮件接线 | `apps/server/src` | 同步/删除后的事务事件、HTTP GUI Adapter、既有邮件服务复用 |
| 桌面宿主 | `apps/desktop/src/agent`、`main.mts` | SID DACL 租约、Broker、更新排空、单实例、CLI 服务模式 |
| 界面 | `apps/web/src` | 聊天工作区、可见确认、来源、Provider/隐私设置和本地化 |
| 文档 | `docs/{agent,rag,cli,mcp,development}` | 协议、操作边界、迁移、故障处理和验收说明 |

## 验收矩阵

1. 单元：schema、规范化、清洗、分块、加密 AAD、权限、Provider 错误、CLI 解析、MCP schema。
2. 集成：同一 SQLite 事务内邮件变更和来源事件、账户删除围栏、重试、检索过滤、GUI 确认、Broker 配对。
3. 端到端：打开 Agent、选择范围、提问、展示来源、保存草稿、确认发送、CLI/MCP 只读查询。
4. 故障：模型超时/限流、网络离线、数据库锁、同步删除、重复事件、崩溃恢复、更新排空失败、恶意邮件提示注入。
5. 发布：Node 类型检查和测试、Web 构建、Electron SQLite 验证、桌面 smoke、安装/卸载和更新 ZIP 清理。

## 未接受的方案

- 不新增另一个浏览器可访问的本地 HTTP Agent API；它无法替代经 SID DACL 和配对认证的 Broker。
- 不将向量数据库作为独立常驻服务。首版使用与邮箱数据库同生命周期的加密持久页面和内存检索结构，避免 Electron 原生模块分发风险；Embedding 索引作为可替换实现。
- 不让模型或外部 CLI 直接执行 SMTP 发送。它们只能创建意图和草稿，最终由 GUI 的一次性确认调用既有发送路径。
