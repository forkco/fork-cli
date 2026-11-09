import {ShellError} from './parse.js';
import {resolvePath, display} from './interpreter.js';
import {getopt, int, entryAt, command} from './commands.js';

// Media and PDF commands translate familiar argv into the runner's validated
// native jobs (file_tool and the inspection tools). Paths become logical /work
// paths here; options are validated again by the parent before any process runs.

const logical = (io, name) => resolvePath(io.cwd, name);
const relative = (io, path) => io.cwd && path.startsWith(io.cwd + '/') ? path.slice(io.cwd.length + 1) : display(path);

async function existingFile(io, name) {
  const {path, entry} = await entryAt(io, name);
  if (!entry) throw new ShellError(`${name}: No such file or directory`);
  if (entry.kind !== 'file') throw new ShellError(`${name}: Is a directory`);
  return path;
}

command('convert magick', async io => {
  let args = io.argv.slice(1);
  if (io.argv[0] === 'magick') {
    if (args[0] === 'convert') args = args.slice(1);
    else if (args[0] === 'identify') return io.shell.invoke(['identify', ...args.slice(1)], io);
    else if (['mogrify', 'compare', 'composite', 'montage', 'stream', 'import', 'display', 'animate', 'conjure'].includes(args[0])) throw new ShellError(`magick ${args[0]} is unavailable; use convert/identify`, 2);
  }
  if (args.length < 2 || args[0].startsWith('-')) throw new ShellError('usage: convert INPUT [OPTIONS] OUTPUT (input first; one PNG/JPEG/GIF/WebP frame)', 2);
  const input = await existingFile(io, args[0]);
  const output = logical(io, args[args.length - 1]);
  await io.vfs.tool({tool: 'image', inputs: [input], output, options: args.slice(1, -1), overwrite: true});
});

command('identify', async io => {
  const {opts, rest} = getopt(io.argv.slice(1).map(a => a === '-format' ? '--format' : a), {flags: 'q', values: 'f', long: {format: '=f'}});
  if (!rest.length) throw new ShellError('usage: identify [-format FORMAT] IMAGE...', 2);
  for (const name of rest) {
    const {stdout} = await io.vfs.inspect({tool: 'identify', input: await existingFile(io, name), ...(opts.f !== undefined ? {format: opts.f} : {})});
    io.out(stdout);
  }
});

command('ffmpeg', async io => {
  const args = io.argv.slice(1), options = [];
  let input = null, overwrite = false;
  for (let i = 0; i < args.length - 1; i++) {
    const arg = args[i];
    if (arg === '-y') overwrite = true;
    else if (arg === '-n') overwrite = false;
    else if (['-hide_banner', '-nostdin', '-stats', '-nostats'].includes(arg)) continue;
    else if (['-loglevel', '-v'].includes(arg)) i++;
    else if (arg === '-i') {
      if (input !== null) throw new ShellError('exactly one -i input is supported', 2);
      input = await existingFile(io, args[++i] ?? '');
    } else options.push(arg);
  }
  if (input === null || args.length < 3) throw new ShellError('usage: ffmpeg [-y] -i INPUT [OPTIONS] OUTPUT', 2);
  const output = logical(io, args[args.length - 1]);
  if (!overwrite && await io.vfs.stat(output)) throw new ShellError(`File '${args[args.length - 1]}' already exists (use -y to overwrite)`);
  const result = await io.vfs.tool({tool: 'ffmpeg', inputs: [input], output, options, overwrite: true});
  if (result?.stderr) io.err(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
});

command('ffprobe', async io => {
  const args = io.argv.slice(1);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (['-v', '-loglevel', '-of', '-print_format', '-show_entries', '-select_streams'].includes(args[i])) { i++; continue; }
    if (['-show_format', '-show_streams', '-hide_banner', '-pretty', '-show_error', '-i'].includes(args[i])) continue;
    if (args[i].startsWith('-')) throw new ShellError(`${args[i]}: unavailable; ffprobe always prints format and streams as JSON`, 2);
    files.push(args[i]);
  }
  if (files.length !== 1) throw new ShellError('usage: ffprobe FILE (prints format and streams as JSON)', 2);
  io.out((await io.vfs.inspect({tool: 'ffprobe', input: await existingFile(io, files[0])})).stdout);
});

const pageRange = opts => ({...(opts.f !== undefined ? {first: int(opts.f, 'first page', {min: 1})} : {}), ...(opts.l !== undefined ? {last: int(opts.l, 'last page', {min: 1})} : {})});

command('pdfinfo', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {values: 'fl'});
  if (rest.length !== 1) throw new ShellError('usage: pdfinfo [-f N -l N] FILE.pdf', 99);
  io.out((await io.vfs.inspect({tool: 'pdfinfo', input: await existingFile(io, rest[0]), ...pageRange(opts)})).stdout);
});

command('pdftotext', async io => {
  const args = io.argv.slice(1).map(a => ['-layout', '-raw', '-nopgbrk', '-enc'].includes(a) ? '-' + a : a);
  const {opts, rest} = getopt(args, {values: 'fl', long: {layout: 'layout', raw: 'raw', nopgbrk: 'nopgbrk', enc: '=enc'}});
  if (!rest.length || rest.length > 2) throw new ShellError('usage: pdftotext [-f N] [-l N] [-layout|-raw] FILE.pdf [OUTPUT.txt|-]', 99);
  if (opts.enc !== undefined && !/^utf-?8$/i.test(opts.enc)) throw new ShellError('only UTF-8 output is available', 99);
  const input = await existingFile(io, rest[0]);
  const target = rest[1] ?? (rest[0].replace(/\.pdf$/i, '') + '.txt');
  const request = {tool: 'pdftotext', input, ...pageRange(opts), ...(opts.layout ? {mode: 'layout'} : opts.raw ? {mode: 'raw'} : {})};
  if (target === '-') { io.out((await io.vfs.inspect(request)).stdout); return; }
  await io.vfs.inspect({...request, output: logical(io, target)});
});

command('pdftoppm', async io => {
  const args = io.argv.slice(1).map(a => ['-png', '-jpeg', '-singlefile', '-scale-to', '-r'].includes(a) ? '-' + a : a);
  const {opts, rest} = getopt(args, {values: 'fl', long: {png: 'png', jpeg: 'jpeg', singlefile: 'singlefile', 'scale-to': '=scale', r: '=r'}});
  if (rest.length !== 2) throw new ShellError('usage: pdftoppm [-f N] [-l N] [-png|-jpeg] [-r DPI|-scale-to PX] [-singlefile] FILE.pdf PREFIX', 99);
  const range = pageRange(opts);
  if (opts.singlefile) range.last = range.first ?? 1;
  const format = opts.jpeg ? 'jpeg' : 'png';
  const prefix = logical(io, rest[1]);
  const result = await io.vfs.inspect({tool: 'pdftoppm', input: await existingFile(io, rest[0]), format, prefix, ...range,
    ...(opts.r !== undefined ? {dpi: int(opts.r, 'resolution', {min: 10, max: 300})} : {}),
    ...(opts.scale !== undefined ? {scale: int(opts.scale, 'scale-to', {min: 16, max: 4096})} : {})});
  if (opts.singlefile && result.files?.length === 1) {
    const ext = format === 'png' ? 'png' : 'jpg';
    await io.vfs.rename(result.files[0].path.replace(/^\/work\//, ''), `${prefix}.${ext}`, true);
    io.err(`${relative(io, `${prefix}.${ext}`)}\n`);
  } else for (const file of result.files || []) io.err(relative(io, file.path.replace(/^\/work\//, '')) + '\n');
});

// ---- the open browser tab ----

command('page', async io => {
  const [what, ...rest] = io.argv.slice(1);
  const json = rest.includes('--json');
  const selector = rest.filter(a => a !== '--json')[0];
  switch (what) {
    case 'url': io.out(await io.vfs.page('url') + '\n'); return;
    case 'title': io.out(await io.vfs.page('title') + '\n'); return;
    case 'text': { const t = await io.vfs.page('text', selector); io.out(t.endsWith('\n') ? t : t + '\n'); return; }
    case 'html': io.out(await io.vfs.page('html', selector) + '\n'); return;
    case 'links': {
      const links = await io.vfs.page('links');
      io.out(json ? JSON.stringify(links, null, 2) + '\n' : links.map(l => l.href + (l.text ? '\t' + l.text : '')).join('\n') + (links.length ? '\n' : ''));
      return;
    }
    case 'tabs': {
      const tabs = await io.vfs.page('tabs');
      io.out(json ? JSON.stringify(tabs, null, 2) + '\n' : tabs.map(t => `${t.active ? '*' : ' '} ${t.tab_id}  ${t.url}  ${t.title}`).join('\n') + '\n');
      return;
    }
    default: throw new ShellError('usage: page url|title|text [SELECTOR]|html [SELECTOR]|links [--json]|tabs [--json]  (active tab of this session)', 2);
  }
});

command('resources', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'j', values: 't', long: {json: 'j', type: '=t'}});
  let list = await io.vfs.page('resources');
  if (opts.t) list = list.filter(r => r.type === opts.t);
  if (rest[0]) list = list.filter(r => r.url.includes(rest[0]));
  if (opts.j) { io.out(JSON.stringify(list, null, 2) + '\n'); return; }
  io.out(list.map(r => `${r.resource_id}  ${r.status}  ${r.type.padEnd(10)}  ${(r.mime_type.split(';')[0] || '-').padEnd(24)}  ${r.url}`).join('\n') + (list.length ? '\n' : ''));
});

command('resource', async io => {
  if (io.argv.length !== 2) throw new ShellError('usage: resource ID  (body of a loaded response; redirect it: resource ID > data.json)', 2);
  io.out(await io.vfs.page('resource', io.argv[1]));
});
