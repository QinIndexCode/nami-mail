import assert from "node:assert/strict";

export function assertDesktopRendererAddress(url) {
  const port = Number.parseInt(url.port, 10);
  assert.equal(url.hostname, "127.0.0.1", "The desktop service must remain loopback-only.");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "The desktop service must use an allocated loopback port.");
  return port;
}
