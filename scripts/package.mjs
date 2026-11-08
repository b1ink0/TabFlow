import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { publicationFiles } from './public-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const build = join(root, '.output', 'chrome-mv3');
const output = join(root, `TabFlow-${version}.zip`);
execFileSync(process.execPath, [join(root, 'scripts/audit-public.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

const manifestPath = join(build, 'manifest.json');
if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile())
  throw new Error('Run bun run build before packaging.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected a production MV3 build.');
if (manifest.version !== version)
  throw new Error('Build version does not match package.json. Run bun run build before packaging.');

function filesUnder(directory, skip = new Set()) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, skip));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const entries = [];
for (const { path, name } of publicationFiles(root)) {
  entries.push({ path, name: `tabflow/${name}` });
}
for (const path of filesUnder(build)) {
  entries.push({
    path,
    name: `tabflow/ready-to-load/${relative(build, path).split(sep).join('/')}`,
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const localParts = [];
const centralParts = [];
let offset = 0;
const verifiedNames = new Set();
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const data = readFileSync(entry.path);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const { time, date } = dosDateTime(statSync(entry.path).mtime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  const headerLength = local.length + name.length;
  if (!inflateRawSync(compressed).equals(data))
    throw new Error(`ZIP verification failed: ${entry.name}`);
  verifiedNames.add(entry.name);
  offset += headerLength + compressed.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...localParts, centralDirectory, end]);
if (
  !verifiedNames.has('tabflow/ready-to-load/manifest.json') ||
  !verifiedNames.has('tabflow/docs/configuration.md') ||
  !verifiedNames.has('tabflow/docs/images/overview.png')
)
  throw new Error('Package is missing the production extension or public documentation.');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, archive);
console.log(
  `Packaged ${output}: ${archive.length.toLocaleString()} bytes (${entries.length} files)`,
);
