import sharp from "sharp";

// Verify source file
const srcMeta = await sharp("build/brand/NamiMail Agent logo.png").metadata();
console.log("Source:", srcMeta.width, "x", srcMeta.height);

// Check generated files
for (const name of ["nami-logo-light.png", "nami-logo-dark.png"]) {
  const meta = await sharp(`apps/web/public/${name}`).metadata();
  console.log(`${name}: ${meta.width}x${meta.height}, hasAlpha: ${meta.hasAlpha}`);
  
  // Sample some non-transparent pixels
  const { data, info } = await sharp(`apps/web/public/${name}`).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length && count < 5; i += 4) {
    if (data[i + 3] > 200) {
      console.log(`  pixel: rgba(${data[i]},${data[i+1]},${data[i+2]},${data[i+3]})`);
      count++;
    }
  }
}

// Also check the source file's logo pixels
console.log("\nSource file logo pixels (bright):");
const { data: srcData, info: srcInfo } = await sharp("build/brand/NamiMail Agent logo.png").raw().toBuffer({ resolveWithObject: true });
let srcCount = 0;
for (let i = 0; i < srcData.length && srcCount < 5; i += 4) {
  const lum = srcData[i] * 0.299 + srcData[i+1] * 0.587 + srcData[i+2] * 0.114;
  if (lum > 200) {
    console.log(`  pixel: rgba(${srcData[i]},${srcData[i+1]},${srcData[i+2]},${srcData[i+3]})`);
    srcCount++;
  }
}
