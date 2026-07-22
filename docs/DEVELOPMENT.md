# 开发说明

本文面向在本地构建、测试或修改 Nami Mail 的贡献者。项目主要面向 Windows 桌面版，同时保留本机 Web 开发流程。

## 前置条件

- Node.js 22.14.0 或更高版本；
- Windows（构建 NSIS 安装包和验证 Electron 路径时需要）；
- 用于实际邮箱验证的测试账户和应用专用密码/授权码。不要使用主密码，也不要把任何凭据写入代码、测试、截图或提交记录。

从项目根目录安装依赖：

```powershell
npm.cmd ci
```

复制 [`.env.example`](../.env.example) 为 `.env`，只按需修改开发服务配置。安装版只读取受限的 `nami-mail.env` OAuth 公共配置；完整规则见 [README](../README.md#oauth-配置)。

## 运行模式

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 联调前端和本地服务 | `npm.cmd run dev` | Vite 默认在 `127.0.0.1:5173`，本地 API 默认在 `127.0.0.1:3187`。 |
| 构建后服务 | `npm.cmd run build` 后执行 `npm.cmd start` | 用于检查构建产物和本地静态页面。 |
| Windows 桌面应用 | `npm.cmd run dev:desktop` | 会构建应用、验证 Electron 的 SQLite N-API 加载路径并启动 Electron。 |
| 命令行 Node SQLite 验证 | `npm.cmd run verify:node-sqlite` | 验证 Node 能加载根目录的共享 Windows x64 N-API 模块。 |
| Electron SQLite 验证 | `npm.cmd run verify:electron-sqlite` | 验证 Electron 能加载同一个 Windows x64 N-API 模块。 |

项目同时在 Node 和 Electron 中加载 `better-sqlite3`。Windows x64 的 v13 使用 `prebuilds/win32-x64.node` N-API 预编译模块，因此不再要求为每个 ABI 覆盖根目录二进制文件，也不再创建服务端 ABI 缓存。运行命令行测试/服务前可使用项目脚本验证 Node 的实际加载；运行桌面版或打包前使用 `npm.cmd run verify:electron-sqlite` 验证 Electron 的实际加载路径。不要在已打开的 Electron 应用上执行会覆盖根目录模块的手工重建。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `apps/web` | React/Vite 阅读、撰写、设置和服务商引导界面。 |
| `apps/server` | 本地 Fastify API、IMAP/SMTP、OAuth、SQLite、同步和加密数据处理。 |
| `apps/desktop` | Electron 主进程、preload、本机密钥保护、托盘/单实例和更新边界。 |
| `scripts` | 原生模块验证、构建、安装包 smoke 和 GitHub Release 校验。 |
| `build` | 受版本控制的品牌与 Windows 安装器资源。 |

本地运行数据和生成输出不应提交。`data/`、`.env`、旧本地构建目录 `release/`、`release-current/`、当前版本化输出 `release-artifacts/`、`artifacts/`、`output/`、SQLite 旁车文件、证书和密钥文件已经由 [`.gitignore`](../.gitignore) 排除。`build/` 保留品牌资源、安装器脚本和默认的空更新信任配置，属于受版本控制的源码，不能用宽泛忽略规则排除。

## 验证基线

先执行与改动最接近的测试，再执行以下完整基线：

```powershell
npm.cmd run build:brand:check
npm.cmd run typecheck
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run build
npm.cmd run smoke:runtime
```

`npm.cmd run test` 是服务端测试入口；Web 与桌面测试需要单独执行。实际 Windows 安装器验证还需要：

```powershell
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win
npm.cmd run smoke:installer
```

安装器 smoke 会创建并删除隔离安装目录，并拒绝在已有 Nami Mail 安装或进程存在时运行。不要把它当作运行中真实数据的升级测试替代品。

GitHub 更新发布使用版本化隔离目录，避免不同构建的资源混入同一个 Release 集合：

```powershell
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win:github
```

该变量必须是仓库内的相对路径。它不会替代 [发布指南](RELEASING.md) 中对公开仓库、信任根和真实旧版到新版验证的要求。

## 修改原则

- 邮件 HTML、附件名、服务器返回和 OAuth 回调都属于不可信输入；保持现有校验、清理和本地回环限制。
- 凭据、刷新令牌、邮件载荷、发件队列和出站附件的存储改动必须维持加密与关联数据完整性；不要记录明文。
- 本地 API 只应服务同机客户端。不要扩大监听地址、CORS 来源或 Electron IPC 能力，除非有明确的威胁模型和测试。
- UI 变更要验证桌面、移动窄宽、浅色/深色主题、键盘焦点和可复制的邮件内容。
- 依赖和打包变更要同时检查 Node ABI、Electron ABI、安装/卸载、单实例和数据保留路径。

贡献流程和代码审查要求见 [贡献指南](../CONTRIBUTING.md)。发布和签名流程见 [发布指南](RELEASING.md)，进程与数据边界见 [架构与信任边界](ARCHITECTURE.md)。
