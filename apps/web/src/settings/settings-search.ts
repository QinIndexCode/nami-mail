import type { SettingsCategoryId } from "./settings-categories";

export type SettingsSearchItem = {
  id: string;
  categoryId: SettingsCategoryId;
  titleKey: string;
  defaultTitleZh: string;
  defaultTitleEn: string;
  targetId?: string;
  keywords: readonly string[];
};

export type MatchedSearchItem = {
  id: string;
  title: string;
  targetId?: string;
  matchedKeyword?: string;
};

export type SettingsCategorySearchResult = {
  categoryId: SettingsCategoryId;
  score: number;
  matchedItems: MatchedSearchItem[];
};

/**
 * Semantic search index covering settings features, colloquial synonyms,
 * terminology in Chinese & English, and key UI elements across all 10 categories.
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchItem[] = [
  // 1. Language
  {
    id: "interface-language",
    categoryId: "language",
    titleKey: "language.label",
    defaultTitleZh: "界面语言",
    defaultTitleEn: "Interface Language",
    targetId: "interface-language",
    keywords: [
      "语言", "界面语言", "中文", "简体中文", "英文", "英语", "国际化", "本地化", "多语言",
      "language", "locale", "chinese", "english", "i18n", "localization", "ui language",
      "yuyan", "zhongwen", "yingwen", "bendi",
    ],
  },

  // 2. Appearance
  {
    id: "theme",
    categoryId: "appearance",
    titleKey: "settings.theme.groupLabel",
    defaultTitleZh: "主题外观",
    defaultTitleEn: "Theme",
    targetId: "appearance-settings",
    keywords: [
      "主题", "外观", "深色", "暗色", "浅色", "亮色", "夜间", "白天", "黑夜", "暗黑",
      "跟随系统", "模式", "皮肤", "配色", "高对比度", "颜色", "色彩",
      "theme", "dark", "light", "system", "mode", "color", "appearance", "contrast",
      "night mode", "dark mode", "light mode", "zhuti", "shense", "qianse", "yejian", "anhe",
    ],
  },
  {
    id: "density",
    categoryId: "appearance",
    titleKey: "settings.density.title",
    defaultTitleZh: "列表密度",
    defaultTitleEn: "List Density",
    targetId: "list-density",
    keywords: [
      "密度", "列表密度", "紧凑", "舒适", "标准", "行距", "行高", "间距", "排列", "布局", "宽松",
      "density", "compact", "comfortable", "standard", "spacing", "row height", "layout",
      "mizhi", "jincou", "shushi",
    ],
  },
  {
    id: "wallpaper",
    categoryId: "appearance",
    titleKey: "settings.background.title",
    defaultTitleZh: "背景壁纸",
    defaultTitleEn: "Wallpaper",
    targetId: "appearance-settings",
    keywords: [
      "壁纸", "背景", "自定义背景", "上传图片", "背景图片", "透明度", "强度", "毛玻璃",
      "模糊", "不透明度", "海滨", "薄雾", "晨曦", "纸纹", "预设",
      "wallpaper", "background", "custom background", "upload image", "blur", "opacity",
      "intensity", "presets", "mist", "coast", "paper", "dawn", "bizhi", "beijing",
    ],
  },
  {
    id: "avatars",
    categoryId: "appearance",
    titleKey: "settings.avatars.gravatar.label",
    defaultTitleZh: "发件人头像",
    defaultTitleEn: "Sender Avatars",
    targetId: "appearance-settings",
    keywords: [
      "头像", "发件人头像", "Gravatar", "BIMI", "品牌标识", "品牌图标", "图标", "发件人图标",
      "avatar", "avatars", "gravatar", "bimi", "brand", "logo", "sender avatar", "profile",
      "touxiang", "tubiao",
    ],
  },

  // 3. Notifications
  {
    id: "desktop-notifications",
    categoryId: "notifications",
    titleKey: "settings.notifications.desktop.label",
    defaultTitleZh: "桌面通知",
    defaultTitleEn: "Desktop Notifications",
    targetId: "notification-settings",
    keywords: [
      "通知", "桌面通知", "新邮件提醒", "弹窗", "横幅", "推送", "提醒", "消息通知",
      "notification", "desktop notification", "alert", "banner", "toast", "push",
      "tongzhi", "tixing",
    ],
  },
  {
    id: "sound",
    categoryId: "notifications",
    titleKey: "settings.notifications.sound.label",
    defaultTitleZh: "提示音",
    defaultTitleEn: "Notification Sound",
    targetId: "notification-settings",
    keywords: [
      "声音", "提示音", "铃声", "音效", "静音", "响铃", "测试声音", "水滴", "风铃", "经典",
      "sound", "audio", "ringtone", "chime", "bell", "alert sound", "mute", "volume",
      "shengyin", "tishiyin", "lingsheng", "jingyin",
    ],
  },
  {
    id: "focus",
    categoryId: "notifications",
    titleKey: "settings.notifications.focus.label",
    defaultTitleZh: "前台通知",
    defaultTitleEn: "Notify when Focused",
    targetId: "notification-settings",
    keywords: [
      "前台", "专注", "窗口前台", "聚焦", "前台通知", "窗口激活",
      "focus", "foreground", "window active", "active window", "focused",
      "qiantai", "zhuanzhu",
    ],
  },

  // 4. Desktop
  {
    id: "startup",
    categoryId: "desktop",
    titleKey: "settings.desktop.startup.label",
    defaultTitleZh: "开机自启",
    defaultTitleEn: "Launch on Startup",
    targetId: "desktop-settings",
    keywords: [
      "开机自启", "自启动", "启动项", "开机运行", "后台自启", "开机启动", "登录启动",
      "startup", "launch at startup", "autostart", "boot", "auto run", "login",
      "kaiji", "ziqidong", "qidong",
    ],
  },
  {
    id: "close-behavior",
    categoryId: "desktop",
    titleKey: "settings.desktop.closeBehavior.label",
    defaultTitleZh: "窗口关闭行为",
    defaultTitleEn: "Close Behavior",
    targetId: "desktop-settings",
    keywords: [
      "关闭", "窗口关闭", "最小化", "托盘", "系统托盘", "退出程序", "后台运行", "关闭按钮", "隐藏窗口",
      "close", "minimize", "tray", "system tray", "exit", "quit", "close behavior", "hide",
      "guanbi", "tuopan", "zuixiaohua", "tuichu",
    ],
  },
  {
    id: "updates",
    categoryId: "desktop",
    titleKey: "settings.desktop.updates.label",
    defaultTitleZh: "软件更新",
    defaultTitleEn: "Software Updates",
    targetId: "desktop-settings",
    keywords: [
      "更新", "检查更新", "升级", "版本", "重启更新", "自动更新", "新版本", "版本号",
      "update", "check update", "version", "upgrade", "software update", "restart update",
      "gengxin", "shengji", "banben",
    ],
  },

  // 5. Sync
  {
    id: "refresh-interval",
    categoryId: "sync",
    titleKey: "settings.sync.interval.label",
    defaultTitleZh: "自动检查频率",
    defaultTitleEn: "Auto-Check Interval",
    targetId: "sync-settings",
    keywords: [
      "频率", "同步频率", "轮询", "定时检查", "刷新间隔", "自动拉取", "时间间隔", "检查新邮件", "收取",
      "interval", "frequency", "poll", "refresh interval", "fetch", "check mail", "sync interval",
      "pinlv", "tongbu", "shuaxin", "jiange",
    ],
  },
  {
    id: "realtime",
    categoryId: "sync",
    titleKey: "settings.sync.realtime.label",
    defaultTitleZh: "实时推送",
    defaultTitleEn: "Realtime Push",
    targetId: "sync-settings",
    keywords: [
      "实时推送", "IDLE", "IMAP IDLE", "即时同步", "长连接", "实时收取", "推送", "长轮询", "即时邮件",
      "realtime", "push", "idle", "imap idle", "instant sync", "instant push", "connection",
      "shishi", "tuisong",
    ],
  },
  {
    id: "cache",
    categoryId: "sync",
    titleKey: "settings.sync.cache.label",
    defaultTitleZh: "每文件夹缓存上限",
    defaultTitleEn: "Folder Cache Limit",
    targetId: "sync-settings",
    keywords: [
      "缓存", "邮件缓存", "本地缓存", "存储上限", "容量", "离线缓存", "每文件夹条数", "磁盘占用", "空间",
      "cache", "offline cache", "folder limit", "storage", "message cache", "cache size",
      "huancun", "rongliang", "cunchu",
    ],
  },

  // 6. Filters
  {
    id: "filter-rules",
    categoryId: "filters",
    titleKey: "settings.filterRules.title",
    defaultTitleZh: "过滤规则",
    defaultTitleEn: "Filter Rules",
    targetId: "filter-settings",
    keywords: [
      "过滤", "规则", "黑名单", "白名单", "拦截", "自动归档", "自动分类", "标记已读", "移动到文件夹",
      "发件人包含", "主题包含", "条件", "动作", "垃圾邮件", "免打扰", "星标",
      "filter", "rules", "mail rules", "blacklist", "whitelist", "spam", "move", "archive",
      "mark read", "auto filter", "conditions", "actions", "guolv", "guize", "heimingdan", "baimingdan",
    ],
  },

  // 7. Models
  {
    id: "providers",
    categoryId: "models",
    titleKey: "settings.nav.models.title",
    defaultTitleZh: "语言模型提供商",
    defaultTitleEn: "Language Models",
    targetId: "models-settings",
    keywords: [
      "模型", "大模型", "LLM", "OpenAI", "DeepSeek", "Ollama", "Claude", "Anthropic", "Gemini",
      "API Key", "APIKey", "密钥", "Token", "服务地址", "端点", "Endpoint", "默认模型", "超时时间",
      "云端发送授权", "自定义模型", "基底模型", "接入点",
      "model", "language model", "llm", "provider", "openai", "deepseek", "ollama", "claude",
      "anthropic", "gemini", "api key", "endpoint", "default model", "timeout", "token",
      "moxing", "miyao", "duandian", "damoxing",
    ],
  },

  // 8. MCP Tools (Internal)
  {
    id: "mcp-tools",
    categoryId: "mcp",
    titleKey: "settings.nav.mcp.title",
    defaultTitleZh: "内置 MCP 工具服务",
    defaultTitleEn: "Built-in MCP Tools",
    targetId: "models-settings",
    keywords: [
      "MCP", "工具", "插件", "Server", "stdio", "npx", "node", "filesystem", "模型上下文协议",
      "扩展", "环境变量", "命令行参数", "工作目录", "外部工具", "协议", "预设", "模板", "知识图谱", "数据库", "git",
      "mcp", "tools", "server", "command", "args", "env", "environment", "model context protocol",
      "cwd", "stdio", "gongju", "chajian", "fuwuqi",
    ],
  },

  // 9. Connections (External Exposed MCP, CLI & Client Pairings)
  {
    id: "connections-mcp",
    categoryId: "connections",
    titleKey: "settings.connections.mcp.title",
    defaultTitleZh: "本地外露 MCP 服务",
    defaultTitleEn: "Local Exposed MCP Server",
    targetId: "connections-settings",
    keywords: [
      "外露MCP", "本地MCP", "Claude Desktop", "Cursor", "VS Code", "Windsurf", "IDE", "mcpServers",
      "namimail mcp start", "配置文件", "代码生成", "只读工具", "写入工具", "16个工具", "MCP权限",
      "exposed mcp", "claude", "cursor", "vscode", "windsurf", "ide config", "json config",
      "wailu", "waibu mcp",
    ],
  },
  {
    id: "connections-cli",
    categoryId: "connections",
    titleKey: "settings.connections.cli.title",
    defaultTitleZh: "外部终端 CLI 与命令",
    defaultTitleEn: "External Terminal CLI",
    targetId: "connections-settings",
    keywords: [
      "CLI", "终端", "命令行", "namimail", "脚本", "PowerShell", "CMD", "Bash", "速查表",
      "namimail pair", "namimail status", "namimail accounts list", "namimail messages search",
      "服务管理", "namimail service start", "CLI权限",
      "cli", "terminal", "command line", "namimail", "powershell", "cmd", "bash", "cheatsheet",
      "zhongduan", "mingling",
    ],
  },
  {
    id: "connections-pairings",
    categoryId: "connections",
    titleKey: "settings.connections.pairings.title",
    defaultTitleZh: "已授权客户端配对",
    defaultTitleEn: "Authorized Client Pairings",
    targetId: "connections-settings",
    keywords: [
      "配对", "授权", "撤销授权", "撤销配对", "已授权客户端", "Ed25519", "漂移", "drift", "客户端列表",
      "pairings", "authorized clients", "revoke", "disconnect", "client id",
      "peidui", "chexiao",
    ],
  },

  // 9. Agent
  {
    id: "agent-reasoning",
    categoryId: "agent",
    titleKey: "agent.launch",
    defaultTitleZh: "AI 邮件助理与推理",
    defaultTitleEn: "AI Mail Assistant",
    targetId: "agent-settings",
    keywords: [
      "助理", "AI助理", "邮件助理", "推理", "工具调用轮数", "最大轮数", "思考轮数", "配对",
      "外部访问", "开发者接口", "CLI接入", "助手", "智能化", "模型协同",
      "agent", "assistant", "mail assistant", "reasoning", "rounds", "tool round limit",
      "developer", "pairing", "stepper", "cli", "zhuli", "tuili", "zhineng",
    ],
  },
  {
    id: "auto-reply",
    categoryId: "agent",
    titleKey: "settings.agent.autoReplyGroup",
    defaultTitleZh: "自动回复",
    defaultTitleEn: "Auto-Reply",
    targetId: "agent-settings",
    keywords: [
      "自动回复", "自动邮件", "回复规则", "匹配规则", "发件人匹配", "仅联系人", "生效时间",
      "假期回复", "模板回复", "免确认", "请假", "不在办公室", "外出",
      "决策模型", "决策筛选", "判断模型", "起草模型", "回复模型", "Jev", "System 1",
      "auto reply", "auto response", "rules", "out of office", "template", "responder",
      "vacation", "auto responder", "contacts only", "decision model", "draft model",
      "zidonghuifu", "huifu", "jiaqi", "juece", "qicao",
    ],
  },
  {
    id: "memory",
    categoryId: "agent",
    titleKey: "settings.agent.memory",
    defaultTitleZh: "记忆管理",
    defaultTitleEn: "Memory Management",
    targetId: "agent-settings",
    keywords: [
      "记忆", "AI记忆", "偏好", "上下文记忆", "长期记忆", "用户偏好", "记忆建议", "清除记忆", "记住",
      "memory", "agent memory", "preferences", "context", "long term memory", "remember",
      "jiyi", "pianhao",
    ],
  },

  // 10. Translation
  {
    id: "translation-service",
    categoryId: "translation",
    titleKey: "settings.translation.title",
    defaultTitleZh: "翻译服务",
    defaultTitleEn: "Translation Service",
    targetId: "translation-settings",
    keywords: [
      "翻译", "翻译服务", "Google翻译", "DeepL", "MyMemory", "Ollama翻译", "划词翻译", "邮件翻译",
      "英译中", "中译英", "端点", "API密钥", "API Key", "测试连接", "语言包", "双语",
      "translate", "translation", "engine", "google", "deepl", "mymemory", "ollama", "bilingual",
      "api key", "endpoint", "fanyi", "shuangyu",
    ],
  },
];

/** Category fallback labels if key translation is absent */
const categoryDefaultTitles: Record<SettingsCategoryId, { zh: string; en: string }> = {
  language: { zh: "界面语言", en: "Language" },
  appearance: { zh: "外观与主题", en: "Appearance & Theme" },
  notifications: { zh: "通知与提示", en: "Notifications" },
  desktop: { zh: "桌面客户端", en: "Desktop Client" },
  sync: { zh: "邮件同步", en: "Mail Sync" },
  filters: { zh: "邮件过滤", en: "Mail Filters" },
  models: { zh: "语言模型", en: "Language Models" },
  mcp: { zh: "MCP 工具", en: "MCP Tools" },
  connections: { zh: "外部连接", en: "External Connections" },
  agent: { zh: "AI 邮件助理", en: "AI Mail Assistant" },
  translation: { zh: "翻译服务", en: "Translation Service" },
};

/**
 * Executes semantic search across all settings categories and items.
 * Returns `null` if query is empty or whitespace.
 * Returns ranked `SettingsCategorySearchResult[]` if query is present.
 */
export function searchSettings(
  query: string,
  t: (key: string) => string,
  isDesktopRuntime: boolean,
): SettingsCategorySearchResult[] | null {
  const clean = query.trim().toLowerCase();
  if (!clean) return null;

  const tokens = clean.split(/\s+/).filter(Boolean);
  const categories = Object.keys(categoryDefaultTitles) as SettingsCategoryId[];

  const results: SettingsCategorySearchResult[] = [];

  for (const catId of categories) {
    if (catId === "desktop" && !isDesktopRuntime) continue;

    const catFallback = categoryDefaultTitles[catId];
    // Category title might come from t(key) or fallback
    const catTitleZh = catFallback.zh.toLowerCase();
    const catTitleEn = catFallback.en.toLowerCase();

    let baseScore = 0;
    if (catTitleZh === clean || catTitleEn === clean) {
      baseScore = 150;
    } else if (catTitleZh.includes(clean) || catTitleEn.includes(clean)) {
      baseScore = 110;
    } else if (clean.includes(catTitleZh) || clean.includes(catTitleEn)) {
      baseScore = 90;
    }

    const matchedItems: MatchedSearchItem[] = [];
    let maxItemScore = 0;

    const itemsForCategory = SETTINGS_SEARCH_INDEX.filter((it) => it.categoryId === catId);

    for (const item of itemsForCategory) {
      let itemTitle = "";
      try {
        const translated = t(item.titleKey);
        itemTitle = (translated && translated !== item.titleKey) ? translated : item.defaultTitleZh;
      } catch {
        itemTitle = item.defaultTitleZh;
      }
      const itemTitleLower = itemTitle.toLowerCase();
      const defaultTitleZhLower = item.defaultTitleZh.toLowerCase();
      const defaultTitleEnLower = item.defaultTitleEn.toLowerCase();

      let itemScore = 0;
      let matchedKeyword: string | undefined = undefined;

      // Exact title match
      if (itemTitleLower === clean || defaultTitleZhLower === clean || defaultTitleEnLower === clean) {
        itemScore = 100;
      } else if (
        itemTitleLower.includes(clean)
        || defaultTitleZhLower.includes(clean)
        || defaultTitleEnLower.includes(clean)
      ) {
        itemScore = 80;
      }

      // Check keywords
      for (const kw of item.keywords) {
        const kwLower = kw.toLowerCase();
        if (kwLower === clean) {
          if (itemScore < 95) {
            itemScore = 95;
            matchedKeyword = kw;
          }
        } else if (kwLower.includes(clean)) {
          if (itemScore < 75) {
            itemScore = 75;
            matchedKeyword = kw;
          }
        } else if (clean.includes(kwLower) && kwLower.length >= 2) {
          if (itemScore < 70) {
            itemScore = 70;
            matchedKeyword = kw;
          }
        }
      }

      // Multi-token match: all tokens match title or some keyword
      if (itemScore === 0 && tokens.length > 1) {
        const allMatch = tokens.every((token) => (
          itemTitleLower.includes(token)
          || defaultTitleZhLower.includes(token)
          || defaultTitleEnLower.includes(token)
          || item.keywords.some((k) => k.toLowerCase().includes(token))
        ));
        if (allMatch) {
          itemScore = 65;
          matchedKeyword = tokens.join(" ");
        }
      }

      if (itemScore > 0) {
        maxItemScore = Math.max(maxItemScore, itemScore);
        matchedItems.push({
          id: item.id,
          title: itemTitle,
          targetId: item.targetId,
          matchedKeyword,
        });
      }
    }

    if (baseScore > 0 || matchedItems.length > 0) {
      const finalScore = baseScore + maxItemScore + matchedItems.length * 5;
      results.push({
        categoryId: catId,
        score: finalScore,
        matchedItems,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
