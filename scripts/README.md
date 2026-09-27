# scripts/ 目录说明

按「是否被 `package.json` / CI 工作流 / 其他脚本显式引用」区分两类：

## 已接线的工具
根目录下的脚本都是活跃工具：构建、打包、SQLite ABI 验证、smoke、locale catalog、
文档站构建（`build-docs-site.mjs`）、wiki 同步、发布策略等。

## tests/ — 脚本级测试（CI 自动发现）
`tests/` 下的 `*.test.mjs` 由 `node --test "scripts/tests/*.test.mjs"` 一次性运行
（`validate.yml` 与 `release-windows.yml` 都跑同一条 glob）。**新增脚本测试直接放进
`tests/` 即可**，不需要再登记进任何工作流；`test-placement.test.mjs` 会把散落在
`tests/` 之外的脚本测试判为失败。测试里引用被测脚本用 `../<脚本名>.mjs`，
仓库根目录用「三层 dirname」（`scripts/tests/` → `scripts/` → 仓库根）。

## attic/ — 归档的一次性脚本
`attic/` 收纳历次开发过程中遗留、当前**零引用**的探针与诊断脚本
（`probe*`、`check-*`、`wait-*`、`cleanup*`、`comprehensive-*` 等）。
它们不参与构建、测试或发布；保留在这里仅为可查阅与偶尔手工运行。
若要复活某个脚本，先把它移出 `attic/`，再确认是否有测试或工作流引用。
