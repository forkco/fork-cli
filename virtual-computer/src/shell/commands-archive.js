import {ShellError, globRegExp} from './parse.js';
import {resolvePath, display} from './interpreter.js';
import {getopt, time, entryAt, command, status} from './commands.js';
import {readZip, writeZip, readTar, writeTar, gzip, gunzip} from './archive.js';

// Archive member name for a logical path: relative to cwd when below it.
function memberName(cwd, path) {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
}

// Files (and folders, when recursive) named by operands, as archive members.
async function collect(io, operands, {recursive, junk, verb}) {
  const members = [];
  for (const operand of operands) {
    const {path, entry} = await entryAt(io, operand);
    if (!entry) { io.err(`${verb}: ${operand}: No such file or directory\n`); io.failed = true; continue; }
    if (entry.kind === 'file') { members.push({path, name: junk ? path.split('/').pop() : memberName(io.cwd, path), entry}); continue; }
    if (!recursive) { io.err(`${verb}: ${operand}: is a directory (use -r)\n`); io.failed = true; continue; }
    if (path && !junk) members.push({path, name: memberName(io.cwd, path), dir: true, entry});
    await io.vfs.walk(path, child => {
      if (child.kind === 'dir') { if (!junk) members.push({path: child.path, name: memberName(io.cwd, child.path), dir: true, entry: child}); }
      else members.push({path: child.path, name: junk ? child.name : memberName(io.cwd, child.path), entry: child});
    });
  }
  return members;
}

async function extractTo(io, dest, entries, {overwrite, skipExisting, quiet, verb, label}) {
  let written = 0;
  for (const entry of entries) {
    if (!entry.name) { io.err(`${verb}: skipping unsafe name: ${entry.rawName}\n`); continue; }
    if (entry.link) { io.err(`${verb}: skipping link or special file: ${entry.rawName}\n`); continue; }
    const path = (dest ? dest + '/' : '') + entry.name;
    if (entry.dir) { await io.vfs.mkdir(path); continue; }
    const existing = await io.vfs.stat(path);
    if (existing && skipExisting) continue;
    if (existing && !overwrite) { io.err(`${verb}: ${display(path)} exists; use -o to overwrite or -n to skip\n`); io.failed = true; continue; }
    const data = entry.data ?? entry.read();
    await io.vfs.write(path, data, true);
    written++;
    if (!quiet) io.out(`  ${label}: ${memberName(io.cwd, path)}\n`);
  }
  return written;
}

command('zip', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'rjqmD0123456789', long: {recurse: 'r', 'junk-paths': 'j', quiet: 'q', move: 'm'}});
  if (rest.length < 2) throw new ShellError('usage: zip [-r] [-j] [-q] [-0..-9] ARCHIVE.zip FILE...', 2);
  const archiveName = rest[0].endsWith('.zip') || rest[0].includes('.') ? rest[0] : rest[0] + '.zip';
  const archive = resolvePath(io.cwd, archiveName);
  const level = [...'0123456789'].reverse().find(d => opts[d]) ?? '6';
  const members = (await collect(io, rest.slice(1), {recursive: opts.r, junk: opts.j, verb: 'zip'})).filter(m => m.path !== archive);
  if (!members.length) { io.err(`zip error: Nothing to do! (${archiveName})\n`); return 12; }
  const existing = (await io.vfs.stat(archive))?.kind === 'file' ? readZip(await io.vfs.read(archive)) : [];
  const byName = new Map(existing.filter(e => e.name).map(e => [e.dir ? e.name + '/' : e.name, {name: e.name, dir: e.dir, mtime: e.mtime, read: e.read}]));
  for (const member of members) {
    const key = member.dir ? member.name + '/' : member.name;
    const data = member.dir ? null : await io.vfs.read(member.path);
    if (!opts.q) io.out(`  ${byName.has(key) ? 'updating' : 'adding'}: ${member.name}${member.dir ? '/' : ''}${member.dir ? ' (stored 0%)' : ''}\n`);
    byName.set(key, {name: member.name, dir: member.dir, mtime: member.entry.mtime, data});
  }
  const entries = [...byName.values()].map(e => ({...e, data: e.dir ? null : e.data ?? e.read()}));
  await io.vfs.write(archive, writeZip(entries, {level: Number(level)}), true);
  if (opts.m) for (const member of members) if (!member.dir) await io.vfs.remove(member.path);
  return status(io) ? 18 : 0;
});

command('unzip', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'lonqpvjZ', values: 'dx', long: {}});
  if (!rest.length) throw new ShellError('usage: unzip [-l] [-o|-n] [-q] [-p] [-j] [-d DIR] ARCHIVE.zip [MEMBER...]', 10);
  const archive = resolvePath(io.cwd, rest[0]);
  const entries = readZip(await io.vfs.read(archive));
  const patterns = rest.slice(1).map(p => new RegExp(globRegExp(p).source.replaceAll('[^/]*', '.*').replaceAll('[^/]', '.'), 'u'));
  const exclude = (opts.all.x || []).map(p => new RegExp(globRegExp(p).source.replaceAll('[^/]*', '.*').replaceAll('[^/]', '.'), 'u'));
  const chosen = entries.filter(e => (!patterns.length || patterns.some(r => r.test(e.rawName))) && !exclude.some(r => r.test(e.rawName)));
  if (patterns.length && !chosen.length) { io.err(`caution: filename not matched: ${rest.slice(1).join(' ')}\n`); return 11; }
  if (opts.l || opts.v || opts.Z) {
    let total = 0;
    const rows = [`Archive:  ${rest[0]}`, '  Length      Date    Time    Name', '---------  ---------- -----   ----'];
    for (const e of chosen) { total += e.size; rows.push(`${String(e.size).padStart(9)}  ${time(e.mtime)}   ${e.rawName}${e.encrypted ? ' (encrypted)' : ''}`); }
    rows.push('---------                     -------', `${String(total).padStart(9)}                     ${chosen.length} file${chosen.length === 1 ? '' : 's'}`);
    io.out(rows.join('\n') + '\n');
    return 0;
  }
  if (opts.p) { for (const e of chosen) if (!e.dir && e.name && !e.link) io.out(e.read()); return 0; }
  const dest = opts.d !== undefined ? resolvePath(io.cwd, opts.d) : io.cwd;
  if (opts.d !== undefined) await io.vfs.mkdir(dest).catch(() => {});
  if (!opts.q) io.out(`Archive:  ${rest[0]}\n`);
  const list = opts.j ? chosen.filter(e => !e.dir).map(e => ({...e, name: e.name && e.name.split('/').pop()})) : chosen;
  await extractTo(io, dest, list, {overwrite: opts.o, skipExisting: opts.n, quiet: opts.q, verb: 'unzip', label: 'inflating'});
  return io.failed ? 1 : 0;
});

command('tar', async io => {
  let args = io.argv.slice(1);
  if (args[0] && !args[0].startsWith('-') && /^[ctxzvfCkpO]+$/.test(args[0])) args = ['-' + args[0], ...args.slice(1)];
  const {opts, rest} = getopt(args, {flags: 'ctxzvkpOa', values: 'fC', long: {create: 'c', extract: 'x', list: 't', gzip: 'z', verbose: 'v', file: '=f', directory: '=C', 'keep-old-files': 'k', 'to-stdout': 'O'}});
  const modes = ['c', 'x', 't'].filter(m => opts[m]);
  if (modes.length !== 1) throw new ShellError('you must specify exactly one of -c, -x, -t', 2);
  if (opts.f === undefined) throw new ShellError('use -f ARCHIVE (or -f - for standard input/output)', 2);
  const base = opts.C !== undefined ? resolvePath(io.cwd, opts.C) : io.cwd;
  if (opts.c) {
    if (!rest.length) throw new ShellError('cowardly refusing to create an empty archive', 2);
    const archive = opts.f === '-' ? null : resolvePath(io.cwd, opts.f);
    const scoped = {...io, cwd: base};
    const members = (await collect(scoped, rest, {recursive: true, verb: 'tar'})).filter(m => m.path !== archive);
    io.failed ||= scoped.failed;
    const entries = [];
    for (const m of members) {
      entries.push({name: m.name, dir: m.dir, mtime: m.entry.mtime, data: m.dir ? null : await io.vfs.read(m.path)});
      if (opts.v) io.err(m.name + (m.dir ? '/' : '') + '\n');
    }
    let data = writeTar(entries);
    if (opts.z || /\.(tgz|tar\.gz)$/.test(opts.f)) data = gzip(data);
    if (archive === null) io.out(data); else await io.vfs.write(archive, data, true);
    return io.failed ? 2 : 0;
  }
  let data = opts.f === '-' ? io.stdin() : await io.vfs.read(resolvePath(io.cwd, opts.f));
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzip(data, opts.f);
  const patterns = rest.map(p => new RegExp(globRegExp(p.replace(/\/$/, '')).source.replaceAll('[^/]*', '.*').replaceAll('[^/]', '.').replace(/\$$/, '(?:/.*)?$'), 'u'));
  const entries = readTar(data).filter(e => !patterns.length || patterns.some(r => r.test(e.rawName.replace(/\/$/, ''))));
  if (opts.t) {
    io.out(entries.map(e => opts.v ? `${e.dir ? 'd' : e.link ? 'l' : '-'} ${String(e.size).padStart(9)} ${time(e.mtime)} ${e.rawName}` : e.rawName).join('\n') + (entries.length ? '\n' : ''));
    return 0;
  }
  if (opts.O) { for (const e of entries) if (e.data) io.out(e.data); return 0; }
  const saved = {...io, out: text => { if (opts.v) io.out(text.replace(/^ {2}x: /, '')); }};
  await extractTo(saved, base, entries, {overwrite: !opts.k, skipExisting: opts.k, quiet: !opts.v, verb: 'tar', label: 'x'});
  io.failed ||= saved.failed;
  return io.failed ? 2 : 0;
});

async function gzipCommand(io, {decompress = false, toStdout = false} = {}) {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'dckfqlvnN123456789', long: {decompress: 'd', stdout: 'c', 'to-stdout': 'c', keep: 'k', force: 'f', quiet: 'q', list: 'l'}});
  decompress ||= Boolean(opts.d);
  toStdout ||= Boolean(opts.c);
  const level = Number([...'987654321'].find(d => opts[d]) ?? 6);
  if (!rest.length || rest.includes('-')) {
    const data = io.stdin();
    io.out(decompress ? gunzip(data, 'stdin') : gzip(data, level));
    return 0;
  }
  for (const name of rest) {
    const {path, entry} = await entryAt(io, name);
    if (entry?.kind !== 'file') { io.err(`${io.argv[0]}: ${name}: ${entry ? 'Is a directory' : 'No such file or directory'}\n`); io.failed = true; continue; }
    const data = await io.vfs.read(path);
    if (opts.l) { const out = gunzip(data, name); io.out(`${String(data.length).padStart(10)} ${String(out.length).padStart(10)} ${name.replace(/\.gz$/, '')}\n`); continue; }
    if (decompress && !/\.(gz|tgz|z)$/i.test(path) && !toStdout) { io.err(`${io.argv[0]}: ${name}: unknown suffix -- ignored\n`); io.failed = true; continue; }
    const result = decompress ? gunzip(data, name) : gzip(data, level);
    if (toStdout) { io.out(result); continue; }
    const target = decompress ? path.replace(/\.tgz$/i, '.tar').replace(/\.(gz|z)$/i, '') : path + '.gz';
    if (await io.vfs.stat(target) && !opts.f) { io.err(`${io.argv[0]}: ${memberName(io.cwd, target)} already exists (use -f)\n`); io.failed = true; continue; }
    await io.vfs.write(target, result, true);
    if (!opts.k) await io.vfs.remove(path);
    if (opts.v) io.err(`${name}:\t${decompress ? '' : (100 - (result.length * 100 / Math.max(1, data.length))).toFixed(1) + '% -- '}replaced with ${memberName(io.cwd, target)}\n`);
  }
  return io.failed ? 1 : 0;
}
command('gzip', io => gzipCommand(io));
command('gunzip', io => gzipCommand(io, {decompress: true}));
command('zcat', io => gzipCommand(io, {decompress: true, toStdout: true}));

