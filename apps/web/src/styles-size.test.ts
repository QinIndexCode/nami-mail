import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("styles.css size ratchet", () => {
  // ESLint 无法解析 CSS，巨型文件的 max-lines 棘轮在这里续上：
  // 只允许瘦身，不允许继续增长。瘦身时请同步下调此阈值。
  // 2026-10-01 有记录的一次上调（18_440 → 18_483）：服务商磁贴条为
  // "选中非核心服务商后保持可见" 增加 display 分支、surfaced 入场动画
  // 与 has-surfaced 高度档（含窄窗覆盖）；下轮 CSS 瘦身时应优先收回。
  // 2026-10-01 第二次有记录的上调（18_483 → 18_549）：设置界面改为分类分页
  // （左侧分组导航 + 右侧单分类面板）——新增导航分组标签、面板入场动画
  // （含 reduced-motion 降级），并把窄窗下 .settings-nav 的 display:none
  // 换成横排列布局（修复窄窗无导航缺陷）；下轮 CSS 瘦身时应优先收回。
  // 2026-10-01 第三次有记录的上调（18_549 → 18_558）：模型设置迁入设置弹窗，
  // 新增 .agent-provider-settings.embedded 单条内嵌覆盖规则（去浮层尺寸与
  // 入场动画，保留卡片外观）；下轮 CSS 瘦身时应优先收回。
  // 该轮随后整体收回：旧的 AgentProviderSettings / AgentMcpServerPane 组件被
  // 删除，其浮层、目录、表单、开关与内嵌覆盖规则（约 830 行）一并移除，改由
  // 新增的「模型」设置卡片规则（约 60 行）承担，阈值随之下调到 17_781。
  // 上面的 400 行"贴近阈值"下限同步放宽到 900：一次近 800 行的删除会让固定
  // 400 的窗口永远无法同时满足上下界。
  // 2026-10-01 有记录的一次下调（17_782 → 17_730）：「设置-模型」表单弹窗化
  // 收口，删掉内联卡片时代遗留、全仓已零引用的行内字段规则
  // （.setting-row>.settings-field-text / >.settings-model-field 下的 input、
  // textarea、env-editor，共 52 行）。同轮把 API Key 输入框纳入
  // .calendar-field 既有控件选择器（补 input[type=password]），零新增规则。
  // 2026-10-01 有记录的一次下调（17_730 → 17_680）：修复「全局浮层层级与定位」
  // 一批缺陷。删除 97 行已随组件下线的孤儿规则——旧 AgentProviderSettings 的
  // 内联服务商选择器（.agent-provider-picker / -picker-label / -select /
  // -select-control 及其 :hover/:focus/图钉/下拉覆盖，含窄窗覆盖，共 65 行），
  // 以及同一组件遗留的 .agent-composer-meta 与其 span:last-child（基础 15 行 +
  // 窄窗 17 行）；`git grep --untracked` 在跟踪+未跟踪源文件（排除 .gitignore
  // 的 .mimosa/）里对四个类名零命中。新增 53 行：.app-frame 的毛玻璃下沉到
  // :not(.desktop-app)::before（19 行，含 11 行说明为什么不能留在 .app-frame 上）、
  // 壁纸模式对应的 ::before 覆盖（9 行）、overscroll-behavior:contain ×5、
  // 2026-10-02 有记录的一次下调（17_680 → 17_630）：「设置-模型与MCP」
  // 样式与布局重构。收敛并紧凑化 .settings-model-* 规则，增加 .settings-field-hint、
  // .settings-model-badge、.settings-model-switches 与 .settings-model-textarea，
  // 2026-10-03 有记录的一次下调（17_630 → 17_570）：「自动回复规则」
  // 弹窗化与卡片样式重构。移除旧的内联规则表单样式，净瘦身 60 行。
  // 2026-10-03 第二次有记录的下调（17_570 → 17_540）：管理弹窗与子编辑器
  // 样式统一与精简（管理弹窗头部、日程/模板/联系人编辑器头部统一与写信附件栏优化），
  // 净瘦身 30 行。
  // 2026-10-03 架构升级：styles.css 全面拆分为模块化按层导入架构
  // （tokens/, base/, components/, overlays/, features/ 共 29 个模块）。
  // 根 styles.css 保持纯粹的导入索引（≤ 40 行）。
  // 聚合总样式继续保持严格的防膨胀棘轮限制（FROZEN_AGGREGATED_MAX_LINES）。
  // 2026-10-24 有记录的一次上调（18_168 → 18_173）：外部连接三步引导的
  // 「已完成」状态_chip——.connections-step-title（标题独占省略）与
  // .connections-step-done（pill 语境紧凑完成态，配对列表的 status_chip
  // 色彩挂在行选择器上、在此语境不生效），净 +4 行；下轮 CSS 瘦身时应优先收回。
  // 2026-10-05 有记录的一次上调（17_600 → 17_610）：账户连接状态进行时态——
  // 侧边栏账户行同步中状态点 .status-dot.syncing（脉冲动画 + reduced-motion
  // 降级，共 10 行）；下轮 CSS 瘦身时应优先收回。
  // 2026-10-05 第二次有记录的上调（17_610 → 17_612）：同规则修正——
  // --accent 不存在于 token 集（var 未定义 → 背景透明 → 点隐形），改用
  // --info 并留 2 行说明注释；下轮 CSS 瘦身时应优先收回。
  // 2026-10-05 第三次有记录的上调（17_612 → 17_616）：token 普查发现
  // --accent 被四处引用（toast 操作按钮/账户连接选中态/沙盒统计数字）
  // 却从未定义，全部静默失效；现于两主题正式定义（值同 --info）。
  // 2026-10-06 有记录的一次上调（17_616 → 17_628）：批次 A1「CSS token
  // 家族修复 + 对比度修复 + 移动端列头修复」。variables.css 两主题正式
  // 定义 --primary/--primary-strong/--accent-subtle/--focus-ring-text（+2 行）
  // 与 --font-mono（+1 行，随 font-family 惯例仅 :root 一份）；responsive.css
  // ≤620px 列头加 .message-count 隐藏与 h1/eyebrow 单行省略（+9 行）。
  // 2026-10-06 第二次有记录的上调（17_628 → 17_659）：批次 A2「复检修复」。
  // 实测聚合 17_647 行（+19），阈值取实测 +12 行缓冲。
  //
  // **余量政策**：本阈值必须**严格大于**实测值。上一版设成 17_628 恰好等于
  // 实测值，余量为 0，任何一行 CSS 改动都会立刻变红——那样的棘轮不是护栏，
  // 是绊线（本轮开头实测正是如此：17_628 = 实测）。因此规则是：
  //   设阈值 = 实测值 + 12 行；余量用尽时，要么下轮瘦身回收，要么**显式**
  //   记录一次上调及其原因，不允许静默地把阈值贴到实测值上。
  // 12 行 ≈ 一条中等规则或两条带注释的 token 声明，够吸收一次正常的
  // 「改 token 顺便加两行说明」而不误报，又不至于大到失去约束力。
  //
  // 本轮 +19 行的来源（全部为有记录的必要改动，无 gold-plating）：
  //   responsive.css 把 .message-count 的 display:none 换成 visually-hidden
  //     配方（+15 行，含 6 行说明为何不能直接 display:none / 不能直接复用
  //     features/composer.css 里的工具类）；
  //   variables.css 增补 --radius-xs（+1 行）；
  //   agent.css 记录 --text-faint 那一处 tint 由 14% 降到 10% 的原因
  //     （+4 行注释）。
  // 下一轮 CSS 瘦身时应优先收回：先合并 responsive.css 里重复的
  // visually-hidden 配方，再考虑把 tint 说明挪进设计系统文档。
  // 2026-10-07 有记录的一次上调（17_659 → 17_682）：修复「日期选择器键盘/
  // 屏幕阅读器不可用」。实测聚合 17_670 行（+11），阈值取实测 +12 行缓冲。
  // 本轮 +11 行的来源（均为修复缺陷所必需，无 gold-plating）：
  //   calendar.css 新增 .date-picker-panel.hosted（模态框内面板改用 absolute，
  //     含 4 行说明为何不能用 fixed——模态框的入场动画会留下 transform）；
  //   新增 .date-picker-grid-row（ARIA 要求 grid > row > gridcell，含 1 行
  //     说明）与月/年视图的 4 列行覆盖；
  //   月/年单元格并入既有 :focus-visible 选择器组，补上 roving-tabindex 的
  //     .focused 焦点环（+1 行，无独立规则）。
  // 下一轮 CSS 瘦身时应优先收回：与上述三条说明注释合并表述。
  // 2026-10-07 第二次有记录的下调（17_682 → 17_674）：修复「日期选择器面板被
  // 对话框裁剪」与「跨月方向键焦点被重置」。calendar.css 删除 8 行
  // .date-picker-panel.hosted —— 面板不再挂载到对话框内部（三个宿主分别是
  // overflow:hidden 与两个滚动容器，absolute 无法逃出），一律 portal 到
  // body 并由 useDialogFocus 的 portal 注册表承认，规则连同其 4 行说明一并移除。
  // 实测聚合 17_662 行（-8），阈值取实测 +12 行缓冲。
  // 2026-10-18 有记录的一次上调（17_674 → 17_822）：右侧图标栏新增「云端同步」
  // 面板——紧贴按钮左侧的小型状态浮层，列出仍在投递到邮件服务器的任务与近期
  // 失败（提交/投递分离后，投递阶段在工具栏上不可见，这是它唯一的出口）。
  // 实测聚合 17_810 行（+143），阈值取实测 +12 行缓冲。本轮 +143 行的来源
  // （均为一个新的用户界面所必需，无 gold-plating）：
  //   features/mail.css +138：.rail-item 定位上下文（7，含 3 行说明为何只加
  //     position:relative——列的 align-items:center 已把盒子收成 40px 按钮）；
  //     .cloud-sync-panel（26，含 6 行说明为何用 absolute 而非 fixed、为何不设
  //     遮罩、为何 z-index 取 20）；面板头/标题/关闭键及悬停（29，面板内的关闭
  //     键不能复用 .icon-button——.icon-rail 的后代选择器会把它撑到 40px）；
  //     失败提示与重试键（25）、两个分区的容器与列表（15，分区标题复用既有
  //     .eyebrow，未新增规则）、任务行及其三段文字（36，其中 account/detail/note
  //     已合并为一条共用规则，行内邮箱用省略号收口）；
  //   overlays/popups.css +5：.cloud-sync-panel.closing 的退场动画与
  //     pointer-events:none（退场规则按惯例集中在该文件）。
  // 下一轮 CSS 瘦身时应优先收回：先看这个旁路面板能否与发件箱状态浮层共用一套
  // 外壳规则（两者都是「按钮左侧的列表浮层」），再合并 .cloud-sync-close 与
  // 其他自绘的小图标键。
  // 2026-10-20 有记录的一次下调（17_822 → 17_812）：统一全站复制按钮的反馈动画。
  // 复制图标（账号地址、连接设置 6 处、添加账号服务配置、验证码、Agent 消息与
  // 右键菜单）此前各自复制了一份「换成勾再换回来」的状态与动画；现收敛到
  // components/CopyButton.tsx 与 buttons.css 的一条 .copy-button.copied 规则。
  // 实测聚合 17_800 行，阈值取实测 +12 行缓冲。按文件计：
  //   buttons.css +29：共享 .copy-button.copied>svg 的绿色勾与 scale-in 动画、
  //     keyframes 与 reduced-motion 关闭（只有勾出现时动画，普通复制图标挂载
  //     时不闪）；另含一条通用的 .secondary-button.copy-button.copied 颜色/边框
  //     规则——选择器不限于某个页面，故与共享规则同处，而不是留在 connections.css；
  //   accounts.css -12：删除 .accounts-copy-address svg 与 account-copy-icon-in；
  //   agent.css -25：删除 .agent-corner-button.copy svg 的 transition、.copied 规则
  //     与重复的 agent-copy-check keyframes（保留 overflow:hidden）；
  //   connections.css -2：删除 :is(...) 的动画行与 .copied 颜色/边框规则（前者由
  //     共享规则提供，后者迁入 buttons.css）。
  // 下一轮 CSS 瘦身时应优先收回：.setup-guide-copy.copied 与共享 .copied 的绿色
  // 处理可以合并，两者只是颜色来源不同。
  // 同日补充：复制反馈改成双向交叉过渡——复制图标与勾同时挂载，由 .copied 切换
  // opacity/scale，勾淡出、复制图标淡入也有过渡（原实现只给勾做了入场动画，
  // 返回时图标瞬间替换）。buttons.css 由 29 行增至 34 行（+5），实测聚合
  // 17_805 行，余量 7，未上调阈值。
  // 2026-10-20 有记录的一次上调（17_812 → 17_955）：附件预览从 <iframe> 换成
  // 组合式抽屉。净变化 = 搬移 187（mail.css）+ 23（auto-reply.css）出、
  // 新文件 features/attachment-preview.css 的 193 行搬移基底入（+2 是它自己那层
  // @media 包裹），再加上 N₂ = 153 行新增规则（图片/媒体/PDF/下载卡/文本页脚/
  // 共享滚动区/焦点环——旧实现里这些由 iframe 内的浏览器渲染，没有任何 CSS）。
  // 基底是 193 而不是计划里的 212：搬移时丢掉了两条随 iframe 一起作废的规则
  // （.attachment-preview-frame 9 行、.attachment-preview-unsupported 及其 p
  // 共 10 行），下载卡已由新增的 .attachment-preview-download-only /
  // -download-reason 取代。实测聚合 17_943 行，阈值取实测 +12 行缓冲。
  // 下一轮 CSS 瘦身时应优先收回：S3/S4 的新表面可以与现有 .attachment-card
  // 共用外壳。
  // 2026-10-23 S3 的一次上调（17_955 → 18_168）：四类文档表面（Office 段落与
  // 工作表、Markdown、归档清单）此前由 <iframe> 交给浏览器排版，应用侧零 CSS。
  // 实测聚合 18_156 行（+213，全部落在 features/attachment-preview.css），阈值
  // 取实测 +12 行缓冲。+213 明显高于计划 §4.4 的「约 +70」估算：本文件是
  // 「每个属性一行」的既有格式，多行块（office 18 / sheet 52 / archive 61 /
  // markdown 79 / 注释 3）按该格式展开后就是这个量级，没有额外装饰规则。
  // 下一轮 CSS 瘦身时应优先收回：归档清单与工作表滚动区可复用同一套
  // 「带边框的面板 + 列表行」外壳。
  const FROZEN_ROOT_MAX_LINES = 40;
  const FROZEN_AGGREGATED_MAX_LINES = 18_173;
  const STALENESS_WINDOW = 900;

  it("maintains a clean, modular root entry stylesheet", () => {
    const rootPath = fileURLToPath(new URL("./styles.css", import.meta.url));
    const rootCss = readFileSync(rootPath, "utf8");
    const lines = rootCss.split("\n").length;
    expect(lines).toBeLessThanOrEqual(FROZEN_ROOT_MAX_LINES);
    // Root entry must only contain @import statements and empty lines
    const nonImportLines = rootCss
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("@import") && !l.startsWith("/*") && !l.startsWith("*"));
    expect(nonImportLines).toHaveLength(0);
  });

  it("does not grow beyond the frozen baseline in aggregated total styles", async () => {
    const { loadAggregatedCss } = await import("./testUtils/loadStyles.js");
    const aggregatedCss = loadAggregatedCss();
    const lines = aggregatedCss.split("\n").length;
    expect(lines).toBeLessThanOrEqual(FROZEN_AGGREGATED_MAX_LINES);
    expect(lines).toBeGreaterThan(FROZEN_AGGREGATED_MAX_LINES - STALENESS_WINDOW);
  });

  /**
   * The ratchet must keep headroom, not sit on the measurement.
   *
   * A baseline set *equal* to the current line count passes today and fails on
   * the next single line — which is exactly what happened: the previous
   * threshold was 17_628 against a measured 17_628, so the guard measured
   * nothing. This asserts the margin exists, and names it, so the next person
   * to bump the number has to state the headroom they are entitled to.
   */
  it("keeps headroom above the measured line count", async () => {
    const { loadAggregatedCss } = await import("./testUtils/loadStyles.js");
    const lines = loadAggregatedCss().split("\n").length;
    const headroom = FROZEN_AGGREGATED_MAX_LINES - lines;
    expect(headroom, `the aggregated ratchet must exceed the measured ${lines} lines`).toBeGreaterThan(0);
    expect(headroom, `headroom is ${headroom} lines; the documented buffer is 12`).toBeLessThanOrEqual(12);
  });
});
