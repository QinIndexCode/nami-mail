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
  // 2026-10-05 有记录的一次上调（17_600 → 17_610）：账户连接状态进行时态——
  // 侧边栏账户行同步中状态点 .status-dot.syncing（脉冲动画 + reduced-motion
  // 降级，共 10 行）；下轮 CSS 瘦身时应优先收回。
  const FROZEN_ROOT_MAX_LINES = 40;
  const FROZEN_AGGREGATED_MAX_LINES = 17_610;
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
});
