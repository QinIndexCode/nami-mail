import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDatabaseConstructor, resolveSqliteModuleRequest } from "../src/native-sqlite.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..", "..");
const runtimeTsconfig = path.join(serverRoot, "tsconfig.runtime.json");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

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

/**
 * The loader that starts the dev server is not the loader that runs this test:
 * tsx applies tsconfig `paths` to runtime resolution, so the `paths` alias that
 * exists only to make the driver's declarations visible to `tsc` decided what
 * the driver import loaded, and the API dev process died with
 * `ReferenceError: Database is not defined` before it could listen. Every gate
 * in this repo ran under a loader that does not honour `paths`, so nothing here
 * would have noticed. These cases run the real seam under the real loader.
 */
describe("SQLite driver under the dev server's loader", () => {
  it("loads the driver when tsx resolves through the dev runtime config", () => {
    expect(fs.existsSync(tsxCli), `tsx is missing: ${tsxCli}`).toBe(true);
    expect(fs.existsSync(runtimeTsconfig), `the dev runtime tsconfig is missing: ${runtimeTsconfig}`).toBe(true);

    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'const seam = await import("./src/native-sqlite.ts");'
          + 'const driver = seam.loadDatabaseConstructor();'
          + 'if (typeof driver !== "function") { console.error("the driver is not a constructor"); process.exit(3); }',
      ],
      {
        cwd: serverRoot,
        env: { ...env, TSX_TSCONFIG_PATH: runtimeTsconfig },
        encoding: "utf8",
        windowsHide: true,
      },
    );

    // The failure this pins reports itself as a ReferenceError thrown while
    // loading the driver, so the stderr is worth keeping in the assertion.
    expect(probe.stderr.trim()).toBe("");
    expect(probe.status).toBe(0);
  });

  it("keeps the dev launcher pointed at that config", () => {
    // The launcher is an entry script — running it here would start the server —
    // so the wiring is read rather than executed. Dropping the flag puts the dev
    // server back on tsconfig.json and back on the crash above.
    const launcher = fs.readFileSync(path.join(repoRoot, "scripts", "run-server-node.mjs"), "utf8");
    expect(launcher).toContain('"--tsconfig", tsxRuntimeTsconfig');
    expect(launcher).toContain('"tsconfig.runtime.json"');
  });
});
