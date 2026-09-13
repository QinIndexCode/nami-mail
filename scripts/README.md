# scripts/ 目录说明

按「是否被 `package.json` / CI 工作流 / 其他脚本显式引用」区分两类：

## 已接线的工具
根目录下的脚本都是活跃工具：构建、打包、SQLite ABI 验证、smoke、locale catalog、
wiki/docs 同步、发布策略等。`*.test.mjs` 由 `.github/workflows/validate.yml`
与 `release-windows.yml` 逐一显式运行（没有 glob，新增测试必须手动登记）。

## attic/ — 归档的一次性脚本
`attic/` 收纳历次开发过程中遗留、当前**零引用**的探针与诊断脚本
（`probe*`、`check-*`、`wait-*`、`cleanup*`、`comprehensive-*` 等）。
它们不参与构建、测试或发布；保留在这里仅为可查阅与偶尔手工运行。
若要复活某个脚本，先把它移出 `attic/`，再确认是否有测试或工作流引用。
