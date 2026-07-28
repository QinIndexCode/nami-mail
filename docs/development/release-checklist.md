# Agent/RAG 发布检查清单

[简体中文](release-checklist.md) | [English](release-checklist.en.md)

该清单是发布门禁，不是未来工作愿望清单。任一阻断项未满足时，不得发布带 Agent/RAG/CLI/MCP 宣称的安装包、GitHub Release 或更新清单。

## 代码与文档

- [ ] 中英文文档配对、相对链接和命令已校验；规划中的能力未被写成已交付。
- [ ] Agent/RAG/CLI/MCP 的 schema、错误码、权限和用户文案已评审。
- [ ] 所有新增代码注释为英文；无调试密钥、测试凭据、真实邮件或本地数据库进入版本库。
- [ ] 本地 NLLB-200 翻译仍显式标为实验性、可选且不作为 Agent Provider。

## 安全阻断项

- [ ] Windows 生产 Broker 使用真实当前用户 SID-DACL 独占命名管道，已在安装版验证。
- [ ] 适配器缺失、配对失败、签名失败、重放和更新排空时均失败关闭，未发现 TCP/HTTP/SQLite 降级路径。
- [ ] CLI/MCP v1 仅为只读，无法用 `--yes`、参数或模型输出写入/发送。
- [ ] GUI 高风险确认不可变、一次性、可见且持久审计；账号 generation 变化会使确认失效。
- [ ] 云端邮件内容外发默认关闭；同意、Provider 配置和凭据存储已人工验证。

## 数据与 RAG 阻断项

- [ ] `applyAgentStoreSchema` 在实际 AgentHost 生命周期中早于任意 Agent 访问运行。
- [ ] V1 到当前 schema、失败注入和备份/恢复经过测试；未知版本失败关闭。
- [ ] 邮件 upsert/delete、移动、归档和账户删除产生正确来源事件，且与本地邮件状态同事务。
- [ ] 已删除/旧 generation 页面不会出现在检索、会话或 Provider 上下文中。
- [ ] 崩溃恢复、重试、重建、内存索引清空和 `rag verify` 有实际证据。

## 产品与运行时阻断项

- [ ] GUI 在真实桌面窗口中验证范围、来源、选择/复制、错误、取消、确认和空状态。
- [ ] 无 Provider、无同意、网络/TLS、认证、限流和未知发件状态均显示准确用户可执行信息。
- [ ] Agent 不改变既有同步、SMTP 幂等性、Sent-folder 核对、归档或草稿语义。
- [ ] 单实例、服务模式、更新排空和安装器失败恢复在安装版验证。

## 构建与交付

- [ ] `npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build` 成功。
- [ ] Node/Electron SQLite ABI 验证、runtime、desktop、package、installer smoke 分别成功。
- [ ] 新装、已有版本覆盖、卸载保留/删除数据选项和更新 ZIP 下载/校验/删除已验证。
- [ ] 更新元数据、GitHub Release 资产、版本号和签名/信任材料指向同一构建；未把未签名构建称为已签名。

## 发布记录

在发布说明记录构建 commit、版本、测试命令、安装版环境、已验证的安全适配器、已知限制和回滚材料位置。任何没有验证的项目必须明确列为阻断或残余风险，而不是省略。

参见 [测试计划](testing-plan.md)、[迁移计划](migration-plan.md) 和 [Agent 安全](../agent/security.md)。
