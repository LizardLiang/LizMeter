import { Jimp } from "jimp";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = path.join(root, "assets", "favicon.png");

mkdirSync(path.join(root, "build"), { recursive: true });

// Generate sizes needed for ICO (16, 32, 48, 64, 128, 256)
const icoSizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = [];

for (const size of icoSizes) {
  const img = await Jimp.read(src);
  img.resize({ w: size, h: size });
  const buf = await img.getBuffer("image/png");
  pngBuffers.push(buf);
  console.log(`  ${size}x${size} PNG generated`);
}

// Write 512x512 PNG for runtime window icon
const img512 = await Jimp.read(src);
img512.resize({ w: 512, h: 512 });
const png512 = await img512.getBuffer("image/png");
writeFileSync(path.join(root, "assets", "icon.png"), png512);
console.log("  assets/icon.png (512x512) written");

// Build ICO by embedding PNG data directly (PNG-in-ICO, Windows Vista+)
// This preserves full 32-bit ARGB alpha — unlike legacy BMP-based ICO encoders.
function buildIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * count;
  const dataOffset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: ICO
  header.writeUInt16LE(count, 4); // image count

  const dir = Buffer.alloc(dirSize);
  let offset = dataOffset;
  pngBuffers.forEach((buf, i) => {
    const size = sizes[i];
    const entry = dir.subarray(i * dirEntrySize, (i + 1) * dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1);  // height
    entry.writeUInt8(0, 2);                        // color count
    entry.writeUInt8(0, 3);                        // reserved
    entry.writeUInt16LE(1, 4);                     // planes
    entry.writeUInt16LE(32, 6);                    // bit count
    entry.writeUInt32LE(buf.length, 8);            // data size
    entry.writeUInt32LE(offset, 12);               // data offset
    offset += buf.length;
  });

  return Buffer.concat([header, dir, ...pngBuffers]);
}

const icoBuffer = buildIco(pngBuffers, icoSizes);
writeFileSync(path.join(root, "build", "icon.ico"), icoBuffer);
console.log("  build/icon.ico written");

console.log("\nDone.");