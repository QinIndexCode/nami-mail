# macOS 目标评估报告

[简体中文](macos-target-assessment.zh-CN.md) | [English](macos-target-assessment.en.md)

> 本文档评估 Nami Mail 从当前 Windows-only 支持扩展到 macOS（arm64 / x64）的目标。它只陈述代码中可验证的现状与需要新增的工作，不把“可行”表述为“已完成”。

## 结论

macOS 是一个独立的工程工作流，不能通过简单切换 electron-builder target 完成。当前桌面更新器、Broker 安全通道和安装/发布链路均为 Windows 专属；原生依赖需要为 darwin 重建。在获得 Apple Developer 证书、完成签名/公证链路并重做 Broker 通道之前，macOS 构建不应被宣称为受支持目标。本报告将该项明确记录为**范围外**（资源不允许时），并给出恢复该目标所需的验收清单。

## 当前可验证的平台现状

以下事实来自当前源码（apps/desktop、apps/web、package.json）：

| 组件 | 现状 | 平台 |
| --- | --- | --- |
| 数据目录 | `app.getPath("userData")` 下的 `data/`，凭据经 Electron `safeStorage` 加密 | 跨平台 |
| 桌面更新器 | `updater.mts` 在 `platform !== "win32"` 时直接返回 `unavailable/platformUnsupported` | 仅 Windows |
| 更新安装 | `zip-update-installer.mts` 依赖 Windows 文件锁定检测（rstrtmgr 语义）与 NSIS 静默升级 | 仅 Windows |
| Broker 安全通道 | `secure-pipe-relay.mts` 使用当前 Windows 用户 SID-DACL 命名管道；`nami-agent-pipe.ps1` 为 PowerShell 管道助手 | 仅 Windows |
| CLI 接入 | `namimail.cmd`、`namimail-path.ps1`（PATH shim）；打包目标为 NSIS `installerLanguages: zh_CN` | 仅 Windows |
| 安装包 | electron-builder `win.target: nsis`，`signExecutable: false`（签名需要外部证书与 `CSC_*` 环境变量） | 仅 Windows |
| 原生依赖 | `better-sqlite3`（需为 darwin 重建）；`sharp` 目前固定 `@img/sharp-win32-x64` | Windows 专属包 |
| 通知声音 | `playCustomNotificationSound` 已含 `darwin` 分支（`afplay`）与 Linux 回退（`aplay/paplay`） | 已有 macOS 分支 |
| 本地化 | 界面 i18n 走本机 locale catalog（zh-CN/en-US）；NSIS 安装器语言仅 zh_CN | 界面跨平台 |

## 新增 macOS 支持所需工作

1. **原生依赖**：为 macOS arm64 与 x64 重建 `better-sqlite3`；为 `sharp` 引入 `@img/sharp-darwin-arm64` / `@img/sharp-darwin-x64`；更新 `asarUnpack` 与 `npmRebuild` 配置。
2. **Broker 安全通道**：命名管道 + SID-DACL 是 Windows 专属。macOS 需以 Unix Domain Socket + 文件/套接字权限或 peer-credential 校验实现同等级别“仅当前用户可访问”，并保持现有“不能建立安全通道则拒绝启动，不回退到 TCP/HTTP”的不变量。
3. **CLI 与更新**：`namimail` shim 需要 macOS 等价物（如 `bin` 符号链接或 shell 包装）；更新器移除 `platform !== "win32"` 门槛，并为 `.zip`/`.app` 替换（而非 NSIS 静默升级）实现安装路径；`zip-update-installer` 的 Windows 文件锁定清理逻辑需按 macOS 语义重做。
4. **签名与公证**：需 Apple Developer ID Application 证书，electron-builder 配置 `mac.notarize`、hardened runtime 与 entitlements；Gatekeeper 要求公证后才能被用户顺利打开，这与 Windows SmartScreen 是两套独立信任体系。
5. **凭据与通知**：`safeStorage` 在 macOS 使用 Keychain；需验证账户凭据的 Keychain 访问权限（含未解锁时行为）。通知需请求 macOS 通知权限。
6. **发布链路**：新增 `dmg`/`zip` 目标、`latest-mac.yml` 更新清单生成与对应的 smoke 验收；发布检查清单需覆盖两个平台。

## 验收清单（若恢复该目标）

- [ ] macOS arm64/x64 均能完成 `npm run package:mac` 并产出 `dmg` + 版本化 ZIP + `latest-mac.yml`。
- [ ] 签名安装包通过 `spctl --assess` 与公证复核（`stapler validate`）。
- [ ] Broker 以非 Windows 通道实现“仅当前用户可访问”，`secure-pipe-relay.windows.test.ts` 的等价 macOS 测试通过。
- [ ] 桌面更新器在 macOS 上完成一次“旧版 → 新版”真实更新验收并记录。
- [ ] 全部 smoke（desktop/package/installer 的 macOS 等价项）通过。

## 范围声明

在 Apple 开发者证书、公证账号与 macOS 构建机可用之前，macOS 目标评估只停留在本文档；不宣称 macOS 已受支持，也不在 Release 说明中列出 macOS 下载。
