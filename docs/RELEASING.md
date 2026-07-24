# Windows 发布指南

[简体中文](RELEASING.md) | [English](RELEASING.en.md)

本文面向维护者，说明 Nami Mail 的 Windows 安装包、GitHub Release 与 ZIP 自动更新流程。它只描述代码已经实现的行为；本地构建、单元测试或草稿 Release 都不能替代一次真实旧版到新版的安装验证。

## 发布模型

Nami Mail 的桌面更新只面向公开 GitHub Releases。客户端不携带 GitHub 访问令牌：它从 `https://api.github.com/repos/<owner>/<repo>/releases/latest` 查询公开稳定版本，再从同一个公开 Release 下载版本化 JSON 清单和 ZIP。

每个稳定 Release 必须精确包含以下五项资源：

| 资源 | 用途 |
| --- | --- |
| `Nami Mail Setup <version>.exe` | Windows NSIS 安装程序。 |
| `Nami Mail Setup <version>.exe.blockmap` | electron-builder 生成的安装程序块映射。 |
| `latest.yml` | electron-builder 生成的发行元数据。桌面 ZIP 更新不会将它当作信任来源。 |
| `nami-mail-update-<version>-win-x64.zip` | 只含一个根目录 NSIS 安装程序的 ZIP 更新包。 |
| `nami-mail-update-<version>-win-x64.json` | ZIP 的版本、文件名、大小、SHA-512 和可选 Ed25519 签名清单。 |

发布脚本先创建草稿 Release，再从 GitHub 重新下载这五项资源并逐项比较大小与 SHA-256。只有资源名称、数量和散列全部匹配，草稿才会被提升为正式稳定 Release。不要手工补传、替换或删除资源后继续将该 Release 视为已验证版本。

## 前提与信任根

- 使用 Windows x64、Node.js 22.14.0 或更高版本；
- 使用公开仓库 `QinIndexCode/nami-mail`，或在仓库迁移后更新所有构建和发行配置；
- `package.json` 的版本必须是精确的稳定语义版本 `x.y.z`，tag 必须精确为 `v<version>`；
- 发布输出目录必须是仓库内的相对隔离目录，例如 `release-artifacts/0.1.0`。默认输出已按当前版本使用 `release-artifacts/<package.json version>`；正式发布和并行验证仍应显式指定目录，不能复用旧构建物；
- 至少配置一种更新信任根。生产发行建议同时配置带时间戳的 Authenticode 签名和 Ed25519 清单签名。

| 信任根 | 需要的值 | 运行时行为 |
| --- | --- | --- |
| Authenticode | `CSC_LINK` 或 `CSC_NAME`，以及 `CSC_KEY_PASSWORD`、`NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER`、`NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT` | 若当前已安装程序有有效签名，安装助手只接受相同签名者的新安装程序。 |
| Ed25519 | `NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY`，值为 Base64 编码的 PKCS#8 Ed25519 私钥 | 打包时仅派生公钥并写入应用资源；客户端要求 JSON 清单拥有该私钥生成的签名。 |

如果当前安装程序没有可用的 Authenticode 签名，发行版必须带 Ed25519 公钥且 Release 清单必须带有效签名；否则更新功能会保持停用。私钥、证书、证书密码和 `GH_TOKEN` 只能存放在当前进程或 GitHub Secrets，不能写入 `.env`、应用资源、日志、提交、Release Notes 或 Issue。

GitHub Actions 使用下列 Secrets：

| Secret | 是否必需 | 用途 |
| --- | --- | --- |
| `NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY` | 没有 Authenticode 证书时必需 | Base64 PKCS#8 Ed25519 私钥；只传给发布 job 的打包步骤。 |
| `WINDOWS_CSC_LINK` | 使用 Authenticode 时必需 | electron-builder 可使用的证书路径、URL 或 Base64 内容。 |
| `WINDOWS_CSC_KEY_PASSWORD` | 按证书需要 | 证书密码。 |
| `WINDOWS_CSC_PUBLISHER` | 使用 Authenticode 时必需 | 独立固定的预期签名发布者。 |
| `WINDOWS_CSC_THUMBPRINT` | 使用 Authenticode 时必需 | 独立固定的 40 位 SHA-1 证书指纹。 |

`GITHUB_TOKEN` 由 GitHub Actions 在发布 job 中临时提供，不应创建一个长期令牌作为仓库 Secret。公开更新不支持在客户端内置私有仓库令牌。

## 本地预检

先更新 [变更日志](../CHANGELOG.md)，确认用户可见文案、许可和版本号都正确。执行与本次改动相关的检查，再执行完整基线：

```powershell
npm.cmd ci
npm.cmd run build:brand:check
npm.cmd run typecheck
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run build
npm.cmd run smoke:runtime
npm.cmd audit --omit=dev
```

升级 `better-sqlite3` 的主版本时，还必须针对一个已安装依赖的较旧稳定版工作树执行物理数据库兼容验证。该检查由旧版 Electron 保持一个 WAL 数据库连接，再由当前 Node 读取、写入、执行 `integrity_check`、checkpoint 和重开，最后重新由旧版读取；它不把旧版作为当前项目依赖，也不在 CI 中伪造旧二进制：

```powershell
npm.cmd run verify:legacy-sqlite-compat -- --legacy-root <older-stable-release-checkout>
```

传入路径必须是较旧稳定版本的独立工作树，不得指向正在使用的工作树或真实用户数据。旧版 `better-sqlite3` 需要先针对旧版 Electron ABI 编译：在该独立工作树中依次执行 `npm.cmd ci`、`node node_modules/electron/install.js` 和 `npm.cmd run rebuild:electron`，再运行上述命令。兼容检查只读取旧工作树，绝不会下载、重建或改写它；检查会在系统临时目录创建并在完成后删除无业务数据的测试数据库。

普通本地安装包不配置 GitHub 更新通道，可用于安装器基本验证：

```powershell
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
npm.cmd run package:win
npm.cmd run smoke:installer
```

GitHub 更新包预检使用公开仓库、隔离目录和至少一种信任根。下例使用 Ed25519；请在受控环境中提供真实私钥，绝不要把占位值或私钥写入任何文件：

```powershell
$env:NAMI_MAIL_GITHUB_REPOSITORY="QinIndexCode/nami-mail"
$env:NAMI_MAIL_RELEASE_DIRECTORY="release-artifacts/0.1.0"
$env:NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY="<Base64 PKCS#8 Ed25519 private key>"
npm.cmd run package:win:github
```

如使用 Authenticode，同时设置 `CSC_LINK`（或 `CSC_NAME`）、`CSC_KEY_PASSWORD`、`NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER` 和 `NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT`。`package:win:github` 会验证仓库公开性、构建五项资源并运行打包 smoke，但不会创建正式 Release。

## GitHub Actions 发布

`.github/workflows/release-windows.yml` 在推送 `v*` tag 时运行；发布脚本还会拒绝与 `package.json` 版本不相等的 tag。流程分为两个权限隔离的 job：

1. `validate` 只拥有读取权限，执行发布策略、类型检查、服务端/Web/桌面测试、运行时 smoke 与生产依赖审计。
2. `release` 绑定 GitHub 的 `release` Environment。验证通过后，受指定发布者批准，才会获得 Release 写入权限和 GitHub Secrets；不要移除这一人工确认，也不要在未受保护的环境中运行发布脚本。
3. `release` 固定 `NAMI_MAIL_RELEASE_DIRECTORY=release-artifacts/<tag>`，以 GitHub Secrets 完成签名或清单签名。
4. 打包步骤先在 runner 本地完成 Electron/NSIS 构建、ZIP 清单生成和打包 smoke；随后发布脚本创建唯一草稿 Release，并一次性上传安装程序、blockmap、`latest.yml`、ZIP 和 JSON 清单。若同一 tag 已有任何 Release 或出现多个草稿，流程会失败，维护者必须先检查并清理残留，不能拼接半成品资源。
5. 提升步骤使用同一隔离目录重新解析本地五项资源，下载远端草稿的每一项，核对大小和 SHA-256 后才发布稳定 Release。

本地手动发布仅适用于已具备发布权限的维护者：它还要求 `GH_TOKEN`、`GITHUB_REF_NAME=v<package.json version>` 和同一组 GitHub/信任根环境变量。优先推送签名 tag 并让工作流发布，避免在个人工作站混用不同的构建环境。

## Release Notes 与公开说明

每个稳定 Release 都应提供面向用户的简短说明，而不是只复制构建日志。至少写清：

- 版本号、主要用户可见变化、已修复的问题和已知限制；
- 是否完成了真实旧版到新版的公开网络更新验收。尚未完成时必须明确写为待验证；
- 该精确安装程序的 Authenticode 签名状态。没有有效签名时，必须说明 Windows SmartScreen 可能显示未知发布者提示，不能暗示用户应绕过系统警告；
- 数据兼容性、需要用户重新登录/重新授权的情况，以及是否存在不可逆迁移；
- 仅下载本 Release 的 `Nami Mail Setup <version>.exe` 进行手动安装。版本化 ZIP 和 JSON 是自动更新内部资源，不应让用户自行解压或运行。

本仓库将可公开审阅的版本说明放在 [Release Notes 目录](releases/README.md)。首发可直接使用 [v0.1.0 说明](releases/v0.1.0.md)，当前 `0.1.2` 使用 [正式说明](releases/v0.1.2.md)。保留的 [候选模板](releases/v0.1.1-candidate.md) 仅用于发布前检查；`v0.1.1` 仅为未发布资产的源码标签，不应作为安装来源。正式说明故意保留“尚未完成真实线上升级验收”的安全文案，只有完成本页末尾的全部真实验证并保存证据后，才能在后续版本说明中写为已完成。

发布说明不得包含 `GH_TOKEN`、证书、私钥、OAuth 凭据、真实邮件、测试账户数据或本地绝对路径。若发布后发现资源、签名、版本或更新清单不一致，应先撤销或标记该 Release，而不是静默替换文件。

## 客户端更新路径

应用启动后会延迟检查公开稳定 Release，并在运行期间定期检查。它只接受高于当前版本的 `x.y.z` 稳定 tag，拒绝草稿、预发布、降级、缺失或名称不符的资源。

1. 从 `releases/latest` 读取 tag 与资源清单，并要求 ZIP 和 JSON 的版本化文件名完全匹配。
2. 读取不超过 16 KiB 的 JSON 清单，核对版本、安装程序文件名、ZIP 文件名、大小和 SHA-512；如果当前版本使用 Ed25519 信任根，还会验证清单签名。
3. 在用户选择“更新此版本”后，将 ZIP 下载到用户数据目录的 `updates/<version>/`。下载过程中和下载完成后都核对大小与 SHA-512。
4. 用户选择“重启并更新”后，应用先安全关闭本地邮件服务和发件队列。辅助进程会再次验证 ZIP，拒绝包含多个文件、路径层级或非预期安装程序的归档；使用 Authenticode 信任根时还会复核当前程序和解压安装程序的签名者。Ed25519 路径在下载前已验证清单签名，并通过该清单绑定的 SHA-512 固定解出的安装程序，不把 JSON 或 ZIP 之外的元数据当作信任来源。
5. NSIS 安装程序以静默升级方式运行。成功后，辅助进程对 ZIP 和临时解压目录最多进行 5 次清理，每次失败后按递增的 100 毫秒等待并复查路径是否仍存在；若仍有残留，会记录不含敏感数据的 `cleanup` 阶段。新版本启动时只会对匹配该版本的更新缓存再次进行受限、尽力的清理：清理成功显示非打断式结果，仍无法清理则保留错误状态。若安装本身失败，助手会记录版本、阶段和时间，在按启动前哈希复核后尽力重新启动旧版；无法自动启动时，用户手动打开应用后会看到失败状态。Windows 同一用户的其他进程可造成文件锁定或改名，因此这不是绝对删除保证。

发现更新并不自动下载或重启。用户可以选择更新、跳过当前版本，或延后 1 小时、到明天、一周或 30 天；跳过会删除该版本的已下载 ZIP。网络、TLS、GitHub 限流、资源缺失和完整性失败会显示不同的可操作错误提示，且任何失败都不会安装未通过验证的文件。

## 发布后真实更新验证

自动更新只有在真实公开 Release、已安装旧版、已发布新版和实际网络条件下才算验证完成。至少在隔离测试数据目录完成以下验收：

1. 用同一信任根构建并安装一个较旧的稳定版，例如 `0.1.0`；创建可丢弃的账户或演示数据。
2. 使用更高版本（例如 `0.1.1`）推送精确 tag，确认 GitHub Actions 将其正式发布，并检查 Release 页面恰好包含五项资源。
3. 启动旧版，确认它请求公开 GitHub Release、弹出应用内提示，并能分别验证“更新此版本”“跳过此版本”和“稍后提醒”的行为。
4. 选择更新并完成下载，确认缓存 ZIP 的大小和 SHA-512 已被复核；选择重启更新，确认安装完成、旧版进程退出、新版重启，账户和本地设置保留。
5. 确认正常更新后 `updates/<version>/` 中的 ZIP 与临时展开目录已清理；如在 Windows 文件锁定条件下产生残留，确认启动时只针对该版本目录重试清理并给出用户可见状态，而不是删除其他版本或任意路径。分别保留一次网络中断、TLS 失败、404/缺资源、篡改清单或 ZIP、签名失败、同步未安全关闭和重复启动的可复查证据。

开发模式、普通本地安装包和没有 GitHub 更新配置或信任根的安装版必须显示为更新不可用，不能被记为已验证更新通道。发布完成后在 [README](../README.md)、[变更日志](../CHANGELOG.md) 和 Release Notes 中记录已验证的版本和已知限制。
