import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// ---------------------------------------------------------------------------
// 巨型文件冻结（第二批）：覆盖 ≥700 行的存量文件。阈值 = **实测行数**（第 6 批·棘轮收口
// 时逐条量取）。
//
// **取数的尺子**：ESLint 的 max-lines 数的是物理行——按换行分行，**末行没有换行也算一行**。
// 所以它与 `wc -l` 只在文件以换行结尾时相等；本仓有四个文件末尾无换行（auto-reply.ts /
// useAgentSession.ts / CalendarDialog.tsx / ComposeModal.tsx），ESLint 比 `wc -l` 各多 1。
// 这不是理论推演：第一次收口就是拿 `wc -l` 当尺子写的，`npm run lint` 立刻红四条，报的
// 正是 851/1040/971/764——**eslint 自己报的才是准数**，别再用 `wc -l` 量这四个。
//
// 与下方四个手写棘轮同口径（skipBlankLines/skipComments=false，计入空行与注释），
// 堵住"把代码搬进未冻结文件即可绕过棘轮"的反弹路径；新抽取模块放新文件不受限。
//
// 为什么是实测值而不是"实测 + 余量"：本重构之后没有一条计划中的改动会再让这些文件
// 增长（第 6 批只剩删死代码与文档），所以余量只会变成**允许静默回涨的许可**，而回涨
// 正是棘轮要防的事。需要 +1 行时答案是先删一行或拆文件，不是抬上限——本文件开头那句
// "只降不升"就是这个意思。
//
// 对照：`apps/web/src/styles-size.test.ts` 的 CSS 聚合棘轮用的是"实测 + 12"，因为
// 样式模块是**living** 文件、日常合法增长只能靠一次**显式记录的上调**吸收；两者对象
// 不同所以政策不同，**不要为了"统一"去改任何一边**（CSS 那 12 行余量另有测试守着）。
// ---------------------------------------------------------------------------
const monolithRatchets = [
  ["apps/server/src/agent/run-engine.ts", 1927],
  ["apps/server/src/agent-rag-worker.ts", 1486],
  ["apps/server/src/sync.ts", 1196],
  ["apps/server/src/agent/mail-tools.ts", 1093],
  ["apps/server/src/sync-moves.ts", 789],
  ["apps/server/src/routes/messages.ts", 929],
  ["apps/server/src/agent/auto-reply.ts", 851],
  ["apps/server/src/db.ts", 188],
  ["apps/server/src/agent/schema.ts", 649],
  ["apps/server/src/agent/sqlite-mail-application-service.ts", 762],
  ["apps/server/src/outbox.ts", 830],
  ["apps/server/src/agent/openai-compatible-provider.ts", 476],
  ["apps/web/src/AddAccountModal.tsx", 1868],
  ["apps/web/src/SettingsModal.tsx", 1329],
  ["apps/web/src/demoProviderCatalog.ts", 1103],
  ["apps/web/src/agent/useAgentSession.ts", 1040],
  ["apps/web/src/CalendarDialog.tsx", 971],
  ["apps/web/src/api.ts", 843],
  ["apps/web/src/ComposeModal.tsx", 764],
  ["apps/desktop/src/desktop-smoke.mts", 1325],
  ["apps/desktop/src/agent/cli.mts", 901],
  ["apps/desktop/src/agent/desktop-broker.mts", 910],
];
const monolithRatchetConfigs = monolithRatchets.map(([file, max]) => ({
  files: [file],
  rules: { "max-lines": ["error", { max, skipBlankLines: false, skipComments: false }] },
}));

// ---------------------------------------------------------------------------
// G15：legacy 写入层不得复活（架构契约 §8 G15 · §7 第 4 件）。
//
// 第 4 件删掉了 operation-queue.ts / batch-jobs.ts / batch-job-schema.ts。文件消失
// 本身不是护栏——没人 import 一个已删文件，删掉它不会让任何检查变红——护栏是这条
// 规则：把它们 import 回来就报错。列表写成一个常量并被下面两条配置共用，原因是
// flat config 里后匹配的同一条规则会**整条覆盖**前一条：把 G15 的 patterns 直接
// 塞进 routes 那条，会在下一次改动里把 db.js 的黑名单悄悄顶掉。
//
// 写法上的两处不对称都是可执行的约束，不是风格：
//   * operation-queue / batch-job-schema 用 glob：两者都没有同名的合法文件，
//     `**/operation-queue.js` 只可能指向那个已删模块。
//   * batch-jobs 只能枚举相对拼写：patterns 是 gitignore 式匹配，`**/batch-jobs.js`
//     会连 `app.ts` 的 "./routes/batch-jobs.js"（第 3 件留下的兼容别名路由）一起
//     拦下，而那条导入是正当的。四个前缀 × 两种扩展名覆盖本仓相对导入的全部拼写，
//     `tests/legacy-layer-removal.test.ts` 静态核过没有第五种。
// ---------------------------------------------------------------------------
const legacyLayerImportBans = [
  {
    group: ["**/operation-queue.js", "**/operation-queue.ts", "**/batch-job-schema.js", "**/batch-job-schema.ts"],
    message: "legacy 写入层已删除（契约 §7 第 4 件 · §8 G15）；写入请走 tasks/ 的统一提交入口。",
  },
  {
    group: [
      "./batch-jobs.js", "../batch-jobs.js", "../../batch-jobs.js", "../../../batch-jobs.js",
      "./batch-jobs.ts", "../batch-jobs.ts", "../../batch-jobs.ts", "../../../batch-jobs.ts",
    ],
    message: "legacy batch-jobs 模块已删除；批量写入请走 tasks/（routes/batch-jobs.ts 是保留的兼容别名，按 ./routes/batch-jobs.js 导入）。",
  },
];

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
      // Generated pdf.js runtime assets (gitignored, copied by
      // scripts/copy-pdfjs-assets.mjs). They are vendored third-party JS with
      // minified one-letter identifiers; lint has nothing to say about them.
      "apps/web/public/pdfjs/**",
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
  //
  // 两层并存，缺一不可：
  // 1) no-restricted-syntax 按**方法名**匹配调用点，拦得住 db.prepare(...)，但拦不住
  //    deleteAccountRowWithOptimizedCascade(db, id) —— 包一层领域函数就把 SQL 藏进了
  //    别的文件，路由层看不出自己在执行 SQL。该绕过点曾真实存在于 routes/accounts.ts，
  //    已随函数迁入 account-store.ts 一并消除。
  // 2) no-restricted-imports 因此按**导入的模块**收口：路由层拿不到裸 db 句柄与 SQL
  //    执行入口，就无法自己拼语句。这是结构性约束，不依赖调用点写法，无法被包装函数绕过。
  //
  // 黑名单只收"能拿到 DatabaseHandle / SQLite 构造器"的模块：db.js（句柄、迁移、
  // openDatabase）与 native-sqlite.js（better-sqlite3 加载器）。领域模块
  // （account-store / message-queries / outbox 等）只导出领域函数、不导出裸句柄，
  // 路由层继续正常依赖它们 —— 实测 routes/** 的 124 处相对导入中仅 accounts.ts 命中 db.js。
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
      "no-restricted-imports": [
        "error",
        {
          // 只用 patterns：它按 glob 匹配，既覆盖当前 routes/*.ts 的 "../db.js"，
          // 也覆盖日后新增的 routes/<子目录>/*.ts 的 "../../db.js"，不必随目录加深再补条目。
          patterns: [
            {
              group: ["**/db.js", "**/db.ts", "**/native-sqlite.js", "**/native-sqlite.ts"],
              message: "路由层不得导入裸 DatabaseHandle 或 SQLite 驱动（raw sqlite）；请从领域模块（如 account-store.js）导入数据访问函数。",
            },
            // 路由层同样是 G15 的适用范围；见上方常量处的说明。
            ...legacyLayerImportBans,
          ],
        },
      ],
    },
  },

  // G15 的服务端全域半边：routes 之外、scripts 之外的一切。
  //
  // 覆盖面按契约 §十八 H 的口径写：删除面要在**全仓**上量，因为"生产代码在 src/"是关于调用者的经验，
  // 不是关于被删对象的经验——被删层的旧见证测试（tests/）就是最可能的复活点之一，它不在 src/ 里。
  // 两条豁免都是实测出来的，不是"看起来没事"：
  //   * routes 自己在上一条里已经带上同一份 legacyLayerImportBans（flat config 里同一条规则的
  //     后匹配会整条覆盖前一条，所以这里必须把它排除，否则会把 db.js 的黑名单顶掉）。
  //   * scripts/ 只剩 scripts/export-legacy-store-fixture.mts（已入库），它导入的正是本批删掉的
  //     模块，因此**加载即失败**，比 lint 报错更响；保留它是刻意留下的迁移取证脚本。
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["apps/server/src/routes/**/*.ts", "scripts/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [...legacyLayerImportBans] }],
    },
  },

  // ---------------------------------------------------------------------------
  // S2：附件预览管道的两条结构性约束。
  //
  // ① URL.createObjectURL 只允许出现在**拥有 revoke 责任**的模块里：
  //    attachments/document.ts 的 ResourceScope.own() 把创建与撤销绑在一起，
  //    抽屉的每次尝试都以 scope.dispose() 收尾。散落的 createObjectURL 会留下
  //    无人撤销的 blob URL（媒体面尤其危险：一个 URL 就是一份常驻内存）。
  //    两个历史下载路径（SettingsModal 的演示图片、attachmentZip 的一次性下载）
  //    是单次同步使用、立即 revoke 的旧代码，不在本规则收紧范围内。
  // ② 解码/渲染层不得直接依赖解码库、node 内建或测试夹具：pdfjs-dist 只许
  //    decode/pdf.ts 静态导入（其它模块经 decode/pdf 的再导出拿 AnnotationMode，
  //    见 E4），jszip 属于 S3 的 decode/office 专属，render 层碰它就是把解析
  //    搬回视图。flat config 里同一条规则的 patterns 是**整条覆盖**，所以下面
  //    每个对象都重新展开 legacyLayerImportBans，否则 G15 会被静默顶掉。
  // ---------------------------------------------------------------------------
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/attachments/document.ts", "apps/web/src/SettingsModal.tsx", "apps/web/src/attachmentZip.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='URL'][callee.property.name='createObjectURL']",
          message: "URL.createObjectURL 只能经 attachments/document.ts 的 ResourceScope.own() 创建（随 scope.dispose() 撤销）；请把 blob 交给 ResourceScope。",
        },
      ],
    },
  },
  {
    files: ["apps/web/src/attachments/{decode,render,zip}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...legacyLayerImportBans,
            { group: ["jszip"], message: "jszip 只允许在 decode/office（S3 的归档/Office 解析）里使用；render 层不得自己解压。" },
            { group: ["pdfjs-dist"], message: "pdfjs-dist 只允许 decode/pdf.ts 静态导入；其它模块请从 ../decode/pdf 再导出取值（如 AnnotationMode）。" },
            { group: ["node:*"], message: "附件解码/渲染代码运行在浏览器 renderer 里，不得依赖 node 内建模块。" },
            { group: ["**/test-*"], message: "生产代码不得导入测试夹具；与测试共享的数据请放在 attachments/testing/ 的显式导出里。" },
          ],
        },
      ],
    },
  },
  {
    // decode/pdf.ts 是 pdfjs-dist 的唯一静态导入点（类型与 AnnotationMode 再导出）。
    files: ["apps/web/src/attachments/decode/pdf.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...legacyLayerImportBans,
            { group: ["jszip"], message: "jszip 只允许在 decode/office（S3 的归档/Office 解析）里使用；pdf 解码不得自己解压。" },
            { group: ["node:*"], message: "附件解码/渲染代码运行在浏览器 renderer 里，不得依赖 node 内建模块。" },
            { group: ["**/test-*"], message: "生产代码不得导入测试夹具；与测试共享的数据请放在 attachments/testing/ 的显式导出里。" },
          ],
        },
      ],
    },
  },

  // 巨型文件冻结：只允许瘦身，不允许继续增长。
  // 阈值 = **实测行数**（第 6 批·棘轮收口时逐条量取），与上方 monolithRatchets 同一
  // 政策、同一原因——见那段注释。App.tsx 的 3117 停在批次 4 抽取之前；前端 store
  // （mailStore.ts）接手列表/计数/本地覆盖，SSE 后果与进度横幅各自抽成 hook 之后，
  // 该文件降到 2910 行，上限同步降到实测值，不再留"下次可以悄悄长回去"的空地。
  // 需要 +1 行时的答案与别处一样：先删一行或拆文件，不要抬上限。
  {
    files: ["apps/web/src/App.tsx"],
    rules: { "max-lines": ["error", { max: 2910, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/server/src/agent-service.ts"],
    rules: { "max-lines": ["error", { max: 1308, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/desktop/src/main.mts"],
    rules: { "max-lines": ["error", { max: 2129, skipBlankLines: false, skipComments: false }] },
  },
  {
    // 反思轮发现：把代码搬进未冻结的文件即可绕过上述棘轮（App.tsx 的反弹路径）。
    // 补齐剩余巨型 TS 文件。styles.css 无法由 eslint 解析，其棘轮见
    // apps/web/src/styles-size.test.ts（与 designTokens.test.ts 同一读取模式）。
    files: ["apps/web/src/AgentWorkspace.tsx"],
    rules: { "max-lines": ["error", { max: 2448, skipBlankLines: false, skipComments: false }] },
  },

  ...monolithRatchetConfigs,
);
