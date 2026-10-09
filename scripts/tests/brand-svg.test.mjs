import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { traceMaskToPath } from "../brand-svg.mjs";

async function renderMask(mask, width, height) {
  const path = traceMaskToPath(mask, width, height, { tolerance: 0, minArea: 0 });
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${path}" fill="white" fill-rule="evenodd"/></svg>`))
    .ensureAlpha().extractChannel("alpha").raw().toBuffer();
}

test("tracing keeps letter counters transparent", async () => {
  const width = 11;
  const mask = Buffer.alloc(width * width);
  for (let y = 1; y < 10; y++) {
    for (let x = 1; x < 10; x++) {
      if (x < 3 || x > 7 || y < 3 || y > 7) mask[y * width + x] = 255;
    }
  }
  const rendered = await renderMask(mask, width, width);
  assert.equal(rendered[5 * width + 5], 0, "The middle of the counter must remain empty.");
  assert.equal(rendered[5 * width + 1], 255, "The outside stroke must remain solid.");
  assert.equal(rendered[0], 0, "No background panel may appear.");
});

test("diagonal contacts keep separate contours and do not bridge empty pixels", async () => {
  const rendered = await renderMask(Buffer.from([255, 0, 0, 255]), 2, 2);
  assert.ok(rendered[0] > 200 && rendered[3] > 200);
  assert.equal(rendered[1], 0);
  assert.equal(rendered[2], 0);
  assert.equal(traceMaskToPath(Buffer.alloc(4), 2, 2), "");
});

test("the generated SVG reproduces the application mark and uses real vector geometry", async () => {
  const svg = await readFile(new URL("../../build/icon.svg", import.meta.url), "utf8");
  const wordmark = await readFile(new URL("../../docs/nami-mail-wordmark.svg", import.meta.url), "utf8");
  const favicon = await readFile(new URL("../../apps/web/public/favicon.svg", import.meta.url), "utf8");
  assert.equal(favicon, svg, "The client and public site must use the same icon.");
  for (const content of [svg, wordmark]) {
    assert.doesNotMatch(content, /<image\b|<text\b|data:image|<script\b|https?:\/\/(?!www\.w3\.org)/);
    assert.match(content, /<path\b/);
  }
  const [actual, reference] = await Promise.all([
    // Compare native application geometry, avoiding separate downsampling
    // kernels for the SVG and PNG at small favicon sizes.
    sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer(),
    sharp(fileURLToPath(new URL("../../build/icon.png", import.meta.url))).ensureAlpha().raw().toBuffer(),
  ]);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < actual.length; i += 4) {
    const a = actual[i] > 128 && actual[i + 3] > 128;
    const b = reference[i] > 128 && reference[i + 3] > 128;
    intersection += Number(a && b);
    union += Number(a || b);
  }
  assert.ok(intersection / union > 0.975, `The brand outline changed: intersection / union = ${intersection / union}.`);
});
