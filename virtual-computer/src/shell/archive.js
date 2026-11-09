import zlib from 'node:zlib';
import {ShellError} from './parse.js';

// Archives are parsed in the shell Worker: pure byte processing, no host
// filesystem. Entry names become logical /work paths only after the caller's
// own path checks; links, devices and absolute or parent paths are refused.
export const ARCHIVE_LIMITS = Object.freeze({entries: 1000, entryBytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, ratio: 200});

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
export function crc32(data) {
  if (zlib.crc32) return zlib.crc32(data) >>> 0;
  let crc = -1;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// Normalized relative entry name, or null for names that must be skipped.
export function entryName(raw) {
  const name = raw.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/').filter(p => p && p !== '.');
  if (!parts.length || parts.some(p => p === '..' || /[\x00-\x1f\x7f:]/.test(p) || p.length > 240)) return null;
  return parts.join('/');
}

function inflate(data, expected, method, name) {
  if (expected > ARCHIVE_LIMITS.entryBytes) throw new ShellError(`${name}: entry exceeds 10 MiB`);
  if (method === 0) return data;
  if (method !== 8) throw new ShellError(`${name}: unsupported compression method ${method}`);
  if (expected > Math.max(1024 * 1024, data.length * ARCHIVE_LIMITS.ratio)) throw new ShellError(`${name}: compression ratio is too high`);
  try { return zlib.inflateRawSync(data, {maxOutputLength: Math.max(1, expected)}); }
  catch { throw new ShellError(`${name}: corrupt or oversized entry`); }
}

// [{name, dir, size, compressed, method, mtime, read()}]
export function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ShellError('not a zip archive (end of central directory not found)');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ShellError('ZIP64 archives are unavailable');
  if (count > ARCHIVE_LIMITS.entries) throw new ShellError(`archive has more than ${ARCHIVE_LIMITS.entries} entries`);
  if (offset + size > buffer.length) throw new ShellError('corrupt zip central directory');
  const entries = [];
  let p = offset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new ShellError('corrupt zip central directory');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10);
    const time = buffer.readUInt16LE(p + 12), date = buffer.readUInt16LE(p + 14);
    const crc = buffer.readUInt32LE(p + 16), compressed = buffer.readUInt32LE(p + 20), uncompressed = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), comment = buffer.readUInt16LE(p + 32);
    const external = buffer.readUInt32LE(p + 38), local = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLength + extra + comment;
    const mode = external >>> 16;
    const isLink = (mode & 0o170000) === 0o120000;
    const dir = rawName.endsWith('/') || (mode & 0o170000) === 0o040000;
    const mtime = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
    entries.push({rawName, name: entryName(rawName), dir, link: isLink, encrypted: Boolean(flags & 1), size: uncompressed, compressed, method, mtime, read: () => {
      if (flags & 1) throw new ShellError(`${rawName}: encrypted entries are unavailable`);
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new ShellError(`${rawName}: corrupt local header`);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      if (start + compressed > buffer.length) throw new ShellError(`${rawName}: truncated entry`);
      const data = inflate(buffer.subarray(start, start + compressed), uncompressed, method, rawName);
      if (data.length !== uncompressed || crc32(data) !== crc) throw new ShellError(`${rawName}: CRC or size mismatch`);
      return data;
    }});
  }
  return entries;
}

function dosTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()};
}

// [{name, data, mtime, dir?}] → ZIP (deflate when it helps, UTF-8 names).
export function writeZip(entries, {level = 6} = {}) {
  if (entries.length > ARCHIVE_LIMITS.entries) throw new ShellError(`more than ${ARCHIVE_LIMITS.entries} entries`);
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.dir ? entry.name.replace(/\/?$/, '/') : entry.name);
    const data = entry.dir ? Buffer.alloc(0) : entry.data;
    const deflated = level > 0 && data.length ? zlib.deflateRawSync(data, {level}) : null;
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data, method = useDeflate ? 8 : 0, crc = crc32(data);
    const {time, date} = dosTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x031e, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(method, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(date, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.dir ? 0o040755 : 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(record, name);
    offset += 30 + name.length + body.length;
    if (offset > ARCHIVE_LIMITS.entryBytes) throw new ShellError('archive exceeds 10 MiB');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export function gunzip(data, name = 'input') {
  if (data[0] !== 0x1f || data[1] !== 0x8b) throw new ShellError(`${name}: not in gzip format`);
  try { return zlib.gunzipSync(data, {maxOutputLength: ARCHIVE_LIMITS.entryBytes}); }
  catch (error) { throw new ShellError(`${name}: ${/maxOutputLength|buffer/i.test(error.message) ? 'decompressed data exceeds 10 MiB' : 'corrupt gzip data'}`); }
}
export const gzip = (data, level = 6) => zlib.gzipSync(data, {level});

// ---------- tar (ustar, GNU long names and pax path records) ----------

const octal = (buffer, start, length) => {
  const text = buffer.subarray(start, start + length).toString('latin1').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
};

// [{name, dir, link, size, mtime, data}]
export function readTar(buffer) {
  const entries = [];
  let p = 0, longName = null, paxPath = null, total = 0;
  while (p + 512 <= buffer.length) {
    const header = buffer.subarray(p, p + 512);
    if (header.every(b => b === 0)) break;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header, 148, 8)) throw new ShellError('corrupt tar header (checksum mismatch)');
    const size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48);
    const dataStart = p + 512, dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new ShellError('truncated tar archive');
    const data = buffer.subarray(dataStart, dataEnd);
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') {
      for (const record of data.toString('utf8').split('\n')) { const match = /^\d+ path=(.*)$/.exec(record); if (match) paxPath = match[1]; }
      continue;
    }
    if (type === 'g') continue;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const base = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const rawName = paxPath ?? longName ?? (prefix ? prefix + '/' + base : base);
    longName = paxPath = null;
    if (entries.length >= ARCHIVE_LIMITS.entries) throw new ShellError(`archive has more than ${ARCHIVE_LIMITS.entries} entries`);
    const regular = type === '0' || type === '\0' || type === '7';
    if (regular) { total += size; if (size > ARCHIVE_LIMITS.entryBytes || total > ARCHIVE_LIMITS.totalBytes) throw new ShellError(`${rawName}: archive content exceeds limits`); }
    entries.push({rawName, name: entryName(rawName), dir: type === '5', link: !regular && type !== '5', size, mtime: octal(header, 136, 12) * 1000, data: regular ? Buffer.from(data) : null});
  }
  return entries;
}

function tarHeader(name, size, mtime, type) {
  const header = Buffer.alloc(512);
  let base = name, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1);
    let split = -1;
    for (let i = cut; i > 0; i = name.lastIndexOf('/', i - 1)) if (Buffer.byteLength(name.slice(i + 1)) <= 100 && Buffer.byteLength(name.slice(0, i)) <= 155) { split = i; break; }
    if (split < 0) return null;
    prefix = name.slice(0, split); base = name.slice(split + 1);
  }
  header.write(base, 0, 100, 'utf8');
  header.write(type === '5' ? '0000755\0' : '0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1'); header.write('0000000\0', 116, 'latin1');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write(Math.floor((mtime || Date.now()) / 1000).toString(8).padStart(11, '0') + '\0', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write(type, 156, 'latin1');
  header.write('ustar\0' + '00', 257, 'latin1');
  header.write('fork', 265, 'latin1'); header.write('fork', 297, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

export function writeTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const name = entry.dir ? entry.name.replace(/\/?$/, '/') : entry.name;
    const data = entry.dir ? Buffer.alloc(0) : entry.data;
    let header = tarHeader(name, data.length, entry.mtime, entry.dir ? '5' : '0');
    if (!header) {
      const long = Buffer.from(name + '\0');
      parts.push(tarHeader('././@LongLink', long.length, 0, 'L'), long, Buffer.alloc((512 - long.length % 512) % 512));
      header = tarHeader(name.slice(-90).replace(/^[^/]*\//, ''), data.length, entry.mtime, entry.dir ? '5' : '0') || tarHeader('long-name', data.length, entry.mtime, entry.dir ? '5' : '0');
    }
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const out = Buffer.concat(parts);
  if (out.length > ARCHIVE_LIMITS.entryBytes) throw new ShellError('archive exceeds 10 MiB');
  return out;
}
