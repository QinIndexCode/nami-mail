# 贡献指南

感谢你帮助改进 Nami Mail。这个项目会处理真实邮件、账户凭据和本地缓存；每一项贡献都应把用户数据边界、可恢复性和可验证性放在功能速度之前。

## 开始前

- 使用前先阅读 [README](README.md)、[隐私与本地数据说明](docs/PRIVACY.md)、[安全策略](SECURITY.md) 和 [社区行为准则](CODE_OF_CONDUCT.md)。
- 漏洞、凭据泄露、可能读取其他用户邮件的路径，不要开公开 Issue；按 [SECURITY.md](SECURITY.md) 的流程私下报告。
- 不要提交真实邮件、附件、完整地址、OAuth 回调参数、访问令牌、应用专用密码、`.env` 或 `data/` 中的任何文件。用于复现的截图和日志必须脱敏。
- 涉及新服务商、同步语义、加密格式、数据库迁移、OAuth 权限或自动更新的较大改动，请先说明问题和方案，确认范围后再实现。

## 本地开发

项目要求 Node.js 22 或更高版本。在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run dev
```

开发模式使用 Vite 前端（默认 `http://127.0.0.1:5173`）和本地 Fastify 服务。需要运行构建后的本地服务时：

```powershell
npm.cmd run build
npm.cmd start
```

Windows 桌面壳可用以下命令启动：

```powershell
npm.cmd run dev:desktop
```

复制 [`.env.example`](.env.example) 为 `.env` 后，才按需填写本地开发配置。Google 和 Microsoft 的配置仅接受公共客户端 ID；不要在该文件或任何 Issue 中填写 client secret。

`better-sqlite3` 同时被命令行 Node 和 Electron 使用，两者 ABI 不同。请使用项目脚本准备或重建原生模块，不要在运行中的桌面应用旁随意执行通用 `npm rebuild`：

```powershell
npm.cmd run prepare:server-sqlite
npm.cmd run rebuild:electron
```

更多目录结构、测试和打包注意事项见 [开发说明](docs/DEVELOPMENT.md)。

## 提交改动

1. 改动应保持聚焦。不要借一次界面或文案修复顺带重排无关代码。
2. 为新行为补充针对性测试；修复缺陷时，测试应先能复现该问题。
3. 涉及界面交互时，至少在桌面和窄窗口检查焦点、键盘操作、文本溢出、主题和无障碍名称。
4. 涉及邮件内容时，视其为不可信输入。不要放宽 HTML 清理、远程资源限制、本地 API 访问令牌或缓存策略。
5. 涉及本地存储时，兼容已有数据库和加密载荷；任何迁移都应可检测、可重试，并且不能把敏感字段重新写成明文。

提交 Pull Request 前至少运行与改动相关的检查；完整基线如下：

```powershell
npm.cmd run build:brand:check
npm.cmd run typecheck
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run build
npm.cmd run smoke:runtime
```

Windows 安装包、签名和发布路径的额外步骤见 [发布指南](docs/RELEASING.md)。

## Fork 与 Pull Request

1. 从上游仓库 fork 项目，基于最新的 `main` 创建名称清晰的功能或修复分支；不要直接向上游 `main` 推送提交。
2. 在自己的 fork 中提交聚焦的改动。不要把 `.env`、测试账户、OAuth 回调参数、令牌、应用专用密码、证书、构建产物或本地数据一起推送。
3. 提交前先执行下面的完整本地检查。它与 GitHub 上 `Validate Pull Request / validate` 使用同一组验证命令；仅修正文档时也至少运行与改动相关的检查并在 PR 中说明未运行项。
4. 向上游 `main` 发起 Pull Request，按模板填写关联 Issue、用户可感知变化、验证证据和残余风险。来自 fork 的验证工作流只使用只读令牌，不读取发布或签名凭据；请不要尝试通过 PR 请求这些凭据。
5. 先等待 `Validate Pull Request / validate` 成功，再请求审查。当前 `main` 规则要求 PR、已解决的讨论、至少一位有效审批，以及基于最新 `main` 的 `validate`；新提交会使旧审批失效。`.github/CODEOWNERS` 会将 PR 自动路由给维护者，但不能替代远端规则或人工审查。常规协作者不能直接推送或强推；管理员仅应在紧急情况下绕过，并留下可审计的后续 PR。

完整本地检查：

```powershell
npm.cmd ci
npm.cmd run build:brand:check
node --test scripts/release-policy.test.mjs
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
npm.cmd --workspace @nami/web run test
npm.cmd run test:desktop-security
npm.cmd run smoke:runtime
npm.cmd audit --omit=dev --audit-level=high
```

## Pull Request 要求

- 使用仓库中的 PR 模板，说明用户可感知的变化、验证方式和未覆盖的风险。
- UI 改动提供脱敏截图或录屏，并注明检查过的窗口尺寸和主题。
- 邮件服务商改动写明服务商、认证方式、服务器协议和测试条件；不得上传真实账户信息。
- 修改依赖时说明原因、许可证影响和安全更新来源。
- 更新 README、隐私、安全或发布文档，只在行为实际改变时调整声明。

维护者会重点检查数据安全、错误恢复、兼容性和可复现验证，而不只看页面是否能显示。

## 审查与合并

- 审查者应确认 PR 描述中的关联 Issue、用户影响、测试结果和未覆盖风险与改动一致；绿色 CI 不能替代对邮件服务商、OAuth 或安装更新路径的实际核对。
- 合并前确认 `validate` 对当前 PR 提交仍为成功、讨论已解决且审批没有因新提交而失效。需要重新基于 `main` 时，更新分支后重新等待检查和审批。
- 不把发布凭据、签名、生产账户或真实用户数据交给 PR 工作流。发布只由受保护的标签工作流在发布环境中完成。
