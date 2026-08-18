#!/usr/bin/env node
/**
 * Dev-only: keeps the API dev process alive across unexpected exits so the
 * browser's EventSource (/api/events) and the agent engine recover without a
 * manual restart. `npm run dev` pairs this with the web process (no -k, so an
 * environmental kill of one side no longer takes down the other).
 */
import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

while (true) {
  const child = spawn(npmCommand, ["--workspace", "@nami/server", "run", "dev"], {
    stdio: "inherit",
    // Windows cannot spawn .cmd shims directly; shell:true routes via cmd.exe.
    shell: process.platform === "win32",
  });
  const { code, signal } = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  if (code === 0) break; // clean shutdown (e.g. Ctrl+C) — do not restart
  console.error(`[server-watch] API dev exited (${signal ?? `code ${code}`}); restarting in 2s…`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}