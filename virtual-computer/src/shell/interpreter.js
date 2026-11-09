import {ShellError, parse, globRegExp, hasGlob, unescapeGlob} from './parse.js';
import {commands} from './commands.js';
import './commands-archive.js';
import './commands-media.js';
import './commands-ssh.js';

export const LIMITS = Object.freeze({
  stream: 16 * 1024 * 1024,   // one command's stdout/stderr buffer
  stdout: 64 * 1024,          // text returned to the caller
  stderr: 16 * 1024,
  commands: 10_000,           // executed commands, including xargs/find -exec
  depth: 4,                   // nested xargs/find -exec
  globMatches: 5_000,
});

const ROOT = '/work';
export const display = path => ROOT + (path ? '/' + path : '');

// Logical paths: '' is /work, 'a/b' is /work/a/b. Nothing else is reachable.
export function resolvePath(cwd, arg) {
  if (typeof arg !== 'string' || arg === '') throw new ShellError('empty path');
  let path;
  if (arg === ROOT || arg.startsWith(ROOT + '/')) path = arg.slice(ROOT.length);
  else if (arg.startsWith('/')) throw new ShellError(`${arg}: only /work is available`);
  else path = cwd + '/' + arg;
  const parts = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new ShellError(`${arg}: outside /work`);
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

export class Output {
  constructor(limit = LIMITS.stream) { this.chunks = []; this.size = 0; this.limit = limit; }
  write(value) {
    const chunk = Buffer.from(value);
    this.size += chunk.length;
    if (this.size > this.limit) throw new ShellError(`output exceeds ${this.limit >> 20} MiB; narrow the command or write in parts`);
    this.chunks.push(chunk);
  }
  buffer() { return Buffer.concat(this.chunks); }
}

// Cached view of the session's files. Every mutation goes through the
// backend (the runner's BrowserFiles) and invalidates the cache.
// Backend refusals (quotas, busy files) become ordinary command errors.
const guarded = backend => Object.fromEntries(Object.entries(backend).map(([name, fn]) => [name, async (...args) => {
  try { return await fn(...args); }
  catch (error) { throw error instanceof ShellError ? error : Object.assign(new ShellError(String(error?.message || error)), {code: error?.code}); }
}]));

export class VFS {
  constructor(backend) { this.backend = guarded(backend); this.cache = null; }
  async snapshot() {
    if (!this.cache) {
      const {files, dirs} = await this.backend.list();
      const byPath = new Map(files.map(f => [f.path.replace(/^\/work\//, ''), f]));
      const allDirs = new Set(['']);
      const addParents = path => { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) allDirs.add(parts.slice(0, i).join('/')); };
      for (const path of byPath.keys()) addParents(path);
      for (const dir of dirs || []) { allDirs.add(dir); addParents(dir); }
      this.cache = {files: byPath, dirs: allDirs};
    }
    return this.cache;
  }
  invalidate() { this.cache = null; }
  async stat(path) {
    const {files, dirs} = await this.snapshot();
    if (files.has(path)) return {...files.get(path), kind: 'file', path};
    if (dirs.has(path)) return {kind: 'dir', path, size: 0};
    return null;
  }
  async children(dir) {
    const {files, dirs} = await this.snapshot();
    const prefix = dir ? dir + '/' : '', out = new Map();
    for (const [path, file] of files) if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) out.set(path.slice(prefix.length), {...file, kind: 'file', path});
    for (const path of dirs) if (path && path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) out.set(path.slice(prefix.length), {kind: 'dir', path, size: 0});
    return [...out.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entry]) => ({name, ...entry}));
  }
  // Every entry below dir (depth-first, sorted), excluding dir itself.
  async walk(dir, visit, depth = 1) {
    for (const entry of await this.children(dir)) {
      if (await visit(entry, depth) === false) continue;
      if (entry.kind === 'dir') await this.walk(entry.path, visit, depth + 1);
    }
  }
  async read(path) {
    const entry = await this.stat(path);
    if (!entry) throw new ShellError(`${display(path)}: No such file or directory`);
    if (entry.kind === 'dir') throw new ShellError(`${display(path)}: Is a directory`);
    if (entry.state !== 'ready') throw new ShellError(`${display(path)}: ${entry.state === 'failed' ? 'download failed' : 'still downloading'}`);
    return Buffer.from(await this.backend.read(path));
  }
  async write(path, data, overwrite = true) {
    if (!path) throw new ShellError('/work: Is a directory');
    const entry = await this.stat(path);
    if (entry?.kind === 'dir') throw new ShellError(`${display(path)}: Is a directory`);
    this.invalidate();
    return this.backend.write(path, Buffer.from(data), overwrite);
  }
  async remove(path) { this.invalidate(); return this.backend.remove(path); }
  async rename(from, to, overwrite = true) { this.invalidate(); return this.backend.rename(from, to, overwrite); }
  async mkdir(path) { this.invalidate(); return this.backend.mkdir(path); }
  async rmdir(path) { this.invalidate(); return this.backend.rmdir(path); }
  async tool(request) { this.invalidate(); return this.backend.tool(request); }
  async inspect(request) { this.invalidate(); return this.backend.inspect(request); }
  async ssh(op, args) {
    if (!this.backend.ssh) throw new ShellError('ssh is unavailable in this shell');
    const value = await this.backend.ssh(op, args);
    if (value && value.data instanceof Uint8Array) value.data = Buffer.from(value.data);
    return value;
  }
  async page(name, arg) {
    if (!this.backend.page) throw new ShellError('no browser page is attached to this shell');
    const value = await this.backend.page(name, arg);
    return value instanceof Uint8Array ? Buffer.from(value) : value;
  }
  // Bytes, or the saved file's metadata when path is given.
  async download(url, headers, path, overwrite = false) {
    if (path !== undefined) {
      const entry = await this.stat(path);
      if (entry?.kind === 'dir') throw new ShellError(`${display(path)}: Is a directory`);
      this.invalidate();
      return this.backend.download(url, headers, path, overwrite);
    }
    return Buffer.from(await this.backend.download(url, headers));
  }
}

export class Shell {
  constructor(backend, {cwd = ROOT, stdin = ''} = {}) {
    this.vfs = new VFS(backend);
    this.cwd = resolvePath('', cwd);
    this.stdin = Buffer.from(stdin);
    this.stdinUsed = false;
    this.stdout = new Output();
    this.stderr = new Output(LIMITS.stream);
    this.executed = 0;
    this.exitRequested = null;
  }
  async run(source) {
    let status;
    try {
      if ((await this.vfs.stat(this.cwd))?.kind !== 'dir') throw new ShellError(`cd: ${display(this.cwd)}: No such directory`);
      status = await this.runList(parse(source));
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      this.safeError(`sh: ${error.message}\n`);
      status = error.status || 1;
    }
    if (this.exitRequested !== null) status = this.exitRequested;
    return this.result(status);
  }
  safeError(text) { try { this.stderr.write(text); } catch { /* stderr overflow keeps the first 16 MiB */ } }
  result(status) {
    const clip = (output, limit) => {
      const bytes = output.buffer();
      let text;
      if (bytes.subarray(0, limit).includes(0)) text = `[binary output, ${bytes.length} bytes; redirect it to a file]\n`;
      else {
        let end = Math.min(bytes.length, limit);
        while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
        text = bytes.subarray(0, end).toString('utf8');
      }
      return {text, total: bytes.length, truncated: bytes.length > limit};
    };
    const out = clip(this.stdout, LIMITS.stdout), err = clip(this.stderr, LIMITS.stderr);
    return {stdout: out.text, stderr: err.text, exit_code: status, cwd: display(this.cwd),
      truncated: out.truncated || err.truncated, stdout_bytes: out.total};
  }
  async runList(list) {
    let status = 0;
    for (const item of list) {
      if (item.op === '&&' && status !== 0) continue;
      if (item.op === '||' && status === 0) continue;
      status = await this.runPipeline(item.pipeline);
      if (this.exitRequested !== null) break;
    }
    return status;
  }
  async runPipeline(pipeline) {
    let input = null, status = 0;
    for (let i = 0; i < pipeline.length; i++) {
      const last = i === pipeline.length - 1;
      const sink = last ? this.stdout : new Output();
      let result;
      try { result = await this.runCommand(pipeline[i], {input, first: i === 0, sink}); }
      catch (error) {
        if (!(error instanceof ShellError)) throw error;
        this.safeError(`sh: ${error.message}\n`);
        result = {sink, status: error.status || 1};
      }
      input = last ? null : result.sink.buffer();
      status = result.status;
      if (this.exitRequested !== null) break;
    }
    return status;
  }
  takeStdin() {
    if (this.stdinUsed) return Buffer.alloc(0);
    this.stdinUsed = true;
    return this.stdin;
  }
  async expand(words) {
    const argv = [];
    for (const word of words) {
      if (word.pattern && hasGlob(word.pattern)) {
        const matches = await this.glob(word.pattern);
        if (matches.length) { argv.push(...matches); continue; }
        argv.push(unescapeGlob(word.pattern));
      } else argv.push(word.word);
    }
    return argv;
  }
  async glob(pattern) {
    let base = '', shown = '', rest = pattern;
    if (pattern === ROOT || pattern.startsWith(ROOT + '/')) { shown = ROOT; rest = pattern.slice(ROOT.length + 1); }
    else if (pattern.startsWith('/')) return [];
    else base = this.cwd;
    let current = [{path: base, shown}];
    const segments = rest.split('/').filter(Boolean);
    for (let s = 0; s < segments.length; s++) {
      const segment = segments[s], lastSegment = s === segments.length - 1, next = [];
      for (const {path, shown: prefix} of current) {
        const join = name => (prefix ? prefix + '/' : '') + name;
        if (!hasGlob(segment)) {
          const name = unescapeGlob(segment);
          let target;
          try { target = resolvePath(path, name); } catch { continue; }
          const entry = await this.vfs.stat(target);
          if (entry && (lastSegment || entry.kind === 'dir')) next.push({path: target, shown: join(name)});
          continue;
        }
        const entry = await this.vfs.stat(path);
        if (entry?.kind !== 'dir') continue;
        const regexp = globRegExp(segment);
        for (const child of await this.vfs.children(path)) {
          if (child.name.startsWith('.') && !segment.startsWith('.')) continue;
          if (!regexp.test(child.name) || (!lastSegment && child.kind !== 'dir')) continue;
          next.push({path: child.path, shown: join(child.name)});
          if (next.length > LIMITS.globMatches) throw new ShellError(`${pattern}: too many matches`);
        }
      }
      current = next;
    }
    return current.map(m => m.shown).sort();
  }
  async runCommand(cmd, {input, first, sink}, depth = 0) {
    if (++this.executed > LIMITS.commands) throw new ShellError('command limit reached', 2);
    const argv = await this.expand(cmd.words);
    let stdin = input ?? (first ? null : Buffer.alloc(0));
    const stdout = new Output(), stderr = new Output();
    const destinations = {1: {output: stdout}, 2: {output: stderr}};
    const writes = [];
    let inputPath;
    for (const redir of cmd.redirs) {
      if (redir.redir === '>&') {
        destinations[redir.fd] = destinations[redir.target];
        continue;
      }
      const targets = await this.expand([redir.target]);
      if (targets.length !== 1) throw new ShellError('ambiguous redirect');
      const target = targets[0];
      if (redir.redir === '<') {
        inputPath = target === '/dev/null' ? null : resolvePath(this.cwd, target);
        if (inputPath !== null && (await this.vfs.stat(inputPath))?.kind !== 'file') throw new ShellError(`${target}: No readable file`);
        continue;
      }
      const file = target === '/dev/null' ? null : resolvePath(this.cwd, target);
      const append = redir.redir.endsWith('>>');
      if (file !== null) {
        const entry = await this.vfs.stat(file);
        if (!append || !entry) await this.vfs.write(file, Buffer.alloc(0), true);
        else if (entry.kind !== 'file') throw new ShellError(`${target}: Is a directory`);
      }
      const destination = {file, append, position: 0, output: new Output()};
      destinations[redir.fd] = destination;
      if (redir.redir.startsWith('&')) destinations[2] = destination;
    }
    if (inputPath !== undefined) stdin = inputPath === null ? Buffer.alloc(0) : await this.vfs.read(inputPath);
    const emit = (destination, value) => {
      const chunk = Buffer.from(value);
      destination.output.write(chunk);
      if ('file' in destination && destination.file !== null) writes.push({destination, chunk});
    };
    const io = {
      argv, cwd: this.cwd, vfs: this.vfs, shell: this, depth,
      stdin: () => stdin ?? this.takeStdin(),
      out: value => emit(destinations[1], value),
      err: value => emit(destinations[2], value),
    };
    let status;
    if (!argv.length) status = 0;
    else {
      const run = commands[argv[0]];
      if (!run) { io.err(`${argv[0]}: command not found (run help for the list)\n`); status = 127; }
      else {
        try { status = (await run(io)) ?? 0; }
        catch (error) {
          if (!(error instanceof ShellError)) throw error;
          io.err(`${argv[0]}: ${error.message}\n`);
          status = error.status || 1;
        }
      }
    }
    const changed = new Map();
    for (const {destination, chunk} of writes) {
      const {file, append} = destination;
      let data = changed.get(file);
      if (!data) data = await this.vfs.read(file);
      const offset = append ? data.length : destination.position;
      const next = Buffer.alloc(Math.max(data.length, offset + chunk.length));
      data.copy(next); chunk.copy(next, offset);
      destination.position = offset + chunk.length;
      changed.set(file, next);
    }
    for (const [file, data] of changed) await this.vfs.write(file, data, true);
    for (const chunk of stdout.chunks) sink.write(chunk);
    for (const chunk of stderr.chunks) this.stderr.write(chunk);
    return {status, sink};
  }
  // Runs one builtin with explicit argv (xargs, find -exec): no re-parsing.
  async invoke(argv, io, input = Buffer.alloc(0)) {
    if (io.depth + 1 > LIMITS.depth) throw new ShellError('nesting limit reached');
    const words = argv.map(word => ({word, pattern: null}));
    const sink = new Output();
    const {status} = await this.runCommand({words, redirs: []}, {input, first: false, sink}, io.depth + 1);
    for (const chunk of sink.chunks) io.out(chunk);
    return status;
  }
}
