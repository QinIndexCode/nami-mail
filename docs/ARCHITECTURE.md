# 架构与信任边界

[简体中文](ARCHITECTURE.md) | [English](ARCHITECTURE.en.md)

本文面向贡献者和维护者，说明 Nami Mail 当前的本地运行结构、进程边界与主要信任假设。它是代码导览，不替代 [隐私与本地数据说明](PRIVACY.md)、[安全策略](../SECURITY.md) 或 [Windows 发布指南](RELEASING.md)。

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
```

桌面版窗口启用 `contextIsolation`、关闭 `nodeIntegration` 并使用沙箱化渲染器。访问令牌不会写入 URL、用户数据目录或普通配置；主进程在校验调用者确为当前主窗口的本地主帧后，才通过受限 preload IPC 向该页面提供本地 API 请求头。渲染器因此只能把它用于本机 `/api/*` 请求，不能借此获得通用 Node.js 或 Electron 能力。

## 组件职责

| 位置 | 职责 |
| --- | --- |
| `apps/web` | React 界面、主题、邮件阅读/撰写、账户引导和本地 API 客户端。 |
| `apps/server` | Fastify 路由、IMAP/SMTP、OAuth、服务商发现、同步、草稿/发件队列、SQLite 与应用层加密。 |
| `apps/desktop` | Electron 生命周期、单实例、托盘、Windows 通知、DPAPI 主密钥、preload IPC、更新检查与安装助手。 |
| `build` | 受版本控制的品牌资源、Windows 安装器资源及默认空更新信任配置。 |
| `scripts` | 原生 SQLite 加载验证、构建、安装器 smoke、Release 资源与发布策略校验。 |

## 数据与进程边界

- 桌面版本地服务固定绑定回环地址，使用系统分配的端口；开发服务默认使用 `127.0.0.1:3187`。
- Windows 桌面版主密钥由 Electron `safeStorage` 以当前 Windows 用户的 DPAPI 保护。主进程仅在启动本地运行时时将解封装的密钥以内存形式交给服务端。
- 服务端对凭据、OAuth 刷新令牌、邮件敏感载荷、发件队列和出站附件使用应用层 AES-256-GCM 加密；这不等同于 SQLite 整库加密，明文元数据及威胁边界详见 [隐私说明](PRIVACY.md)。
- 邮件内容、附件名、服务器响应和 OAuth 回调都是不可信输入。修改解析、HTML 展示、附件下载或回调逻辑时，必须保留现有校验、清理和容量限制。
- Electron 使用单实例锁。再次打开应用时会恢复并聚焦已有窗口，而不是再启动一套本地服务、数据库或同步任务。

## 更新与关闭

正式 Windows 发行版从公开 GitHub Release 获取 ZIP 更新包。更新流程由当前安装程序的 Authenticode 身份或内置 Ed25519 公钥建立信任，不接受任意下载 URL。具体资产、签名要求、缓存清理、失败恢复和真实旧版到新版验证步骤见 [发布指南](RELEASING.md)。

关闭窗口可以由用户选择退出或最小化到托盘。最小化到托盘时本地服务继续同步并可显示通知；退出或更新前必须先关闭本地服务，避免 SQLite、同步或发件队列在安装过程中被并发访问。

## 变更准则

1. 界面变更同时验证桌面、窄窗口、浅色/深色主题、焦点顺序和可复制的邮件内容。
2. 服务端协议或数据变更同时验证网络/TLS 错误分类、幂等性、迁移兼容性和敏感数据不落明文。
3. Electron 变更同时验证单实例、托盘、关闭行为、更新前安全关闭和 Node/Electron 两个运行时的 SQLite 加载路径。
4. 发布或更新变更必须通过资源完整性、签名信任根和实际安装路径验证；单元测试或草稿 Release 不能替代真实线上升级验收。

相关开发命令与验证基线见 [开发说明](DEVELOPMENT.md)，协作约定见 [贡献指南](../CONTRIBUTING.md)。
