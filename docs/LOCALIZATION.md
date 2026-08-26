# 本地化说明

[简体中文](LOCALIZATION.md) | [English](LOCALIZATION.en.md)

本说明定义 Nami Mail 界面文案和仓库文档的本地化约定。邮件主题、正文、发件人、收件人、附件名和用户创建的文件夹名称属于用户数据，不应被翻译或写入语言包。

## 界面语言包

界面语言包位于 `apps/web/src/locales/*.json`。构建时通过 `import.meta.glob` 自动发现它们；应用不会在运行时从用户磁盘、网络地址或任意上传文件加载语言包。

每个文件必须是合法 JSON，并采用下面的结构：

```json
{
  "meta": {
    "locale": "en-US",
    "nativeName": "English (United States)"
  },
  "messages": {
    "settings.language": "Language",
    "mail.unreadCount": "{count} unread"
  }
}
```

- `meta.locale` 必须使用规范化后的 BCP-47 语言标记，并且在所有语言包中唯一；文件名也必须与该标记完全一致，例如 `en-US.json` 中使用 `"locale": "en-US"`，不能使用 `en-us`、前后空格或其他别名写法；
- `meta.nativeName` 使用该语言的本地名称，供语言选择器显示；
- `messages` 使用扁平的点分 key；key 描述稳定的产品含义，而不是当前中文或英文句子；
- `{name}` 形式的占位符必须在所有语言中保留相同名称和语义；不要依赖字符串拼接组织语序；
- `zh-CN` 是必需的回退语言包，也是新 key 的基线。每个非 `zh-CN` 语言包的 key 集必须与基线完全相同，不能缺 key、添加未定义 key，或改变任一 key 的占位符名称。

### 运行时回退与 CI / 发布校验

运行时的 `zh-CN` 回退用于保护已发布应用中的语言解析和单条文案查找，避免受支持语言不可用时直接向用户展示空白内容。它不是允许不完整语言包进入产品的机制，也不应作为翻译缺失的常规展示方式。

合并和发布前的校验更严格。`scripts/build-locale-catalog.mjs` 会以规范化后的 locale 标记检查重复项和必需的 `zh-CN`，再逐个比较每个非基线语言包的完整 key 集与占位符名称。PR 验证会执行 `node scripts/build-locale-catalog.mjs --check`；桌面端和服务端的构建、类型检查与测试也会执行同一校验。任一缺 key、多 key、占位符名称漂移、非规范 locale 或过期生成目录都会阻断 CI / 发布。

## 新增界面语言

1. 在 `apps/web/src/locales/` 新增一个 JSON 文件，文件名清晰反映其 locale，例如 `ja-JP.json`。
2. 复制 `zh-CN` 的完整 key 集，填写 `meta` 和译文，保留变量、HTML 语义和不可翻译的产品标识。
3. 为长文本、复数、日期、相对时间和窄窗口布局补充相应测试或人工检查；不要只检查静态截图。
4. 执行 `node scripts/build-locale-catalog.mjs --check`、项目的 Web 测试、类型检查和构建。新语言只有在 JSON 有效、key 集与 `zh-CN` 完全一致、占位符名称一致且构建成功后才可合并。

语言包是随应用构建发布的资源。新增 JSON 文件并重新构建后，语言才会出现在应用中；它不是无需发布即可由终端用户动态安装的插件机制。

## 原生与服务端文案

同一份 JSON 语言包也为 Electron 原生界面和有限的服务端页面提供文案。`scripts/build-locale-catalog.mjs` 会按稳定顺序校验语言包，并生成以下受版本控制的构建产物：

- `apps/desktop/src/native-locale-catalog.generated.mts`：仅包含 `native.*` 键，供托盘菜单、关闭确认、系统通知和启动失败提示使用；
- `apps/server/src/locale-catalog.generated.ts`：仅包含服务端安全使用的 `oauth.callback.*` 键，供 OAuth 回调完成页使用。

不要手动修改生成文件。新增语言包或新增这些原生/服务端键后，先运行 `node scripts/build-locale-catalog.mjs`，再执行 `node scripts/build-locale-catalog.mjs --check` 和对应应用的类型检查、测试。生成器先校验完整网页语言包，再导出少量原生/服务端文案；因此即使只修改网页 key，缺失、冗余或占位符错误也会在非渲染进程的 CI 门槛中被拒绝。`--check` 还会确认受版本控制的生成目录没有过期。

生成器故意不会导出完整网页词库，也不会读取用户磁盘、网络或邮件数据。只有经过审查的 `native.*` 和 `oauth.callback.*` 文案可以进入非渲染进程；邮件内容及其他用户数据始终不属于翻译资源。

## 文档语言

中文的现有无后缀路径是稳定入口，例如 `README.md` 和 `docs/INSTALLING.md`。英文翻译使用相邻的 `.en.md` 文件，例如 `README.en.md` 和 `docs/INSTALLING.en.md`，避免移动已被引用的中文链接。

新增文档语言时：

1. 使用源文档同目录的语言后缀，例如 `INSTALLING.ja-JP.md`；
2. 在源文档和译文标题下添加简短的互相切换链接；
3. 翻译面向用户的安全、隐私、安装、服务商和 Release 文档时，保持版本号、命令、资源名、路径、链接目标和安全边界准确；
4. 更新任一语言的行为声明、步骤或链接时，同一改动中检查其已发布的对应译文；
5. `CHANGELOG.md` 保持中文权威版本历史。若发布英文或其他语言译文，应在同一改动中同步更新，并明确中文原文为版本事实依据。面向用户的每份 Release Note 应按已发布语言成对维护。

不要在同一 Markdown 文件中交错大段双语正文。相邻译文能保留清晰的标题锚点、链接和 GitHub 阅读体验，同时只共享图标、截图等二进制资源。
