const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const rootDir = process.argv[2] || '.';
const outFile = process.argv[3] || 'export.zip';

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.turbo', 'exports', '.cache', '.local',
]);
const EXCLUDE_FILE_SUFFIXES = ['.tsbuildinfo'];

function shouldSkipDir(name) {
  return EXCLUDE_DIRS.has(name);
}

function shouldSkipFile(name) {
  return EXCLUDE_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function walk(dir, base, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(full, rel, files);
    } else if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) continue;
      files.push({ full, rel });
    }
  }
}

const files = [];
walk(rootDir, '', files);

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dateVal = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

const localChunks = [];
const centralChunks = [];
let offset = 0;
const now = new Date();
const { time, dateVal } = dosDateTime(now);

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const crc = crc32(data);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const useStore = compressed.length >= data.length;
  const method = useStore ? 0 : 8;
  const payload = useStore ? data : compressed;
  const nameBuf = Buffer.from(f.rel.split(path.sep).join('/'), 'utf8');

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(time, 10);
  localHeader.writeUInt16LE(dateVal, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  localChunks.push(localHeader, nameBuf, payload);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(time, 12);
  centralHeader.writeUInt16LE(dateVal, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);

  centralChunks.push(centralHeader, nameBuf);

  offset += localHeader.length + nameBuf.length + payload.length;
}

const centralDirOffset = offset;
const centralDirBuf = Buffer.concat(centralChunks);
offset += centralDirBuf.length;

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDirBuf.length, 12);
end.writeUInt32LE(centralDirOffset, 16);
end.writeUInt16LE(0, 20);

const zipBuf = Buffer.concat([...localChunks, centralDirBuf, end]);
fs.writeFileSync(outFile, zipBuf);
console.log(`Wrote ${outFile} with ${files.length} files, ${(zipBuf.length / 1024 / 1024).toFixed(2)} MB`);
