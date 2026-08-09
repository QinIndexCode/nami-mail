import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandSourceDirectory = path.join(projectRoot, "build", "brand");
const webBrandDirectory = path.join(projectRoot, "apps", "web", "public", "brand");
const lightThemeSource = path.join(brandSourceDirectory, "black-theme-source.png");
const darkThemeSource = path.join(brandSourceDirectory, "white-theme-clean-source.png");
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const checkOnly = process.argv.includes("--check");

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function persistOutput(filePath, contents) {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const current = await fs.readFile(filePath).catch(() => undefined);
  if (checkOnly) {
    assert.ok(current, `Missing generated brand asset: ${path.relative(projectRoot, filePath)}`);
    assert.ok(current.equals(next), `Generated brand asset is stale: ${path.relative(projectRoot, filePath)}`);
    return false;
  }
  if (current?.equals(next)) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next);
  return true;
}

async function extractTransparentMark(sourcePath, color, { invert, gain, offset }) {
  const sourceMetadata = await sharp(sourcePath).metadata();
  assert.ok(sourceMetadata.width && sourceMetadata.height, `Invalid brand source: ${sourcePath}`);

  const maskPipeline = sharp(sourcePath).rotate().removeAlpha().toColourspace("srgb").grayscale();
  if (invert) maskPipeline.negate();
  maskPipeline.linear(gain, offset);
  const alphaMask = await maskPipeline.png().toBuffer();

  const transparentMark = await sharp({
    create: {
      width: sourceMetadata.width,
      height: sourceMetadata.height,
      channels: 3,
      background: color,
    },
  })
    .joinChannel(alphaMask)
    .png()
    .toBuffer();

  return sharp(transparentMark)
    .trim({ background: { ...color, alpha: 0 }, threshold: 4 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderMark(mark, size, padding) {
  const innerSize = size - padding * 2;
  const resized = await sharp(mark)
    .resize(innerSize, innerSize, { fit: "inside", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  assert.ok(metadata.width && metadata.height);

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: resized,
      left: Math.round((size - metadata.width) / 2),
      top: Math.round((size - metadata.height) / 2),
    }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderAppIcon(mark, size) {
  const markSize = Math.round(size * (size <= 32 ? 0.74 : 0.68));
  const resizedMark = await sharp(mark)
    .resize(markSize, markSize, { fit: "inside", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const markMetadata = await sharp(resizedMark).metadata();
  assert.ok(markMetadata.width && markMetadata.height);

  const radius = Math.max(3, Math.round(size * 0.22));
  const roundedBackground = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${radius}" fill="#1b1b1f"/></svg>`,
  );

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: roundedBackground, left: 0, top: 0 },
      {
        input: resizedMark,
        left: Math.round((size - markMetadata.width) / 2),
        top: Math.round((size - markMetadata.height) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// NSIS assisted-installer bitmaps. The wizard paints the sidebar on the left
// of the welcome/directory pages and the header strip at the top of every
// page; electron-builder picks these files up by their default names
// (build/installerSidebar.bmp, build/installerHeader.bmp).
// NSIS wizard bitmaps must be uncompressed BMPs. sharp cannot write BMP, so
// encode a 24-bit bottom-up BMP directly from raw RGB (NSIS accepts 24/32-bit).
function encodeBmp24(rgb, width, height) {
  const rowSize = Math.ceil((24 * width) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const out = Buffer.alloc(fileSize);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelDataSize, 34);
  let offset = 54;
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * 3;
    for (let x = 0; x < width; x++) {
      const src = rowStart + x * 3;
      out[offset++] = rgb[src + 2]; // B
      out[offset++] = rgb[src + 1]; // G
      out[offset++] = rgb[src];     // R
    }
    offset += rowSize - width * 3;
  }
  return out;
}

async function renderInstallerSidebar(mark) {
  const width = 164;
  const height = 314;
  const markSize = 52;
  const resizedMark = await sharp(mark)
    .resize(markSize, markSize, { fit: "inside", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const markMetadata = await sharp(resizedMark).metadata();
  assert.ok(markMetadata.width && markMetadata.height);
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1f"/>
      <text x="82" y="226" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="#f5f5f6" text-anchor="middle" letter-spacing="0.5">Nami Mail</text>
      <text x="82" y="245" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="#9898a0" text-anchor="middle">Local-first mail client</text>
    </svg>`,
  );
  const rgb = await sharp({
    create: { width, height, channels: 4, background: { r: 27, g: 27, b: 31, alpha: 1 } },
  })
    .composite([
      { input: overlay, left: 0, top: 0 },
      {
        input: resizedMark,
        left: Math.round((width - markMetadata.width) / 2),
        top: Math.round((height - markMetadata.height) / 2) - 24,
      },
    ])
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  return encodeBmp24(rgb, width, height);
}

async function renderInstallerHeader(mark) {
  const width = 150;
  const height = 57;
  const markSize = 24;
  const resizedMark = await sharp(mark)
    .resize(markSize, markSize, { fit: "inside", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const markMetadata = await sharp(resizedMark).metadata();
  assert.ok(markMetadata.width && markMetadata.height);
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1f"/>
      <text x="42" y="35" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#f5f5f6">Nami Mail</text>
    </svg>`,
  );
  const rgb = await sharp({
    create: { width, height, channels: 4, background: { r: 27, g: 27, b: 31, alpha: 1 } },
  })
    .composite([
      { input: overlay, left: 0, top: 0 },
      {
        input: resizedMark,
        left: 12,
        top: Math.round((height - markMetadata.height) / 2),
      },
    ])
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  return encodeBmp24(rgb, width, height);
}

function encodeIco(frames) {
  const headerSize = 6;
  const directoryEntrySize = 16;
  const header = Buffer.alloc(headerSize + frames.length * directoryEntrySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  let imageOffset = header.length;
  frames.forEach(({ size, png }, index) => {
    const entryOffset = headerSize + index * directoryEntrySize;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

function inspectIco(ico) {
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const entryOffset = 6 + index * 16;
    return {
      width: ico.readUInt8(entryOffset) || 256,
      height: ico.readUInt8(entryOffset + 1) || 256,
      bitDepth: ico.readUInt16LE(entryOffset + 6),
      byteLength: ico.readUInt32LE(entryOffset + 8),
      offset: ico.readUInt32LE(entryOffset + 12),
    };
  });
}

const [lightSourceBuffer, darkSourceBuffer] = await Promise.all([
  fs.readFile(lightThemeSource),
  fs.readFile(darkThemeSource),
]);
const [lightThemeMark, darkThemeMark] = await Promise.all([
  extractTransparentMark(lightThemeSource, { r: 18, g: 18, b: 20 }, { invert: true, gain: 1.5, offset: -18 }),
  extractTransparentMark(darkThemeSource, { r: 250, g: 250, b: 251 }, {
    gain: 3,
    invert: false,
    offset: -500,
  }),
]);
const [lightWebMark, darkWebMark, fullSizeIcon, installerSidebar, installerHeader, uninstallerSidebar] = await Promise.all([
  renderMark(lightThemeMark, 256, 18),
  renderMark(darkThemeMark, 256, 18),
  renderAppIcon(darkThemeMark, 1024),
  renderInstallerSidebar(darkThemeMark),
  renderInstallerHeader(darkThemeMark),
  renderInstallerSidebar(darkThemeMark),
]);
const iconFrames = await Promise.all(iconSizes.map(async (size) => ({
  size,
  png: await renderAppIcon(darkThemeMark, size),
})));
const ico = encodeIco(iconFrames);
const icoEntries = inspectIco(ico);

assert.deepEqual(icoEntries.map(({ width }) => width), iconSizes);
assert.ok(icoEntries.every(({ width, height, bitDepth, byteLength, offset }) => (
  width === height
  && bitDepth === 32
  && byteLength > 0
  && offset + byteLength <= ico.length
)));
for (const [name, image, expectedSize] of [
  ["light theme mark", lightWebMark, 256],
  ["dark theme mark", darkWebMark, 256],
  ["application icon", fullSizeIcon, 1024],
]) {
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, expectedSize, `${name} width`);
  assert.equal(metadata.height, expectedSize, `${name} height`);
  assert.equal(metadata.hasAlpha, true, `${name} alpha channel`);
}

const outputs = [
  [path.join(projectRoot, "build", "icon.png"), fullSizeIcon],
  [path.join(projectRoot, "build", "icon.ico"), ico],
  [path.join(projectRoot, "apps", "web", "public", "favicon.ico"), ico],
  [path.join(webBrandDirectory, "mark-light.png"), lightWebMark],
  [path.join(webBrandDirectory, "mark-dark.png"), darkWebMark],
  [path.join(projectRoot, "build", "installerSidebar.bmp"), installerSidebar],
  [path.join(projectRoot, "build", "installerHeader.bmp"), installerHeader],
  [path.join(projectRoot, "build", "uninstallerSidebar.bmp"), uninstallerSidebar],
];
const changed = [];
for (const [filePath, contents] of outputs) {
  if (await persistOutput(filePath, contents)) changed.push(path.relative(projectRoot, filePath));
}

console.log(JSON.stringify({
  mode: checkOnly ? "check" : "write",
  source: {
    lightTheme: { path: path.relative(projectRoot, lightThemeSource), sha256: sha256(lightSourceBuffer) },
    darkTheme: { path: path.relative(projectRoot, darkThemeSource), sha256: sha256(darkSourceBuffer) },
  },
  icoFrames: icoEntries,
  outputs: outputs.map(([filePath, contents]) => ({
    path: path.relative(projectRoot, filePath),
    sha256: sha256(contents),
  })),
  changed,
}, null, 2));
