# Nami Mail

Nami Mail 是一个本地优先的多账户 Web 邮箱客户端。它把 Gmail、iCloud、QQ、163、Outlook/Hotmail、Yahoo、AOL、Fastmail、Yandex 以及其他支持 IMAP/SMTP 的邮箱放进同一个收件箱中，界面只要求输入 `email + password`。

> `password` 是统一的凭据输入框：Gmail 和 iCloud 通常填写应用专用密码，QQ/163 填写客户端授权码，普通自建邮箱填写邮箱密码。凭据不会发送到 Nami Mail 以外的服务，只用于直接连接对应邮箱服务商。

## 运行

需要 Node.js 22 或更高版本。

```powershell
cd D:\MyCode\gonxueyun\local-mail-hub
npm.cmd install
npm.cmd run build
npm.cmd start
```

浏览器打开 [http://127.0.0.1:3187](http://127.0.0.1:3187)。开发模式使用：

```powershell
npm.cmd run dev
```

## 添加邮箱

点击左侧的“添加邮箱”，输入邮箱地址和密码/授权码。Nami Mail 会根据邮箱域名自动选择服务器，不要求用户填写 IMAP、SMTP、端口或加密方式。

输入邮箱地址后，添加弹窗会自动显示该服务商的两步验证、应用专用密码或授权码获取步骤，并提供官方设置入口。这里填写的是服务商生成的长期专用凭据，不是短信、邮件或验证器中的一次性验证码；表单仍然只有 `email + password` 两个字段。

| 服务商 | `password` 中填写 | 说明 |
| --- | --- | --- |
| Gmail | 应用专用密码 | Google 账号需启用两步验证；部分组织账号可能禁用应用密码。 |
| iCloud | 应用专用密码 | 使用 Apple 账号生成的应用专用密码。 |
| QQ 邮箱 | IMAP/SMTP 授权码 | 需要先在 QQ 邮箱设置中开启对应服务。 |
| 163 / 126 / yeah.net | 客户端授权码 | 需要先在邮箱设置中开启 IMAP/SMTP。 |
| Outlook / Hotmail | 受账号策略影响 | Microsoft 个人/组织邮箱正在淘汰基础密码认证；若服务端拒绝普通密码，当前版本会明确提示需要 OAuth 2.0。 |
| Yahoo / AOL | 应用密码 | 两者都要求为第三方邮件客户端生成专用密码。 |
| Fastmail | 应用专用密码 | 需要支持第三方 IMAP/SMTP 的方案；Basic 方案不支持。 |
| Yandex | 应用专用密码 | 先在设置中启用 IMAP，再创建应用密码；用户名使用地址本地部分。 |
| 其他邮箱 | 邮箱密码或服务商授权码 | 先尝试 DNS 自动发现，再回退到标准 `imap.<域名>` / `smtp.<域名>`。 |

## 功能

- 多账户统一收件箱、账户筛选、搜索与未读状态
- 自动识别常见邮箱服务商，添加账户仅需两个字段
- 后台周期同步和手动同步
- 首次连接即同步全部可选文件夹；默认每个文件夹缓存最近 200 封，可通过 `SYNC_MESSAGE_LIMIT` 调整
- 邮件阅读、纯文本/安全 HTML 展示、标记已读
- 使用对应账户通过 SMTP 撰写和发送邮件
- 深色/浅色主题、桌面三栏和移动端响应式布局
- 本地 SQLite 存储；密码使用 AES-256-GCM 加密后落盘

## 本地数据和安全

- 数据库：`data/nami-mail.db`
- 本地主密钥：`data/master.key`
- 服务默认只监听 `127.0.0.1`，不会开放给局域网。
- 主密钥和数据库都已加入 `.gitignore`。备份时必须同时保护这两个文件。
- 邮件 HTML 在展示前经过清理，并默认移除远程图片、脚本、表单和嵌入内容，减少跟踪与脚本风险。

## 公开仓库边界

这个目录可以作为独立项目提交，但不要把 `data/`、`.env`、数据库旁车文件或任何真实邮箱导出文件加入提交。它们已经由本目录的 `.gitignore` 排除；公开发布前请用 `git status --short --ignored` 和 `git check-ignore -v data/master.key .env` 再检查一次。当前工作区的父目录远程仓库是公开项目，不能直接把本项目目录当作它的无差别提交内容。

可以复制 `.env.example` 为 `.env` 修改端口、数据路径、同步间隔或日志级别。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd audit --omit=dev
```

## 技术结构

- Web：React、TypeScript、Vite
- API：Fastify、TypeScript
- 邮件：ImapFlow、MailParser、Nodemailer
- 存储：SQLite（better-sqlite3）
- 密钥保护：Node.js `crypto` + AES-256-GCM

架构参考了 [ImapFlow](https://github.com/postalsys/imapflow)、[Stork](https://github.com/paperkite-hq/stork) 和 [MailGo](https://github.com/MengMengCode/MailGo) 的公开实现思路，但项目本身采用轻量的全 Node.js 本地架构，不依赖 MySQL 或 Redis。
