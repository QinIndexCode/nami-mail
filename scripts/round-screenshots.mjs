import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  "docs/nami-mail-inbox-zh.png",
  "docs/nami-mail-inbox-en.png",
  "docs/nami-mail-agent-zh.png",
  "docs/nami-mail-agent-en.png",
];

const siteTargets = [
  "site/assets/nami-mail-inbox-zh.png",
  "site/assets/nami-mail-inbox-en.png",
  "site/assets/nami-mail-agent-zh.png",
  "site/assets/nami-mail-agent-en.png",
];

/**
 * Applies clean antialiased rounded corners (alpha mask) to a captured screenshot,
 * eliminating any dark corner artifacts outside the simulated window frame radius.
 */
export async function roundScreenshotFile(filePath, radius = 20) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const buffer = await fs.readFile(absolutePath);
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error(`Failed to read image dimensions for ${filePath}`);
  }

  const maskSvg = Buffer.from(
    `<svg width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#ffffff"/></svg>`,
  );

  const maskBuffer = await sharp(maskSvg).png().toBuffer();

  const roundedBuffer = await sharp(buffer)
    .ensureAlpha()
    .composite([{ input: maskBuffer, blend: "dest-in" }])
    .png()
    .toBuffer();

  await fs.writeFile(absolutePath, roundedBuffer);
  return roundedBuffer;
}

export async function processAllScreenshots(radius = 20) {
  for (let i = 0; i < targets.length; i++) {
    const docTarget = targets[i];
    const siteTarget = siteTargets[i];
    console.log(`Processing rounded corners (radius=${radius}px): ${docTarget}`);
    const roundedBuffer = await roundScreenshotFile(docTarget, radius);

    const siteAbsolutePath = path.join(projectRoot, siteTarget);
    await fs.mkdir(path.dirname(siteAbsolutePath), { recursive: true });
    await fs.writeFile(siteAbsolutePath, roundedBuffer);
    console.log(`Synced to: ${siteTarget}`);
  }
}

// When invoked directly from the CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  processAllScreenshots(20)
    .then(() => {
      console.log("All screenshot rounded corners successfully processed.");
    })
    .catch((err) => {
      console.error("Failed to process screenshot corners:", err);
      process.exit(1);
    });
}
