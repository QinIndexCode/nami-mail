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

test("the preload window-control channels match the handlers registered in main.mts", async () => {
  const [preloadSource, mainSource] = await Promise.all([
    readFile(path.join(desktopRoot, "src", "preload.cts"), "utf8"),
    readFile(path.join(desktopRoot, "src", "main.mts"), "utf8"),
  ]);
  const windowControlsMatch = preloadSource.match(/const windowControlChannels = \{([\s\S]*?)\} as const;/);
  assert.ok(windowControlsMatch, "Expected a windowControlChannels declaration in the preload.");
  const declaredChannels = [...windowControlsMatch![1].matchAll(/(\w+): "([^"]+)"/g)].map((match) => match[2]);
  assert.ok(declaredChannels.length >= 5, "Expected the five window-control channels in the preload.");

  const registeredChannels = new Set(
    [
      ...mainSource.matchAll(/ipcMain\.(?:on|handle)\("([^"]+)"/g),
      // Maximize-state changes flow main -> renderer via webContents.send.
      ...mainSource.matchAll(/webContents\.send\("([^"]+)"/g),
    ].map((match) => match[1]),
  );
  for (const channel of declaredChannels) {
    assert.ok(registeredChannels.has(channel), `main.mts never registers the preload channel "${channel}".`);
  }
});