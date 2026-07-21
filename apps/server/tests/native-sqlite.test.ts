import { describe, expect, it } from "vitest";
import { resolveSqliteModuleRequest } from "../src/native-sqlite.js";

describe("Node SQLite runtime selection", () => {
  it("uses the standard resolver when the explicit Node launcher marker is absent", () => {
    expect(resolveSqliteModuleRequest({ NAMI_MAIL_NODE_SQLITE_MODULE: "C:\\cache\\better-sqlite3" }, "148")).toBe("better-sqlite3");
  });

  it("uses the launcher-provided cache only when its ABI matches", () => {
    expect(resolveSqliteModuleRequest({
      NAMI_MAIL_NODE_SQLITE_RUNTIME: "1",
      NAMI_MAIL_NODE_SQLITE_ABI: "141",
      NAMI_MAIL_NODE_SQLITE_MODULE: "C:\\cache\\better-sqlite3",
    }, "141")).toBe("C:\\cache\\better-sqlite3");
  });

  it("rejects a stale Node cache instead of falling through to Electron's binary", () => {
    expect(() => resolveSqliteModuleRequest({
      NAMI_MAIL_NODE_SQLITE_RUNTIME: "1",
      NAMI_MAIL_NODE_SQLITE_ABI: "141",
      NAMI_MAIL_NODE_SQLITE_MODULE: "C:\\cache\\better-sqlite3",
    }, "148")).toThrow(/targets ABI 141/i);
  });

  it("rejects an incomplete launcher contract", () => {
    expect(() => resolveSqliteModuleRequest({ NAMI_MAIL_NODE_SQLITE_RUNTIME: "1" }, "141")).toThrow(/launcher is incomplete/i);
  });
});
