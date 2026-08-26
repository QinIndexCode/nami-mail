# MCP 安装状态与前提

[English](installation.en.md) | [配置](configuration.zh-CN.md)

> **当前构建状态：已安装且可启动。** 0.3.0 安装包随附原生 SID-DACL 命名管道 Broker、`namimail` 可执行文件、PATH shim、无界面 AgentHost 服务模式和客户端配对 UI。本文的进程声明可粘贴到 IDE 或其他 MCP 客户端。

## 当前用户操作

MCP 不是 npm 包、网络服务或数据库文件。安装 Nami Mail 后，保持 Agent 宿主运行（打开桌面应用或运行 `namimail service start`），用 `namimail pair` 配对客户端 profile 并在可见窗口中批准，再按[配置](configuration.zh-CN.md)中的 stdio 命令配置 MCP 客户端。不要运行服务器源码、提供数据库路径、配置 `http://127.0.0.1`，或以 Node 默认命名管道替代安全 IPC。

## 发布前提

安装版已满足下列全部要求：

1. 安装器提供受管理的 `namimail` 命令和 PATH shim。
2. 用户可启动正常 NamiMail 或仅通过 `service start` 命令显式请求 AgentHost；查询与 MCP 本身不得隐式启动 Runtime。
3. 每个 MCP 客户端必须在可见 NamiMail UI 中取得独立 Ed25519 配对和只读账户范围。
4. MCP 子进程只使用 stdio，且只能连接到已配对、当前用户 SID 限制的命名管道 Broker。
5. 不提供 HTTP、TCP、数据库文件、文件 URI、环境变量 token 或其他回退通道。

客户端私钥必须留在客户端安全存储中。Broker 持久化的配对材料包含客户端公钥、宿主公钥与 ID、scope 和防重放计数器；撤销必须通过可见 NamiMail UI 完成。
