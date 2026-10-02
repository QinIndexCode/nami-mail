import { describe, expect, it } from "vitest";
import { searchSettings, SETTINGS_SEARCH_INDEX } from "./settings-search";

const mockT = (key: string) => {
  const map: Record<string, string> = {
    "language.title": "界面语言",
    "language.label": "界面语言",
    "settings.appearance.title": "外观",
    "settings.theme.groupLabel": "主题",
    "settings.density.title": "列表密度",
    "settings.background.title": "背景",
    "settings.avatars.gravatar.label": "发件人头像（Gravatar）",
    "settings.notifications.title": "通知",
    "settings.notifications.desktop.label": "桌面通知",
    "settings.notifications.sound.label": "提示音",
    "settings.desktop.title": "桌面",
    "settings.desktop.startup.label": "开机自启",
    "settings.desktop.closeBehavior.label": "窗口关闭行为",
    "settings.desktop.updates.label": "软件更新",
    "settings.sync.title": "同步",
    "settings.sync.interval.label": "自动检查频率",
    "settings.sync.realtime.label": "实时推送",
    "settings.sync.cache.label": "每文件夹缓存上限",
    "settings.nav.filters.title": "邮件过滤",
    "settings.filterRules.title": "过滤规则",
    "settings.nav.models.title": "语言模型",
    "settings.nav.mcp.title": "MCP 工具",
    "agent.launch": "AI 邮件助理",
    "settings.agent.autoReplyGroup": "自动回复",
    "settings.agent.memory": "记忆管理",
    "settings.translation.title": "翻译服务",
  };
  return map[key] || key;
};

describe("settings-search", () => {
  it("covers all categories in the search index", () => {
    const categoriesInIndex = new Set(SETTINGS_SEARCH_INDEX.map((item) => item.categoryId));
    expect(categoriesInIndex.size).toBe(10);
    expect(categoriesInIndex.has("language")).toBe(true);
    expect(categoriesInIndex.has("appearance")).toBe(true);
    expect(categoriesInIndex.has("notifications")).toBe(true);
    expect(categoriesInIndex.has("desktop")).toBe(true);
    expect(categoriesInIndex.has("sync")).toBe(true);
    expect(categoriesInIndex.has("filters")).toBe(true);
    expect(categoriesInIndex.has("models")).toBe(true);
    expect(categoriesInIndex.has("mcp")).toBe(true);
    expect(categoriesInIndex.has("agent")).toBe(true);
    expect(categoriesInIndex.has("translation")).toBe(true);
  });

  it("returns null on empty or whitespace queries", () => {
    expect(searchSettings("", mockT, true)).toBeNull();
    expect(searchSettings("   ", mockT, true)).toBeNull();
  });

  it("returns empty array for queries that do not match anything", () => {
    const results = searchSettings("xyznonexistentfoo123", mockT, true);
    expect(results).toEqual([]);
  });

  it("performs semantic matching for theme & appearance keywords", () => {
    // Chinese synonym: 暗色 / 黑夜 / 深色
    const r1 = searchSettings("暗色", mockT, true);
    expect(r1).not.toBeNull();
    expect(r1![0].categoryId).toBe("appearance");
    expect(r1![0].matchedItems.some((it) => it.id === "theme")).toBe(true);

    // English keyword: dark
    const r2 = searchSettings("dark", mockT, true);
    expect(r2![0].categoryId).toBe("appearance");

    // Wallpaper
    const r3 = searchSettings("壁纸", mockT, true);
    expect(r3![0].categoryId).toBe("appearance");
    expect(r3![0].matchedItems.some((it) => it.id === "wallpaper")).toBe(true);
  });

  it("performs semantic matching for notifications and sounds", () => {
    // Sound / chime / 铃声
    const r1 = searchSettings("铃声", mockT, true);
    expect(r1![0].categoryId).toBe("notifications");
    expect(r1![0].matchedItems.some((it) => it.id === "sound")).toBe(true);

    const r2 = searchSettings("chime", mockT, true);
    expect(r2![0].categoryId).toBe("notifications");
  });

  it("performs semantic matching for desktop features", () => {
    // Startup
    const r1 = searchSettings("开机自启", mockT, true);
    expect(r1![0].categoryId).toBe("desktop");
    expect(r1![0].matchedItems.some((it) => it.id === "startup")).toBe(true);

    // Close to tray
    const r2 = searchSettings("托盘", mockT, true);
    expect(r2![0].categoryId).toBe("desktop");
    expect(r2![0].matchedItems.some((it) => it.id === "close-behavior")).toBe(true);

    // Excludes desktop when isDesktopRuntime is false
    const r3 = searchSettings("开机自启", mockT, false);
    expect(r3?.some((r) => r.categoryId === "desktop")).toBe(false);
  });

  it("performs semantic matching for mail sync and cache", () => {
    const r1 = searchSettings("缓存", mockT, true);
    expect(r1![0].categoryId).toBe("sync");
    expect(r1![0].matchedItems.some((it) => it.id === "cache")).toBe(true);

    const r2 = searchSettings("IDLE", mockT, true);
    expect(r2![0].categoryId).toBe("sync");
    expect(r2![0].matchedItems.some((it) => it.id === "realtime")).toBe(true);
  });

  it("performs semantic matching for filter rules", () => {
    const r1 = searchSettings("黑名单", mockT, true);
    expect(r1![0].categoryId).toBe("filters");
    expect(r1![0].matchedItems.some((it) => it.id === "filter-rules")).toBe(true);

    const r2 = searchSettings("垃圾邮件", mockT, true);
    expect(r2![0].categoryId).toBe("filters");
  });

  it("performs semantic matching for LLM models and API Keys", () => {
    const r1 = searchSettings("OpenAI", mockT, true);
    expect(r1![0].categoryId).toBe("models");

    const r2 = searchSettings("DeepSeek", mockT, true);
    expect(r2![0].categoryId).toBe("models");

    // Token / 密钥 matches models
    const r3 = searchSettings("密钥", mockT, true);
    expect(r3!.some((r) => r.categoryId === "models")).toBe(true);
    expect(r3!.some((r) => r.categoryId === "translation")).toBe(true);
  });

  it("performs semantic matching for MCP tools", () => {
    const r1 = searchSettings("MCP", mockT, true);
    expect(r1![0].categoryId).toBe("mcp");

    const r2 = searchSettings("stdio", mockT, true);
    expect(r2![0].categoryId).toBe("mcp");
  });

  it("performs semantic matching for AI Assistant features", () => {
    // Auto-reply
    const r1 = searchSettings("自动回复", mockT, true);
    expect(r1![0].categoryId).toBe("agent");
    expect(r1![0].matchedItems.some((it) => it.id === "auto-reply")).toBe(true);

    // Memory
    const r2 = searchSettings("记忆", mockT, true);
    expect(r2![0].categoryId).toBe("agent");
    expect(r2![0].matchedItems.some((it) => it.id === "memory")).toBe(true);

    // Reasoning rounds
    const r3 = searchSettings("推理轮数", mockT, true);
    expect(r3![0].categoryId).toBe("agent");
  });

  it("performs semantic matching for translation", () => {
    const r1 = searchSettings("DeepL", mockT, true);
    expect(r1![0].categoryId).toBe("translation");

    const r2 = searchSettings("翻译", mockT, true);
    expect(r2![0].categoryId).toBe("translation");
  });
});
