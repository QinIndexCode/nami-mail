# CLI 安装状态与前提

[English](installation.en.md) | [返回概览](README.zh-CN.md)

> **当前构建状态：已安装。** 0.3.0 安装包随附受管理的 `namimail` 可执行文件并注册当前用户 PATH shim。桌面主进程会启动 Broker 并通过它路由 `--cli` 调用；安装器 smoke 测试会验证 shim 和安装后的 MCP stdio 会话。

## 当前用户操作

安装 Nami Mail 后，在终端运行 `namimail --help`。本地命令（`version`、`help`）无需宿主即可工作。只读数据命令需要正在运行的 Agent 宿主，以及已配对、获批账户范围的客户端 profile；请先运行 `namimail pair` 并在可见 NamiMail 窗口中批准请求。

开发目录中的 Node.js、`npm run dev`、SQLite 文件、Fastify 服务或猜测的命名管道都不能代替外部 Agent IPC，也不能作为 CLI/MCP 回退路径。

安装器的数据保留或删除选择只影响桌面应用数据；安装器注册的当前用户 PATH shim 会由卸载器移除。

## 发布前提

安装版已满足下列全部要求：

1. 安装器提供受管理的 `namimail` 可执行文件和 PATH shim。
2. `namimail version` 可在本地报告版本，且不读取邮件数据。
3. 仅 `namimail service start` 可显式请求无界面 AgentHost；普通查询绝不隐式启动 Runtime。
4. CLI/MCP 客户端可在可见 NamiMail 界面中独立配对，并被授予只读账户范围。
5. 客户端仅经当前用户 SID 限制的命名管道 Broker 访问宿主；没有 HTTP、TCP、SQLite、文件系统或浏览器 token 降级路径。

配对记录绑定客户端公钥、宿主身份和公钥、scope、账户范围以及持久化防重放计数器。私钥、公钥 PEM、配对记录、管道路径和计数器不得写入 issue、终端截图、共享仓库或环境变量。撤销也必须由可见 NamiMail UI 完成。
