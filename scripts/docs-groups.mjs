/**
 * Topic groups shared by every documentation surface.
 *
 * Single source of truth: `build-docs-site.mjs` uses the labels and blurbs for
 * the documentation overview and the sidebar, `wiki-sync.mjs` uses the labels
 * for the wiki navigation. Adding a group here updates both; nothing else may
 * keep its own copy.
 *
 * `root` is only meaningful to the docs site (repository-root documents are
 * published under `site/docs/_root/`). The wiki tree never includes them, so
 * `wiki-sync.mjs` filters that group out.
 */
export const GROUPS = [
  {
    id: "guide",
    label: { zh: "使用指南", en: "Guide" },
    blurb: { zh: "安装、账户、隐私与日常使用。", en: "Install, accounts, privacy and everyday use." },
  },
  {
    id: "agent",
    label: { zh: "Agent", en: "Agent" },
    blurb: {
      zh: "工作区、工具授权范围、确认与审计。",
      en: "The workspace, tool scopes, confirmations and auditing.",
    },
  },
  {
    id: "rag",
    label: { zh: "邮件检索 (RAG)", en: "Mail search (RAG)" },
    blurb: {
      zh: "本地索引、页面切分、查询扩展与检索排障。",
      en: "Local index, page chunking, query expansion and troubleshooting.",
    },
  },
  {
    id: "mcp",
    label: { zh: "MCP Server", en: "MCP Server" },
    blurb: {
      zh: "把 Nami Mail 接入 MCP 客户端：配对、权限档与工具清单。",
      en: "Connect Nami Mail to an MCP client: pairing, access levels and tools.",
    },
  },
  {
    id: "cli",
    label: { zh: "CLI 命令行", en: "CLI" },
    blurb: {
      zh: "namimail 命令、参数、输出与退出码。",
      en: "The namimail command, its arguments, output and exit codes.",
    },
  },
  {
    id: "development",
    label: { zh: "开发", en: "Development" },
    blurb: { zh: "架构、约定、测试口径与重构计划。", en: "Architecture, conventions, test scope and refactoring plans." },
  },
  {
    id: "releases",
    label: { zh: "版本发布", en: "Releases" },
    blurb: { zh: "每个版本的发布说明与升级注意事项。", en: "Release notes and upgrade notes for every version." },
  },
  {
    id: "root",
    label: { zh: "项目文档", en: "Project" },
    blurb: {
      zh: "仓库根目录的公开文档：支持、安全、贡献与变更日志。",
      en: "Public repository documents: support, security, contributing and the changelog.",
    },
  },
  {
    id: "misc",
    label: { zh: "其他", en: "Misc" },
    blurb: { zh: "未归类的文档。", en: "Documents outside the groups above." },
  },
];
