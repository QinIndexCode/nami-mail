/**
 * 批次 1 闸门 · Provider 接缝的**静态**边界（架构契约 §5 分层规则）。
 *
 * `provider-seam.test.ts` 证明注入生效；本文件证明接缝**不会被绕过**——
 * 也就是"网络构造只发生在 `provider/`"这条规则在源码层面成立，而不是靠约定。
 *
 * 它防的是四类具体事故：
 *   ① 有人又写一个 `new ImapFlow(...)`（新代码绕开接缝，测试再也 fake 不到它）；
 *   ② `src/providers/` 目录与 `providers.ts` 同名共存——NodeNext 下文件胜出，
 *      目录里的代码会被静默忽略，是极难查的一类 bug；
 *   ③ 传输姿态（STARTTLS 强制、证书校验、三档超时）出现第二份拷贝，
 *      于是"某一处被悄悄放松"；
 *   ④ `provider/` 反向依赖上层（tasks/routes/mail），接缝退化成环。
 *
 * 只读源码文本，不执行任何东西；`.mimosa` 等点目录被跳过。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(serverRoot, "src");

type SourceFile = { rel: string; text: string };

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dot-directories hold tool state (the Mimosa hook keeps source baselines
    // under `src/.mimosa/`), not product code.
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

const sources: SourceFile[] = walk(srcRoot).map((path) => ({
  rel: relative(srcRoot, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

function sourceOf(rel: string): SourceFile {
  const file = sources.find((candidate) => candidate.rel === rel);
  if (!file) throw new Error(`expected source file missing: src/${rel}`);
  return file;
}

type ModuleReference = { specifier: string; typeOnly: boolean };

const FROM_SPECIFIER = /\bfrom\s+["']([^"']+)["']/;

/**
 * Every module `text` pulls in, by import or re-export. Statements can span
 * lines (`import {\n  a,\n} from "x"`), so lines accumulate until the one
 * carrying `from "..."`; a statement that ends without one (an `export
 * function`) is dropped instead of swallowing whatever follows.
 */
function moduleReferences(text: string): ModuleReference[] {
  const found: ModuleReference[] = [];
  let pending: string[] | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^(?:import|export)\b/.test(line)) pending = [line];
    else if (pending) pending.push(line);
    if (!pending) continue;
    const statement = pending.join(" ");
    const specifier = statement.match(FROM_SPECIFIER)?.[1];
    if (specifier) {
      found.push({ specifier, typeOnly: /^import\s+type\b/.test(statement) });
      pending = undefined;
    } else if (statement.includes(";")) {
      pending = undefined;
    }
  }
  return found;
}

function referencesTo(pkg: string, typeOnly?: boolean): string[] {
  return sources
    .filter((file) => moduleReferences(file.text).some((reference) =>
      reference.specifier === pkg && (typeOnly === undefined || reference.typeOnly === typeOnly)))
    .map((file) => file.rel)
    .sort();
}

function filesMatching(pattern: RegExp): string[] {
  return sources.filter((file) => pattern.test(file.text)).map((file) => file.rel).sort();
}

describe("① 接缝目录本身", () => {
  it("src/provider/ 存在，且没有同名的 src/providers/ 目录来抢模块解析", () => {
    const names = new Set(readdirSync(srcRoot, { withFileTypes: true }).map((entry) => entry.name));
    expect(names.has("provider")).toBe(true);
    // `providers.ts` (presets/autoconfig) already owns the name `providers`:
    // a sibling `providers/` directory would be silently shadowed by the file
    // under NodeNext, so the seam deliberately lives in `provider/`.
    expect(names.has("providers")).toBe(false);
  });

  it("provider/ 是叶子：非相对引用只有它包装的那两个库", () => {
    const providerFiles = sources.filter((file) => file.rel.startsWith("provider/"));
    expect(providerFiles.length).toBeGreaterThan(0);

    const external = new Set<string>();
    for (const file of providerFiles) {
      for (const reference of moduleReferences(file.text)) {
        if (!reference.specifier.startsWith(".")) external.add(reference.specifier);
      }
    }
    // Anything else here means the seam grew a dependency on a layer above it.
    expect([...external].sort()).toEqual(["imapflow", "nodemailer"]);
  });
});

describe("② 网络构造只发生在 provider/", () => {
  it("new ImapFlow 全仓只有一处，就在 provider/imap.ts", () => {
    expect(filesMatching(/new\s+ImapFlow\s*\(/)).toEqual(["provider/imap.ts"]);
  });

  it("nodemailer 的值引用只有接缝与草稿序列化两处，且后者的传输是 streamTransport", () => {
    expect(referencesTo("nodemailer", false)).toEqual(["drafts.ts", "provider/smtp.ts"]);
    // `drafts.ts` serializes MIME to a buffer and opens no socket, so it is
    // deliberately outside the seam; it must stay a stream transport.
    expect(sourceOf("drafts.ts").text).toMatch(/nodemailer\.createTransport\(\{\s*streamTransport:\s*true,/);
  });

  it("imapflow 的值引用只有接缝一处（其余是类型引用，编译期擦除）", () => {
    expect(referencesTo("imapflow", false)).toEqual(["provider/imap.ts"]);
    // The type-only ones are real and expected: batch 1 keeps `ImapSession` as
    // an exact alias so `mail.ts`'s public return type — and the 29 test files
    // that mock it — stay untouched. Narrowing is deferred to batch 2/5.
    expect(referencesTo("imapflow", true)).toEqual([
      "attachments.ts",
      "idle.ts",
      "provider/types.ts",
      "sync-sent-verify.ts",
      "sync.ts",
    ]);
  });

  it("mail.ts 不再直接依赖这两个库", () => {
    const references = moduleReferences(sourceOf("mail.ts").text).map((reference) => reference.specifier);
    expect(references).not.toContain("imapflow");
    expect(references).not.toContain("nodemailer");
    expect(references).toContain("./provider/index.js");
  });
});

describe("③ 传输姿态只有一份", () => {
  it("STARTTLS 强制、证书校验与三档超时只出现在 provider/", () => {
    const posture = /doSTARTTLS|requireTLS|rejectUnauthorized|connectionTimeout|greetingTimeout/;
    const holders = filesMatching(posture);
    // Not vacuous: the posture has to exist somewhere.
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.every((rel) => rel.startsWith("provider/"))).toBe(true);
  });
});
