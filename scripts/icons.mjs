// Generates every app icon from build/icon.svg:
//   build/icon.png (1024), build/icon.icns (macOS), build/icon.ico (Windows),
//   build/icons/<size>x<size>.png (Linux), public/favicon.svg (browser mode).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('build/icon.svg');
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

const cache = new Map();
const png = (size) => {
  if (!cache.has(size)) cache.set(size, render(size));
  return cache.get(size);
};

// Master PNG + Linux set
writeFileSync('build/icon.png', png(1024));
mkdirSync('build/icons', { recursive: true });
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(`build/icons/${size}x${size}.png`, png(size));
}

// Windows .ico with PNG-compressed entries
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const images = icoSizes.map(png);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, i) => {
  const size = icoSizes[i];
  const e = 6 + i * 16;
  header.writeUInt8(size >= 256 ? 0 : size, e); // width (0 = 256)
  header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
  header.writeUInt8(0, e + 2); // palette colors
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // color planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(img.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync('build/icon.ico', Buffer.concat([header, ...images]));

// macOS .icns via iconutil
if (process.platform === 'darwin') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-icon-'));
  const iconset = path.join(dir, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png(size));
    writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns']);
  rmSync(dir, { recursive: true, force: true });
} else {
  console.warn('Skipping build/icon.icns (iconutil is only available on macOS); electron-builder will derive it from icon.png.');
}

mkdirSync('public', { recursive: true });
copyFileSync('build/icon.svg', 'public/favicon.svg');
console.log('Icons written to build/ and public/favicon.svg');
