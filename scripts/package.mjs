/**
 * Creates the Partner Center upload package: a .zip with the built extension
 * files at the ARCHIVE ROOT (manifest.json on top level).
 * Dependency-free: minimal stored (uncompressed) ZIP writer.
 *
 * Usage: npm run package   (runs build first)
 * Output: release/edge-proxy-switcher-v<version>.zip
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './validate-release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
validateRelease(dist);

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function collect(dir, base, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) collect(full, rel, out);
    else out.push({ rel, full });
  }
  return out;
}

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run `npm run build` first.');
  process.exit(1);
}

const files = collect(dist, '', []);
const chunks = [];
const central = [];
let offset = 0;

for (const { rel, full } of files) {
  const data = readFileSync(full);
  const name = Buffer.from(rel, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); // local file header
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(0, 8); // method: stored
  head.writeUInt16LE(0, 10); // time
  head.writeUInt16LE(33, 12); // DOS date: 1980-01-01
  head.writeUInt32LE(crc32(data), 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // extra length
  chunks.push(head, name, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); // central directory header
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(33, 14);
  cd.writeUInt32LE(crc32(data), 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  for (let i = 30; i < 42; i++) cd[i] = 0;
  cd.writeUInt32LE(offset, 42);
  central.push(cd, name);
  offset += head.length + name.length + data.length;
}

const cdStart = offset;
const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(cdStart, 16);
end.writeUInt16LE(0, 20);

const version = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).version ?? '0.0.0';
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `edge-proxy-switcher-v${version}.zip`);
writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
console.log(`wrote release/edge-proxy-switcher-v${version}.zip (${files.length} files)`);
