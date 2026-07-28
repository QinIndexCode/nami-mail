# MCP 安装状态与未来前提

[English](installation.en.md) | [配置](configuration.md)

> **当前构建状态：MCP 不可安装、配置或启动。** 此 Windows 构建没有可验证的 SID-DACL 命名管道原生适配器，也没有 `namimail` 可执行文件、PATH shim、Broker、无界面 AgentHost 或客户端配对 UI。不要把本文的进程声明粘贴到 IDE 或其他 MCP 客户端中。

## 当前用户操作

MCP 不是当前发行版中的 npm 包、网络服务、数据库文件或可从工作区启动的服务。请使用正常的 Nami Mail 桌面界面；不要运行服务器源码、提供数据库路径、配置 `http://127.0.0.1`，或以 Node 默认命名管道替代安全 IPC。

## 未来发布前提（不可执行契约）

只有在安装版随附并验证原生 Windows SID-DACL 适配器后，MCP 才可按下列安全要求发布：

1. 安装器提供受管理的 `namimail` 命令和 PATH shim。
2. 用户可启动正常 NamiMail 或仅通过预留的 `service start` 显式请求 AgentHost；查询与 MCP 本身不得隐式启动 Runtime。
3. 每个 MCP 客户端必须在可见 NamiMail UI 中取得独立 Ed25519 配对和只读账户范围。
4. MCP 子进程只使用 stdio，且只能连接到已配对、当前用户 SID 限制的命名管道 Broker。
5. 不提供 HTTP、TCP、数据库文件、文件 URI、环境变量 token 或其他回退通道。

未来客户端私钥必须留在客户端安全存储中。Broker 持久化的配对材料将包含客户端公钥、宿主公钥与 ID、scope 和防重放计数器；撤销必须通过可见 NamiMail UI 完成。
