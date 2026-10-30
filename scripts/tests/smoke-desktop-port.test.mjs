import assert from "node:assert/strict";
import test from "node:test";
import { assertDesktopRendererAddress } from "../smoke-desktop-port.mjs";

test("accepts OS-assigned loopback ports outside the Windows default range", () => {
  for (const port of [3934, 46270, 49152, 65535]) {
    assert.equal(assertDesktopRendererAddress(new URL(`http://127.0.0.1:${port}/`)), port);
  }
});

test("rejects non-loopback hosts and unallocated ports", () => {
  assert.throws(() => assertDesktopRendererAddress(new URL("http://localhost:3934/")), /loopback-only/);
  assert.throws(() => assertDesktopRendererAddress(new URL("http://127.0.0.1:0/")), /allocated loopback port/);
  assert.throws(() => assertDesktopRendererAddress(new URL("http://127.0.0.1/")), /allocated loopback port/);
});
