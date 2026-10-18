import { describe, expect, it } from "vitest";
import { loadDatabaseConstructor, resolveSqliteModuleRequest } from "../src/native-sqlite.js";

describe("SQLite runtime selection", () => {
  it("uses the standard resolver for the shared N-API cipher module", () => {
    // Named deliberately: this is the seam that decides whether the store is
    // encrypted at rest, so a silent revert to plaintext better-sqlite3 has to
    // fail here rather than ship.
    expect(resolveSqliteModuleRequest()).toBe("better-sqlite3-multiple-ciphers");
  });

  it("loads the resolved module as a database constructor", () => {
    expect(typeof loadDatabaseConstructor()).toBe("function");
  });
});
