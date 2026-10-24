# 0002 · 附件预览的四层流水线与单一预算

[English](0002-2026-10-attachment-preview.en.md) | [决策记录索引](README.zh-CN.md)

- **状态**：已采纳（2026-10）
- **范围**：渲染进程的附件取数与预览、预览预算、预览失败码与文案、渲染进程的 CSP 与顶层导航策略
- **替代**：`<iframe>` / 直接 `<img>` 的预览方式，以及散落在组件里的字节上限与像素上限

## 背景

到 2026-10 为止，"点开一个附件"在渲染进程里是三种不同做法：PDF 塞进 `<iframe>` 交给浏览器插件、图片直接 `<img src=blob:>`、其余一律"下载后查看"。症状彼此看起来无关：

- 高 DPI 扫描件（300 DPI 的 A4 发票）在旧实现里**静默渲染成空白页**：canvas 分配失败或图像被 pdf.js 内部尺寸闸拒绝时，用户看到的是一个没有内容的白色画布，没有任何错误。这不是渲染 bug，而是"没有任何一层负责判断这份字节能不能画"。
- 上限是散落的字面量：某处 20 MB、某处 5,000 页、某处一个 8192 像素常量。改一处不会让另一处跟着变，于是"允许打开"与"画得出来"两件事长期不一致。
- `<iframe>` 是一层天然的隔离，但它同时把"失败"也隔离掉了：跨文档的加载错误不会变成界面上的文字，用户只能看到空白。
- CSP 为了让这条路径可用而保留了 `frame-src blob:` 与 `img-src https: http:`，等于让邮件正文里漏网的 `<img>` 也能直连任意主机。

三者是同一个结构选择的三种症状：**预览没有显式流水线，于是每个格式各自决定"够不够小、画不画得出、失败了怎么说"**。

## 决策

**把预览重建成一条显式流水线（取数 → 解码 → 文档 → 渲染），每一层的预算、失败码与资源所有权都只有一个定义处。**

| # | 决策 | 为什么 | 放弃了什么 |
|---|---|---|---|
| D1 | 拆成四层：`ingress`（取数与截止时间）、`decode`（按 previewKind 解码）、`document`（唯一 objectURL 所有者 `ResourceScope`）、`render`（surface registry，10 个 surface 穷尽映射） | 每一层只回答一个问题：字节是否到齐、能否解成中间表示、谁负责释放、画成什么。空白页之所以可能，是因为没有任何一层被要求回答"这份字节能否画出来" | `<iframe>` 的天然隔离。PDF/SVG/图片现在都在同源渲染，隔离改由 CSP、`DOMPurify`（SVG）、严格的内容类型与像素闸共同承担；少了一层浏览器级的兜底，多了一份可测的责任 |
| D2 | 分类只有一份真源：`packages/agent-contracts` 的附件目录（13 个 previewKind、138 个扩展名、tier A/B/C） | 之前 web 与 server 各有一份扩展名表，parity 靠人工保持一致；两份表一旦漂移，"服务端说有附件、前端说不可预览"这种矛盾就不可避免 | 各端按需微调的灵活性。tier B（需解压才能判断）与 tier C（一律只下载）的分派也随之成为契约的一部分 |
| D3 | 预算只有一份真源：`apps/web/src/attachments/budget.ts`。七个分支的 `worstCaseBytes()` 必须满足 `worst + RESERVE_BYTES ≤ MAX_MEMORY_BYTES`（192 MiB），并有 `MemoryLease` 在分配**之前**扣账 | 旧实现的每个常量都是单独估算出来的，任何一处调整都可能让某个分支的峰值超过它本应满足的上限；把"最坏情况"写成可执行的断言，才能让改动在测试里失败而不是在用户机器上 | 逐格式精调数字的自由；也放弃了"账本等于进程内存上限"的说法——pdf.js 内部结构、浏览器解码器都不在这本账上（见已知限制） |
| D4 | PDF 走严格模式：`stopAtErrors: true`，加上每张图像 `maxImageSize` 像素闸、单页图像像素和、页 canvas 字节上限与墙钟截止 | 旧实现把"画不出来"静默降级为空白页；严格模式下同一份字节会**以可见的失败结束**，用户至少知道发生了什么 | 含可恢复错误的 PDF 会整页失败（部分原本能显示少半页的文件现在显示错误）。逃生通道是下载原文件——这是有意的取舍 |
| D5 | 失败码收敛为 14 个、界面状态 13 个、新增文案键 16 个，全部由一张表与逐码的真实构造测试钉住 | 失败理由如果由各解码器自行措辞，同一种失败会以五种说法出现，而缺少的那一种永远没人补 | 把底层库的异常细分到界面。细节留在日志与 `cause` 里，界面只回答"为什么打不开、能不能重试、能不能下载" |
| D6 | CSP 只收紧**必须**收紧的三条：`frame-src 'none'`、`worker-src 'self'`、`media-src 'self' blob:`；`style-src 'unsafe-inline'` 保留 | 删掉 `<iframe>` 之后 `frame-src blob:` 是多余放行；pdf.js 的 worker 必须来自同源资产；音视频走 blob URL 播放 | 去掉 `unsafe-inline`。启动画面依赖 `index.html` 里的内联 `<style>`，去掉它会先闪一屏无样式内容；这项改动留给引入 nonce/hash 的独立批次 |
| D7 | Gravatar 改为服务端同源代理 `GET /api/avatars/gravatar/:hash`，随后同一提交把 `img-src` 收紧为 `'self' data: blob:` | 渲染进程直连 Gravatar 会把地址哈希与用户 IP 一起交给第三方，并且是 `img-src` 保留 `https:`/`http:` 的唯一理由 | 直连的简单性。代理引入了一个新的服务端出站面，因此补了四道闸：`redirect: "manual"`、5 s 超时、1 MiB 双闸、内容类型必须是 `image/*` 且不是 SVG；调用方只能传摘要，不能改上游 URL |
| D8 | 桌面端顶层导航加 scheme 白名单：`blob:` / `data:` / `file:` / `javascript:` 一律拒绝 | 预览不再依赖 `blob:` 的顶层导航后，这些 scheme 只剩"页面被邮件内容带着跳走"这一种用途 | 将来若要让界面打开本地文件，必须另开一条显式通道，而不是复用导航 |

## 后果

**得到：**

- "打不开"成为一等结果：14 个失败码各自有触发它的最小构造，界面给出原因、重试与下载三条出路；300 DPI 扫描件要么画出来，要么明确报错，不再静默空白。
- 预算可以机械校验：`worstCaseBytes()` 的七条公式与账本上限在同一文件里，测试逐项比对；任何分支调参都会与最紧的那条约束一起失败。
- 资源释放有单一所有者：`ResourceScope` 是 objectURL 的唯一释放点，解码器的 `cancel → cleanup（重试上限 3）→ destroy` 是一条固定协议。
- CSP 收窄后，附件预览不再需要浏览器级隔离来兜底，`img-src` 也从"任意主机"回到同源的两个代理。

**付出：**

- 每个新格式都要落四个位置（目录条目、decode 分支、surface 注册、失败码/文案），不再有"临时塞个 iframe"的捷径。
- 严格模式把一部分"能显示一部分"的 PDF 变成"整页失败"，用户需要下载原文件才能看到内容。
- 代理与账本都是新的维护面：服务端多一个出站路由，渲染进程多一本需要逐分支维护的账。
- 预览的正确性有一部分**无法在 jsdom 里验证**（PDF canvas、媒体解码），必须靠真机目视验收；本轮把"向量文本 PDF、300 DPI 扫描件、多页翻页与宽度拖动"列为验收项。

**验证方式：** 分类的 parity 由 `apps/web/src/attachments/catalog*.test.ts` 与 `apps/server/tests/attachment-catalog*.test.ts` 双向断言；预算由 `budget.test.ts` 的七分支最坏值比对与 `state-table.test.ts` 的逐码构造覆盖；CSP 与缓存策略分别由 `apps/server/tests/csp.test.ts`、`app.test.ts`、`gravatar.test.ts` 断言；端到端由 `e2e/attachment-preview.spec.ts` 在 demo 工程里跑真链路。

## 不属于本决策

- **任务层与派生计数**：见 [0001 · 统一任务层与派生计数](0001-2026-10-task-layer.zh-CN.md)，与附件预览正交。
- **邮件正文远程图片代理**（`GET /api/images/proxy`）本身：它在本次决策之前就存在，本决策只是在此之前提下收窄了 `img-src`。
- **附件上传、发送与草稿路径**：预览只读取字节，不改变写路径。
- **加密与存储格式**：预览拿到的字节与落库方式无关。
- **网格系统与视觉细节**：抽屉宽度、过渡与排版沿用既有设计，不在本记录的论证范围内。

## 依据

本页记录的是**当时的选择与理由**，不随实现细节更新。实现现状以 `apps/web/src/attachments/`（`budget.ts`、`failure.ts`、`ingress.ts`、`session.ts`、`decode/`、`render/`）、`apps/server/src/security/csp.ts` 与 `apps/server/src/avatars/gravatar.ts` 为准；能力边界与刻意不做的取舍见[已知限制](../known-limitations.zh-CN.md)；相关提交在 `git log` 中按 `attachments/`、`csp.ts`、`avatars/gravatar.ts` 可查。
