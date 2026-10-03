import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// ---------------------------------------------------------------------------
// 巨型文件冻结（第二批）：覆盖 ≥700 行且尚未冻结的存量文件，阈值为当前行数 +10。
// 与下方四个手写棘轮同口径（skipBlankLines/skipComments=false，计入空行与注释），
// 堵住"把代码搬进未冻结文件即可绕过棘轮"的反弹路径；新抽取模块放新文件不受限。
// 逐批瘦身时同步下调对应数值。
// ---------------------------------------------------------------------------
const monolithRatchets = [
  ["apps/server/src/agent/run-engine.ts", 1835],
  ["apps/server/src/agent-rag-worker.ts", 1486],
  ["apps/server/src/sync.ts", 1250],
  ["apps/server/src/agent/mail-tools.ts", 1101],
  ["apps/server/src/sync-moves.ts", 793],
  ["apps/server/src/routes/messages.ts", 982],
  ["apps/server/src/agent/auto-reply.ts", 856],
  ["apps/server/src/db.ts", 846],
  ["apps/server/src/agent/schema.ts", 807],
  ["apps/server/src/agent/sqlite-mail-application-service.ts", 768],
  ["apps/server/src/outbox.ts", 780],
  ["apps/server/src/agent/openai-compatible-provider.ts", 749],
  ["apps/web/src/AddAccountModal.tsx", 1927],
  ["apps/web/src/SettingsModal.tsx", 1409],
  ["apps/web/src/demoProviderCatalog.ts", 1113],
  ["apps/web/src/agent/useAgentSession.ts", 1041],
  ["apps/web/src/CalendarDialog.tsx", 987],
  ["apps/web/src/api.ts", 843],
  ["apps/web/src/ComposeModal.tsx", 767],
  ["apps/desktop/src/desktop-smoke.mts", 1346],
  ["apps/desktop/src/agent/cli.mts", 910],
  ["apps/desktop/src/agent/desktop-broker.mts", 902],
];
const monolithRatchetConfigs = monolithRatchets.map(([file, max]) => ({
  files: [file],
  rules: { "max-lines": ["error", { max, skipBlankLines: false, skipComments: false }] },
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-check*/**",
      "**/build/**",
      "**/release-artifacts/**",
      "**/output/**",
      "**/artifacts/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/web/src/locales/*.generated.ts",
      "apps/desktop/src/native-locale-catalog.generated.mts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "require-yield": "off",
      "no-unsafe-finally": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
      "no-control-regex": "off",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.ts", "e2e/**/*.ts", "apps/server/**/*.ts", "apps/desktop/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
      "no-control-regex": "off",
    },
  },

  // ---------------------------------------------------------------------------
  // 分层卡口（防回弹）：路由层不得直接执行 SQL。
  //
  // 存量 39 处（messages 17 / accounts 15 / avatars 5 / filter-rules 2）已全部
  // 迁入领域模块，因此规则现在是 error：任何新的路由内 SQL 都会让 lint 失败。
  // ---------------------------------------------------------------------------
  {
    files: ["apps/server/src/routes/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^(prepare|transaction|exec|run)$/]",
          message: "路由层不得直接执行 SQL；请把查询搬进领域函数后调用。",
        },
      ],
    },
  },

  // 巨型文件冻结：只允许瘦身，不允许继续增长（阈值为当前行数 + 少量余量）。
  {
    files: ["apps/web/src/App.tsx"],
    rules: { "max-lines": ["error", { max: 4380, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/server/src/agent-service.ts"],
    rules: { "max-lines": ["error", { max: 1315, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/desktop/src/main.mts"],
    rules: { "max-lines": ["error", { max: 2112, skipBlankLines: false, skipComments: false }] },
  },
  {
    // 反思轮发现：把代码搬进未冻结的文件即可绕过上述棘轮（App.tsx 的反弹路径）。
    // 补齐剩余巨型 TS 文件。styles.css 无法由 eslint 解析，其棘轮见
    // apps/web/src/styles-size.test.ts（与 designTokens.test.ts 同一读取模式）。
    files: ["apps/web/src/AgentWorkspace.tsx"],
    rules: { "max-lines": ["error", { max: 2516, skipBlankLines: false, skipComments: false }] },
  },

  ...monolithRatchetConfigs,
);
