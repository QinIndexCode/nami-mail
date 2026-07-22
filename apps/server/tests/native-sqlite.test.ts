import { describe, expect, it } from "vitest";
import { resolveSqliteModuleRequest } from "../src/native-sqlite.js";

describe("SQLite runtime selection", () => {
  it("uses the standard resolver for the shared N-API module", () => {
    expect(resolveSqliteModuleRequest()).toBe("better-sqlite3");
  });
});
