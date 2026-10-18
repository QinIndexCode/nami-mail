/**
 * G15 的见证：legacy 写入层真的没了，而且回不来（契约 §8 G15 / §7 第 4 件）。
 *
 * 删除这件事**本身没有任何自动检查会看**：没人 import 一个已删文件，测试也不会
 * 因为文件不存在而变红——引用它们的三个测试文件同批删掉了，否则它们会红，这也正是
 * 它们必须同批消失的原因（见证对象失效必须与代码删除同批，契约 §9 末段）。所以
 * 删除需要一份自己的见证，逐条把"没了"变成可执行的断言：
 *
 *   1. 三个模块文件不存在；
 *   2. 除 `tasks/schema.ts` 与 `tasks/migrate.ts` 外，`src/**` 里没有任何**代码**
 *      提到那三张表（先剥注释——"注释提及不算"是 G15 的原话，技法同
 *      `task-claim-gate.test.ts`）；
 *   3. 没有任何文件 import 它们，而保留的兼容别名路由必须继续合法；
 *   4. 新库 DDL 不再声明那三张表，但 `TASK_LEGACY_TABLE_DROPS` 仍列着它们（4b 的
 *      迁移要在读完之后才 DROP，这是它唯一还需要这几张表名字的地方）；
 *   5. eslint 真的声明了 G15 规则——规则写在 config 里，config 被删掉时 eslint 只是
 *      变得**更宽松**，不会红，所以"禁止 import"这件事也需要一条会红的断言。
 *
 * 每条都是"全量扫描 + 空命中"，不是抽样：抽取一个代表性文件，在删除面这种"少一个
 * 就静默"的场景里恰好是最没用的形状。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_LEGACY_TABLE_DROPS } from "../src/tasks/schema.js";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const srcRoot = path.join(serverRoot, "src");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const DELETED_MODULES = ["src/operation-queue.ts", "src/batch-jobs.ts", "src/batch-job-schema.ts"] as const;
const LEGACY_TABLES = ["operation_queue", "batch_jobs", "batch_job_messages"] as const;

/**
 * Every `.ts` file under a directory, recursively.
 *
 * `.ts` only, deliberately: `src/.mimosa/hook-state/**` holds the security hook's
 * own `*.source` baselines, which are snapshots of files as they were *before* this
 * batch and would otherwise make this scan fail on code that no longer exists.
 */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** The file's code with TS comments stripped: a comment naming a table is not a use. */
function codeOf(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const relativeToServer = (file: string): string => path.relative(serverRoot, file).split(path.sep).join("/");

describe("G15 · legacy 写入层已删除，且没有回来的路", () => {
  it("三个模块文件不存在", () => {
    for (const modulePath of DELETED_MODULES) {
      expect(fs.existsSync(path.join(serverRoot, modulePath)), modulePath).toBe(false);
    }
  });

  it("除 tasks/{schema,migrate}.ts 外，没有 src 代码提到那三张表", () => {
    // The two exemptions are the ones that legitimately still name them, and each
    // for a reason that outlives the deletion:
    //   * `tasks/schema.ts` owns `TASK_LEGACY_TABLE_DROPS` -- the DROP list the 4b
    //     migration executes, which is also why the DROP could not move into the
    //     opening schema (see the test below).
    //   * `tasks/migrate.ts` is the backfill: it SELECTs the three tables by name
    //     and owns `LEGACY_QUEUE_KINDS`.
    const exempt = new Set(["src/tasks/schema.ts", "src/tasks/migrate.ts"]);
    const offenders = sourceFiles(srcRoot)
      .filter((file) => !exempt.has(relativeToServer(file)))
      .filter((file) => {
        const code = codeOf(file);
        return LEGACY_TABLES.some((table) => code.includes(table));
      })
      .map(relativeToServer);
    expect(offenders).toEqual([]);
  });

  it("没有任何 src 文件 import 那三个模块，而兼容别名路由仍是合法导入", () => {
    const deleted = new Set(DELETED_MODULES.map((modulePath) => path.join(serverRoot, modulePath)));
    // Every static and dynamic import spelling, resolved against the importing
    // file's own directory. Resolving rather than pattern-matching the specifier is
    // what keeps the retained alias legal: `./routes/batch-jobs.js` from `app.ts`
    // lands on `src/routes/batch-jobs.ts`, which is not one of the deleted paths,
    // while `./batch-jobs.js` from a file inside `routes/` lands on the sibling
    // route and is equally legal -- a substring rule could not tell the two apart.
    const importSpecifier = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      for (const match of codeOf(file).matchAll(importSpecifier)) {
        const specifier = match[1]!;
        const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
        if (deleted.has(target)) offenders.push(`${relativeToServer(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("新库 DDL 不再声明那三张表，而 DROP 清单仍列着它们", () => {
    const schemaSource = fs.readFileSync(path.join(srcRoot, "db-schema.ts"), "utf8");
    const start = schemaSource.indexOf("export const NAMI_MAIL_SCHEMA_SQL = `");
    expect(start).toBeGreaterThan(-1);
    const end = schemaSource.indexOf("\n`;", start);
    expect(end).toBeGreaterThan(start);
    const sql = schemaSource.slice(start, end);
    for (const table of LEGACY_TABLES) {
      expect(sql, table).not.toContain(table);
    }

    // The DROP list is the one place these names must survive: the migration reads
    // the three tables, so the drop has to run inside that migration, after the
    // backfill, in the same transaction -- never in the DDL that runs on every open
    // before it (`db.test.ts` pins the fresh-database half of the same fact).
    expect(TASK_LEGACY_TABLE_DROPS.join("; ")).toContain("DROP TABLE IF EXISTS operation_queue");
    expect(TASK_LEGACY_TABLE_DROPS.join("; ")).toContain("DROP TABLE IF EXISTS batch_jobs");
    expect(TASK_LEGACY_TABLE_DROPS.join("; ")).toContain("DROP TABLE IF EXISTS batch_job_messages");
    // The delivery ledger is NOT in the list: it is the 90-day record a task's
    // `submission_id` references (contract §3.4 D1 v2), not a task store.
    expect(TASK_LEGACY_TABLE_DROPS.join("; ")).not.toContain("outbound_submissions");
  });

  it("eslint 声明了 G15 规则，且没有把 batch-jobs 写成 glob", () => {
    const config = fs.readFileSync(path.join(repoRoot, "eslint.config.mjs"), "utf8");
    expect(config).toContain("legacyLayerImportBans");
    expect(config).toContain('"**/operation-queue.js"');
    expect(config).toContain('"**/batch-job-schema.js"');
    // A `**/batch-jobs.js` glob would also block `app.ts`'s `./routes/batch-jobs.js`
    // -- the retained compatibility alias -- so that name is enumerated instead.
    expect(config).not.toContain('"**/batch-jobs.js"');
    // And the relative spellings that enumeration has to cover, since they are the
    // only spellings this repo uses.
    expect(config).toContain('"./batch-jobs.js"');
    expect(config).toContain('"../../batch-jobs.js"');
  });
});
