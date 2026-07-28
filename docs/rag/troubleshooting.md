# RAG 故障排查

[简体中文](troubleshooting.md) | [English](troubleshooting.en.md)

## 查询没有结果

先检查用户所选账户、文件夹/日期过滤器和账号是否仍 active。新邮件可能尚在 pending 摄取，已删除邮件或旧 generation 的内容则应当不可见。不要通过扩大到所有账户或直接查询 SQLite 来“验证”问题。

## 索引未就绪或持续失败

查看无敏感摘要中的事件状态、错误码和最久 pending 时间。网络/Provider 错误只影响可选云能力，不应阻止词法/本地流程或邮件同步。当前 RAG 不解析附件正文，因此不要把附件解析错误当成已实现的运行时状态；无法解密或 generation 被撤销应单独报告。使用有范围的 `rag verify`，再决定回填或重建。

## 删除后仍看到内容

立即停止将该内容继续给 Provider。确认邮件删除事务是否包含 delete 来源事件、查询是否过滤 deleted/generation、内存结构是否在当前宿主重建。如果账号已删除，不能为“找回”结果恢复 DEK；应清除显示缓存并确认范围/代际检查。

## 版本升级后结果异常

检查 schema、cleaner、chunker 和页面修订版本。迁移不支持、schema 高于运行时或表形状不完整应失败关闭。保留数据库副本和错误摘要，按迁移计划执行；不要手动 drop `agent_*` 表或修改 schema version 行。

## 内存或性能过高

限制查询/回填范围、候选数和并发，检查是否存在未完成的全量回填或重复事件。内存结构可以安全释放并从可解密页面重建。不要为了释放内存持久化明文向量缓存或删除仍属于 active 账号的页面。

## 报告问题时

提供应用版本、操作系统、错误码、`requestId`、是否为本地/云 Provider、账号数量和复现步骤。不要附上邮件正文、截图中的验证码、附件、OAuth token、API key、密码或数据库文件。

参见 [Agent 安全](../agent/security.md) 和 [迁移计划](../development/migration-plan.md)。
