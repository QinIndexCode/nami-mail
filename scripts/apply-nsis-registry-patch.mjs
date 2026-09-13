// Applies a durable fix to electron-builder's shared NSIS uninstaller template.
//
// Why: electron-builder's generated uninstaller runs a `Section "un.…"` whose
// tail unconditionally DeleteRegKeys both the uninstall entry and the
// InstallLocation-bearing key. When the old uninstaller is invoked during an
// in-place upgrade (--updated) the InstallLocation is therefore wiped before
// the new installer re-writes it; if the upgrade aborts in between, the next
// install reads an empty InstallLocation and silently falls back to the per-user
// default directory (C:\Users\<user>\AppData\Local\Programs\Nami Mail), which is
// exactly the "install path resets to C:" regression we observed.
//
// The fix gates those DeleteRegKey calls on `not isUpdated`, so an interrupted
// in-place upgrade keeps the previous InstallLocation (and shortcut config).
// A real uninstall still removes every key.
//
// electron-builder reads this template from node_modules at build time and has
// no project-level override for uninstaller.nsh, so the change must be re-applied
// whenever node_modules is reinstalled. hooking this script into `postinstall`
// keeps the patch in place across fresh installs. The patch is idempotent.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(
  projectRoot,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "uninstaller.nsh",
);

// Sentinel that marks the guarded block as already applied.
const SENTINEL = "Nami Mail patch: during an in-place update";

const ORIGINAL = [
  '  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"',
  '  !ifdef UNINSTALL_REGISTRY_KEY_2',
  '    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"',
  '  !endif',
  '  DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"',
].join("\n");

const PATCHED = `; ${SENTINEL} the old uninstaller is invoked
  ; with --updated. Deleting these keys there would wipe InstallLocation before
  ; the new installer re-writes it; if the upgrade aborts in between, the next
  ; run reads an empty InstallLocation and silently falls back to the per-user
  ; default directory. Keep both keys on the --updated path so the install
  ; directory (and shortcut config) survives an interrupted upgrade. A real
  ; uninstall still removes all of them.
  \${ifNot} \${isUpdated}
    DeleteRegKey SHELL_CONTEXT "\${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "\${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    DeleteRegKey SHELL_CONTEXT "\${INSTALL_REGISTRY_KEY}"
  \${endIf}`;

try {
  let source = await fs.readFile(templatePath, "utf8");

  if (source.includes(SENTINEL)) {
    console.log("nesi-patch: already applied, skipping");
  } else if (!source.includes(ORIGINAL)) {
    console.error(
      "nesi-patch: template changed upstream; expected block not found. Manual review of app-builder-lib upgrade needed.",
    );
    process.exit(1);
  } else {
    source = source.replace(ORIGINAL, PATCHED);
    await fs.writeFile(templatePath, source, "utf8");
    if (!source.includes(SENTINEL)) {
      throw new Error("Patch write succeeded but sentinel is missing after write.");
    }
    console.log("nesi-patch: applied isUpdated guard to uninstaller.nsh registry cleanup");
  }
} catch (error) {
  console.error(`nesi-patch: failed to patch ${templatePath}`, error);
  process.exit(1);
}