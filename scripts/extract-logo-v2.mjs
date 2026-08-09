import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";

// Extract logo from the NEW source file.
// IMPORTANT: Do NOT crop to logo bbox — the source canvas already encodes the
// intended padding around the logo. Cropping would enlarge the logo and lose
// the whitespace the designer deliberately kept. We only swap the background
// for transparency and resize the full canvas to the output size.

const SRC = "build/brand/NamiMail Agent logo.png";
const OUT_LIGHT = "apps/web/public/nami-logo-light.png"; // dark logo for light UI
const OUT_DARK = "apps/web/public/nami-logo-dark.png";   // light logo for dark UI

if (!existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  process.exit(1);
}

const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const w = info.width;
const h = info.height;
console.log(`Source: ${SRC} ${w}x${h} channels=${info.channels}`);

// The source is bimodal: background lum ~37, logo lum ~252.
// Threshold at 128 to separate them; map luminance above threshold to alpha
// for smooth anti-aliasing along logo edges.
const LOGO_LUM = 252;
const THRESHOLD = 128;

// Target colors (matching existing CSS theme tokens)
const LIGHT_LOGO_RGB = [26, 26, 30];   // #1a1a1e — for light theme (dark logo on transparent)
const DARK_LOGO_RGB = [232, 232, 236]; // #e8e8ec — for dark theme (light logo on transparent)

const lightBuf = Buffer.alloc(data.length);
const darkBuf = Buffer.alloc(data.length);

let logoCount = 0;
for (let i = 0; i < data.length; i += 4) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const lum = r * 0.299 + g * 0.587 + b * 0.114;

  let alpha;
  if (lum <= THRESHOLD) {
    alpha = 0; // background -> fully transparent
  } else {
    alpha = Math.max(0, Math.min(255, Math.round(((lum - THRESHOLD) / (LOGO_LUM - THRESHOLD)) * 255)));
  }

  lightBuf[i] = LIGHT_LOGO_RGB[0];
  lightBuf[i + 1] = LIGHT_LOGO_RGB[1];
  lightBuf[i + 2] = LIGHT_LOGO_RGB[2];
  lightBuf[i + 3] = alpha;

  darkBuf[i] = DARK_LOGO_RGB[0];
  darkBuf[i + 1] = DARK_LOGO_RGB[1];
  darkBuf[i + 2] = DARK_LOGO_RGB[2];
  darkBuf[i + 3] = alpha;

  if (alpha > 16) logoCount++;
}

console.log(`Logo pixels (alpha>16): ${logoCount} (${(logoCount / (w * h) * 100).toFixed(2)}% of canvas)`);

// Ensure output dir exists
mkdirSync("apps/web/public", { recursive: true });

// Resize the FULL canvas (no cropping) to output size.
// Source is already square (2048x2048), so contain fit keeps it 1:1.
const SIZE = 512;

await sharp(lightBuf, { raw: { width: w, height: h, channels: 4 } })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toFile(OUT_LIGHT);

await sharp(darkBuf, { raw: { width: w, height: h, channels: 4 } })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toFile(OUT_DARK);

console.log(`\nGenerated (full canvas preserved, no crop):`);
console.log(`  ${OUT_LIGHT} (dark logo on transparent, for light theme)`);
console.log(`  ${OUT_DARK} (light logo on transparent, for dark theme)`);

// Verify output: logo should occupy the SAME percentage as the source (~17.5%)
console.log(`\n=== Verification ===`);
for (const p of [OUT_LIGHT, OUT_DARK]) {
  const m = await sharp(p).metadata();
  const { data: d } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  let nz = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 16) nz++;
  const pct = (nz / (m.width * m.height) * 100).toFixed(2);
  console.log(`  ${p}: ${m.width}x${m.height} logoPixels=${nz} (${pct}% of canvas)`);
}
console.log(`\nSource logo occupation: 17.52% — output should match this ratio.`);
