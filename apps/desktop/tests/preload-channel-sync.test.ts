import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractChannelLiteral(source: string, variableName: string): string {
  const match = source.match(new RegExp(`const ${variableName}\\s*=\\s*"([^"]+)"`));
  assert.ok(match, `Expected a const ${variableName} declaration in the desktop source.`);
  return match![1];
}

test("the sandboxed preload and the agent module agree on the confirmation IPC channel", async () => {
  const [preloadSource, agentSource] = await Promise.all([
    readFile(path.join(desktopRoot, "src", "preload.cts"), "utf8"),
    readFile(path.join(desktopRoot, "src", "agent", "confirmation-channel.cts"), "utf8"),
  ]);
  assert.equal(
    extractChannelLiteral(preloadSource, "agentConfirmationIpcChannel"),
    extractChannelLiteral(agentSource, "agentConfirmationIpcChannel"),
    "The preload declares its channel locally (a sandboxed preload cannot require sibling modules), "
    + "so it must stay in sync with agent/confirmation-channel.cts.",
  );
});