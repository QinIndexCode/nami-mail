# 架构与信任边界
<!-- shipped-as: v0.5.1 -->

[简体中文](ARCHITECTURE.zh-CN.md) | [English](ARCHITECTURE.en.md)

本文面向贡献者和维护者，说明 Nami Mail 当前的本地运行结构、进程边界与主要信任假设。它是代码导览，不替代 [隐私与本地数据说明](PRIVACY.zh-CN.md)、[安全策略](../SECURITY.zh-CN.md) 或 [Windows 发布指南](RELEASING.zh-CN.md)。

## 运行结构

Nami Mail 没有项目自建的邮件代管服务。Windows 安装版由 Electron 启动一个只服务本机窗口的 Fastify 运行时；Web 开发模式则直接启动同一套前端和本地服务。

```text
React / Vite 界面
        |
        | 桌面版：受限 preload IPC
        v
Electron 主进程
        |
        | 每次启动生成的本地 API 访问令牌
        v
Fastify 本地服务 (127.0.0.1，桌面版使用动态端口)
        |                         |
        |                         +-- SQLite 与加密数据目录
        |
        +-- IMAP / SMTP / DNS / OAuth 服务商
        |
        +-- Agent 运行时（工具注册、权限、确认）与外部 MCP
```

桌面版窗口启用 `contextIsolation`、关闭 `nodeIntegration` 并使用沙箱化渲染器。访问令牌不会写入 URL、用户数据目录或普通配置；主进程只对来自本机 `/api/*` 的请求通过 `session.webRequest.onBeforeSendHeaders` 注入该请求头，渲染器不持有令牌本体；主帧校验守卫的是桌面 IPC 通道。渲染器因此不能借此获得通用 Node.js 或 Electron 能力。

## 组件职责

| 位置 | 职责 |
| --- | --- |
| `apps/web` | React 界面、主题、邮件阅读/撰写、账户引导和本地 API 客户端。 |
| `apps/web/src/app/mailStore.ts` † | 前端邮件列表状态的唯一 store：行级状态（已读/星标/移动/删除/恢复）由它统一持有；合计以最近一次服务端快照为基线做增量修正（`nextMessageTotalForSnapshot` 加少量本地加减），侧边栏徽标直接读 `/api/stats` 返回的 `stats`。写入方只声明邮件发生了什么变化，不再各自维护行状态。 |
| `apps/server` | Fastify 路由、IMAP/SMTP、OAuth、服务商发现、同步、草稿/发件队列、SQLite 与应用层加密；Agent 服务、工具执行与权限。 |
| `apps/server/src/tasks/` † | 持久任务层：单张 `tasks` 表、每账户串行调度器，以及按 kind 注册的 runner（`move`/`flags`/`undo`/`send`/`snooze`）把本地已提交的目标态收敛到 IMAP/SMTP，取代已删除的 `operation_queue`/`batch_jobs`；只读进度经 `/api/tasks`（`routes/tasks.ts`）与兼容别名 `/api/batch-jobs` 暴露。 |
| `apps/server/src/provider/` † | IMAP/SMTP 传输构造的唯一接缝：所有 ImapFlow 与 Nodemailer 实例都经同一工厂创建，测试与桌面宿主可在不改调用点的情况下替换网络实现。 |
| `apps/server/src/folder-counts.ts` † | 侧边栏计数的唯一来源：文件夹与统一收件箱计数从 `messages` 的当前行派生，替代已删除的 `folders.total`/`folders.unseen` 列。 |
| `apps/server/src/db-schema.ts`、`apps/server/src/schema-migrations.ts` † | 库结构的两半：`db-schema.ts` 是全新库的完整 DDL（含生成列与 FTS/任务 SQL 的拼装），`schema-migrations.ts` 是每次打开都在同一事务里幂等执行的旧库迁移。 |
| `apps/server/src/database-encryption.ts` † | SQLite 整库静态加密：把明文库复制后经 `PRAGMA rekey` 转换、校验再替换，覆盖 FTS 影子表与 WAL；库外的图片缓存与自定义背景由 `local-file-encryption.ts` 逐文件密封，驱动经 `native-sqlite.ts` 统一为 `better-sqlite3-multiple-ciphers`。 |
| `apps/server/src/pending-sent.ts` † | 乐观 Sent 行：发送受理时先写一条本地 Sent 占位行，sync 抓回服务商副本时按 RFC Message-ID 认领该行而不是插入重复行，发送未成功结算时收回。 |
| `apps/server/src/agent/` 的轮次辅助模块 † | run engine 拆分出的辅助件：`conversation-title.ts`（标题派生与模型 `TITLE:` 输出协议）、`turn-payloads.ts`（单轮对外载荷投影）、`tool-scope.ts`（工具账户范围归一）、`openai-compatible-content.ts`（OpenAI-compatible 内容格式）。 |
| `apps/desktop` | Electron 生命周期、单实例、托盘、Windows 通知、DPAPI 主密钥、preload IPC、更新检查与安装助手；Agent Broker、配对与 secure-pipe。 |
| `packages/agent-contracts` | Agent、CLI 与 MCP 共享的接口契约（外部 Mail v1 工具、Broker 协议、错误码）。 |
| `packages/agent-core` | Agent 会话编排与工具执行核心。 |
| `build` | 受版本控制的品牌资源、Windows 安装器资源及默认空更新信任配置。 |
| `scripts` | 原生 SQLite 加载验证、构建、安装器 smoke、Release 资源与发布策略校验。 |

† 标记的条目是 2026-10 主干新增，尚未随任何发行版发布；本页其余内容描述 v0.5.1 的发布行为。

## 数据与进程边界

- 桌面版本地服务固定绑定回环地址，使用系统分配的端口；开发服务默认使用 `127.0.0.1:3187`。
- Windows 桌面版主密钥由 Electron `safeStorage` 以当前 Windows 用户的 DPAPI 保护。主进程仅在启动本地运行时时将解封装的密钥以内存形式交给服务端。
- 服务端对凭据、OAuth 刷新令牌、邮件敏感载荷、发件队列和出站附件使用应用层 AES-256-GCM 加密；这不等同于 SQLite 整库加密，明文元数据及威胁边界详见 [隐私说明](PRIVACY.zh-CN.md)。整库静态加密属于主干新增能力（上表 † 项），尚未随版本发布，本节其余描述仍对应 v0.5.1 的发布行为。
- 邮件内容、附件名、服务器响应和 OAuth 回调都是不可信输入。修改解析、HTML 展示、附件下载或回调逻辑时，必须保留现有校验、清理和容量限制。
- † **附件可见性（2026-10 主干新增，未随 v0.5.1 发布；历史邮件的一次性元数据回填随同一批变更交付）**：`multipart/related` 内联部件（`related: true`，如正文内嵌图、签名图、追踪像素）属于正文资源，不算附件。`messages.has_attachments`、`attachment_kinds_json`、附件视图与侧边栏计数、过滤规则以及列表的回形针，都必须由同一份「非 related」元数据派生；阅读区展示的附件列表是这条规则的参考实现。
- Electron 使用单实例锁。再次打开应用时会恢复并聚焦已有窗口，而不是再启动一套本地服务、数据库或同步任务。

## 更新与关闭

正式 Windows 发行版从公开 GitHub Release 获取 ZIP 更新包。更新流程由当前安装程序的 Authenticode 身份或内置 Ed25519 公钥建立信任，不接受任意下载 URL。具体资产、签名要求、缓存清理、失败恢复和真实旧版到新版验证步骤见 [发布指南](RELEASING.zh-CN.md)。

关闭窗口可以由用户选择退出或最小化到托盘。最小化到托盘时本地服务继续同步并可显示通知；退出或更新前必须先关闭本地服务，避免 SQLite、同步或发件队列在安装过程中被并发访问。

## 变更准则

1. 界面变更同时验证桌面、窄窗口、浅色/深色主题、焦点顺序和可复制的邮件内容。
2. 服务端协议或数据变更同时验证网络/TLS 错误分类、幂等性、迁移兼容性和敏感数据不落明文。
3. Electron 变更同时验证单实例、托盘、关闭行为、更新前安全关闭和 Node/Electron 两个运行时的 SQLite 加载路径。
4. 发布或更新变更必须通过资源完整性、签名信任根和实际安装路径验证；单元测试或草稿 Release 不能替代真实线上升级验收。

相关开发命令与验证基线见 [开发说明](DEVELOPMENT.zh-CN.md)，协作约定见 [贡献指南](../CONTRIBUTING.zh-CN.md)。
