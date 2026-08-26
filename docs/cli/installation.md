# CLI 安装状态与未来前提

[English](installation.en.md) | [返回概览](README.md)

> **当前构建状态：无法安装或启动 CLI。** 此 Windows 构建未随附可验证的 SID-DACL 命名管道原生适配器，也未安装 `namimail` 可执行文件、PATH shim、无界面 AgentHost、Broker 或客户端配对界面。不要尝试运行、复制、创建或配置 `namimail`；它不是当前版本的受支持入口。

## 当前用户操作

请使用正常的 Nami Mail 桌面界面处理邮件和设置。开发目录中的 Node.js、`npm run dev`、SQLite 文件、Fastify 服务或猜测的命名管道都不能代替外部 Agent IPC，也不能作为 CLI/MCP 回退路径。

安装器的数据保留或删除选择仍只影响桌面应用数据；当前安装器没有 CLI shim 可修复、复制或移除。

## 未来发布前提（不可执行契约）

在安装版随附并验证 Windows SID-DACL 原生适配器之前，以下项目均不得宣称可用：

1. 安装器提供受管理的 `namimail` 可执行文件和 PATH shim。
2. `namimail version` 可在本地报告版本，且不读取邮件数据。
3. 仅 `namimail service start` 可显式请求无界面 AgentHost；普通查询绝不能隐式启动 Runtime。
4. CLI/MCP 客户端可在可见 NamiMail 界面中独立配对，并被授予只读账户范围。
5. 客户端仅经当前用户 SID 限制的命名管道 Broker 访问宿主；没有 HTTP、TCP、SQLite、文件系统或浏览器 token 降级路径。

未来配对记录必须绑定客户端公钥、宿主身份和公钥、scope、账户范围以及持久化防重放计数器。私钥、公钥 PEM、配对记录、管道路径和计数器不得写入 issue、终端截图、共享仓库或环境变量。撤销也必须由可见 NamiMail UI 完成。
