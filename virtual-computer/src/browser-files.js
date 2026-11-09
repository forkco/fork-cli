import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Failure, check} from './errors.js';

const exec = promisify(execFile);
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_FILES = 200;
const MAX_DIRS = 200;
const cleanName = value => {
  const name = basename(String(value).replaceAll('\\', '/')).replace(/[:\x00-\x1f\x7f]/g, '_').slice(0, 240);
  return !name || name === '.' || name === '..' ? 'download' : name;
};

// Logical paths only. Physical filenames are always generated IDs.
export function workPath(value) {
  check(typeof value === 'string' && value.length <= 512, 'Invalid work path');
  const path = value.startsWith('/work/') ? value.slice(6) : value;
  check(path.length > 0 && path.split('/').every(p => p && p !== '.' && p !== '..' && !/[\\:\x00-\x1f\x7f]/.test(p) && p.length <= 240), 'Use a relative work path without traversal');
  check(!path.startsWith('/'), 'Host paths are unavailable');
  return path;
}

export function fileType(bytes) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  try { new TextDecoder('utf-8', {fatal: true}).decode(bytes); if (!bytes.includes(0)) return 'text/plain'; } catch {}
  return 'application/octet-stream';
}

// Offsets for file/resource reads are bytes, with a bounded response and an
// explicit continuation. Binary bytes are never mistaken for executable code.
export function readBytes(bytes, command, mime = fileType(bytes)) {
  const offset = Math.min(command.offset || 0, bytes.length);
  let end = Math.min(offset + (command.limit || 32768), bytes.length);
  mime ||= fileType(bytes);
  const encoding = command.encoding === 'base64' || (command.encoding !== 'text' && !mime.startsWith('text/') && !/json|javascript|xml|svg/.test(mime)) ? 'base64' : 'text';
  // Include the remainder of a UTF-8 character instead of splitting it across
  // chunks (at most three extra bytes, including with limit:1).
  if (encoding === 'text') while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  return {content: bytes.subarray(offset, end).toString(encoding === 'base64' ? 'base64' : 'utf8'), encoding,
    offset, next_offset: end < bytes.length ? end : null, total_bytes: bytes.length, truncated: end < bytes.length, mime_type: mime};
}

export class BrowserFiles {
  constructor(dir) { this.dir = dir; this.items = new Map(); this.dirs = new Set(); this.pendingPaths = new Set(); this.rejected = 0; this.closed = false; }
  total() { return [...this.items.values()].filter(f => f.state !== 'failed').reduce((n, f) => n + f.size, 0); }
  public(f) { return {file_id: f.id, name: f.name, path: '/work/' + f.path, state: f.state, size: f.size, source: f.source, ...(f.error ? {error: f.error} : {})}; }
  list() { return {files: [...this.items.values()].map(f => this.public(f)), rejected_downloads: this.rejected}; }
  // Shell view: modification times and explicit (possibly empty) folders.
  entries() { return {files: [...this.items.values()].map(f => ({...this.public(f), mtime: f.mtime || 0})), dirs: [...this.dirs]}; }
  // A logical path is either a file or a folder, never both.
  checkTree(path, except) {
    const prefix = path + '/';
    check(!this.dirs.has(path), 'A folder exists at this path');
    for (const f of this.items.values()) {
      if (f === except) continue;
      check(!f.path.startsWith(prefix), 'A folder exists at this path');
      check(!prefix.startsWith(f.path + '/'), 'A file exists where a folder is needed');
    }
  }
  mkdir(path) {
    path = workPath(path);
    check(!this.closed, 'Session is closed');
    check(![...this.items.values()].some(f => f.path === path || path.startsWith(f.path + '/')), 'A file exists at this path');
    const parts = path.split('/');
    const added = parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter(p => !this.dirs.has(p));
    check(this.dirs.size + added.length <= MAX_DIRS, 'Session folder limit reached');
    for (const p of added) this.dirs.add(p);
    return {path: '/work/' + path};
  }
  rmdir(path) {
    path = workPath(path);
    check(![...this.items.values()].some(f => f.path.startsWith(path + '/')), 'Directory not empty');
    for (const p of [...this.dirs]) if (p === path || p.startsWith(path + '/')) this.dirs.delete(p);
    return {removed: true};
  }
  rename(id, to, overwrite = false) {
    check(!this.closed, 'Session is closed');
    const f = this.resolve(id);
    to = workPath(to);
    check(!this.pendingPaths.has(f.path) && !this.pendingPaths.has(to), 'File is busy');
    check(f.state === 'ready' || f.state === 'failed', 'File is busy');
    if (to === f.path) return this.public(f);
    const old = [...this.items.values()].find(x => x.path === to);
    check(!old || (overwrite && old.state === 'ready'), 'Output exists or is busy; use another path or overwrite:true');
    this.checkTree(to, old);
    if (old) { this.items.delete(old.id); void rm(join(this.dir, old.id), {force: true}).catch(() => {}); }
    f.path = to; f.name = basename(to); f.mtime = Date.now();
    return this.public(f);
  }
  uniquePath(path) {
    const used = new Set([...this.items.values()].map(f => f.path));
    if (!used.has(path)) return path;
    return path + '-' + randomUUID();
  }
  async install(browser) {
    await mkdir(this.dir, {recursive: true, mode: 0o700});
    this.cdp = await browser.newBrowserCDPSession();
    const {browserContextIds} = await this.cdp.send('Target.getBrowserContexts');
    check(browserContextIds.length === 1, 'Expected a single isolated browser context');
    this.contextID = browserContextIds[0];
    this.cdp.on('Browser.downloadWillBegin', event => this.begin(event));
    this.cdp.on('Browser.downloadProgress', event => { void this.progress(event).catch(() => {}); });
    await this.cdp.send('Browser.setDownloadBehavior', {behavior: 'allowAndName', browserContextId: this.contextID, downloadPath: this.dir, eventsEnabled: true});
  }
  begin(event) {
    if (this.closed || !/^[a-zA-Z0-9-]{1,80}$/.test(event.guid) || this.items.size >= MAX_FILES || this.total() >= MAX_TOTAL_BYTES) {
      this.rejected++;
      void this.cdp.send('Browser.cancelDownload', {guid: event.guid, browserContextId: this.contextID}).catch(() => {});
      return;
    }
    const name = cleanName(event.suggestedFilename);
    const f = {id: event.guid, name, path: this.uniquePath('downloads/' + name), state: 'downloading', size: 0, source: 'download', mtime: Date.now()};
    this.items.set(f.id, f);
    f.timer = setTimeout(() => { void this.fail(f, 'download_timeout'); }, 30000);
    f.timer.unref();
  }
  async fail(f, reason) {
    f.state = 'failed'; f.error = reason; clearTimeout(f.timer);
    await this.cdp?.send('Browser.cancelDownload', {guid: f.id, browserContextId: this.contextID}).catch(() => {});
    await Promise.all([rm(join(this.dir, f.id), {force: true}), rm(join(this.dir, f.id + '.crdownload'), {force: true})]).catch(() => {});
  }
  async progress(event) {
    const f = this.items.get(event.guid);
    if (!f || f.state !== 'downloading' || this.closed) return;
    f.size = Math.max(0, event.receivedBytes);
    if (event.totalBytes > MAX_FILE_BYTES || f.size > MAX_FILE_BYTES || this.total() > MAX_TOTAL_BYTES) return this.fail(f, 'file_size_limit');
    if (event.state === 'canceled') return this.fail(f, 'download_failed');
    if (event.state !== 'completed') return;
    clearTimeout(f.timer);
    try {
      const info = await stat(join(this.dir, f.id));
      if (!info.isFile() || info.size > MAX_FILE_BYTES || this.total() - f.size + info.size > MAX_TOTAL_BYTES) return this.fail(f, 'file_size_limit');
      if (this.closed || f.state !== 'downloading') return;
      f.size = info.size; f.state = 'ready'; f.mtime = Date.now();
    } catch { await this.fail(f, 'download_failed'); }
  }
  async import(name, data) {
    name = cleanName(name);
    return this.write(this.uniquePath('inputs/' + name), data, false, 'attachment');
  }
  resolve(id) {
    let path;
    try { path = workPath(id); } catch { /* Invalid paths are indistinguishable from missing IDs. */ }
    const f = this.items.get(id) || [...this.items.values()].find(f => path && f.path === path);
    if (!f) throw new Failure(404, 'file_not_found', 'File not found in this session');
    return f;
  }
  async write(path, data, overwrite = false, source = 'code', signal) {
    path = workPath(path);
    check(!this.closed && !signal?.aborted, 'Session or code run is closed');
    check(!this.pendingPaths.has(path), 'Output path is busy');
    const old = [...this.items.values()].find(f => f.path === path);
    check(!old || (overwrite && old.state === 'ready'), 'Output exists or is busy; use another path or overwrite:true');
    check(this.items.size < MAX_FILES + (old ? 1 : 0), 'Session file limit reached');
    check(Buffer.isBuffer(data) && data.length <= MAX_FILE_BYTES && this.total() - (old?.size || 0) + data.length <= MAX_TOTAL_BYTES, 'Session file size limit reached');
    this.checkTree(path, old);
    const f = {id: randomUUID(), name: basename(path), path, state: 'importing', size: data.length, source, mtime: Date.now()};
    this.pendingPaths.add(path);
    this.items.set(f.id, f); // reserve quota before yielding to download events
    try {
      await writeFile(join(this.dir, f.id), data, {flag: 'wx', mode: 0o600});
      if (this.closed || signal?.aborted) throw new Failure(404, 'session_not_found', 'Session or code run is closed');
      if (old) { this.items.delete(old.id); await rm(join(this.dir, old.id), {force: true}); }
      f.state = 'ready';
      return this.public(f);
    } catch (error) {
      this.items.delete(f.id); await rm(join(this.dir, f.id), {force: true}).catch(() => {});
      if (error instanceof Failure) throw error;
      throw new Failure(422, 'file_write_failed', 'Could not save the temporary work file');
    } finally { this.pendingPaths.delete(path); }
  }
  async remove(id) {
    check(!this.closed, 'Session is closed');
    const f = this.resolve(id);
    check(!this.pendingPaths.has(f.path), 'File is busy');
    check(f.state === 'ready' || f.state === 'failed', 'File is busy');
    this.items.delete(f.id);
    await rm(join(this.dir, f.id), {force: true});
    return {removed: true};
  }
  async bytes(id) {
    check(!this.closed, 'Session is closed');
    const f = this.resolve(id);
    if (f.state !== 'ready') throw new Failure(409, 'file_not_ready', f.error || 'Download is still in progress');
    let data;
    try { data = await readFile(join(this.dir, f.id)); }
    catch { throw new Failure(404, 'file_not_found', 'Temporary work file is no longer available'); }
    return {file: this.public(f), data};
  }
  async read(command) {
    const {file, data} = await this.bytes(command.file_id);
    const mime = fileType(data);
    if (command.encoding === 'base64') return {file, ...readBytes(data, command, mime)};
    if (mime.startsWith('image/') && command.encoding !== 'text') {
      check(data.length <= 4_000_000, 'Image exceeds 4 MB; read base64 chunks instead');
      return {file, image: {mime_type: mime, base64: data.toString('base64')}};
    }
    if (mime !== 'application/pdf') return {file, ...readBytes(data, command, mime)};
    // Fixed Poppler commands, fixed private paths, no shell and no caller flags.
    const input = join(this.dir, file.file_id), page = command.page || 1;
    const options = {timeout: 10000, maxBuffer: 512 * 1024, env: {PATH: process.env.PATH, LANG: 'C.UTF-8'}};
    let info, content;
    try {
      info = (await exec('pdfinfo', [input], options)).stdout;
      const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      check(pages && page <= pages, 'PDF page is out of range');
      content = (await exec('pdftotext', ['-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', input, '-'], options)).stdout;
      const result = {file, page, pages, ...readBytes(Buffer.from(content), command, 'text/plain')};
      if (command.encoding !== 'text') {
        const output = join(this.dir, 'preview-' + randomUUID());
        try {
          await exec('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1600', '-jpeg', input, output], options);
          const image = await readFile(output + '.jpg');
          check(image.length <= 4_000_000, 'PDF preview too large');
          result.image = {mime_type: 'image/jpeg', base64: image.toString('base64')};
        } finally { await rm(output + '.jpg', {force: true}); }
      }
      return result;
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure(422, 'file_preview_failed', 'Cannot preview this PDF (encrypted, invalid, too complex, or PDF tools unavailable); raw base64 reads remain available');
    }
  }
  close() { this.closed = true; for (const f of this.items.values()) clearTimeout(f.timer); }
}
