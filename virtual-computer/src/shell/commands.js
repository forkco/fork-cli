import {createHash} from 'node:crypto';
import {ShellError, globRegExp} from './parse.js';
import {resolvePath, display} from './interpreter.js';
import {detectType} from './filetype.js';
import {jq} from './jq.js';

// ---------- option parsing ----------

// flags: single-letter booleans; values: single letters taking an argument;
// long: {name: key} for booleans, {name: '=key'} for options with a value.
function getopt(args, {flags = '', values = '', long = {}} = {}) {
  const opts = {all: {}}, rest = [];
  const set = (key, value) => { opts[key] = value; (opts.all[key] ||= []).push(value); };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { rest.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('='), name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const key = long[name];
      if (key === undefined) throw new ShellError(`unrecognized option '--${name}'`, 2);
      if (key.startsWith('=')) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) throw new ShellError(`option '--${name}' requires an argument`, 2);
        set(key.slice(1), value);
      } else set(key, true);
      continue;
    }
    if (arg.length > 1 && arg[0] === '-') {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (values.includes(c)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) throw new ShellError(`option requires an argument -- '${c}'`, 2);
          set(c, value);
          break;
        }
        if (!flags.includes(c)) throw new ShellError(`invalid option -- '${c}'`, 2);
        set(c, true);
      }
      continue;
    }
    rest.push(arg);
  }
  return {opts, rest};
}

function int(value, name, {min = 0, max = 1e9} = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ShellError(`invalid ${name}: '${value}'`, 2);
  return n;
}

// ---------- io helpers ----------

const decode = buffer => buffer.toString('utf8');
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
const joinLines = lines => lines.length ? lines.join('\n') + '\n' : '';

// Operands as files; none or '-' read stdin.
async function* inputs(io, operands, {quiet = false} = {}) {
  if (!operands.length) operands = ['-'];
  for (const name of operands) {
    if (name === '-') { yield {name: '(standard input)', shown: '-', data: io.stdin()}; continue; }
    try { yield {name, shown: name, data: await io.vfs.read(resolvePath(io.cwd, name))}; }
    catch (error) {
      if (!(error instanceof ShellError)) throw error;
      if (!quiet) io.err(`${io.argv[0]}: ${name}: ${error.message.replace(/^\/work\S*: /, '')}\n`);
      io.failed = true;
    }
  }
}

async function allText(io, operands) {
  const parts = [];
  for await (const input of inputs(io, operands)) parts.push(input.data);
  return decode(Buffer.concat(parts));
}

const status = io => io.failed ? 1 : 0;

function human(bytes) {
  if (bytes < 1024) return String(bytes);
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes, unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)) + units[unit];
}

const time = ms => {
  const d = new Date(ms || 0);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

// ---------- regular expressions ----------

const POSIX = {alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', word: '\\w'};

// POSIX BRE/ERE to JavaScript. RE2-like linear time is not guaranteed in JS;
// the worker's deadline and memory cap bound pathological patterns.
function posixRegExp(pattern, {extended = false} = {}) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') { if (pattern[j] === '[' && pattern[j + 1] === ':') { const end = pattern.indexOf(':]', j + 2); j = end < 0 ? j + 1 : end + 2; } else j++; }
      let body = pattern.slice(i + 1, j);
      body = body.replace(/\[:([a-z]+):\]/g, (match, name) => POSIX[name] ?? match).replace(/\\/g, '\\\\');
      out += '[' + body.replace(/^\^?\]/, m => m.replace(']', '\\]')) + ']';
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[++i];
      if (n === '<' || n === '>') out += '\\b';
      else if (!extended && '(){}|+?'.includes(n)) out += n;
      else if (/[1-9]/.test(n) || 'wWsSbB'.includes(n)) out += '\\' + n;
      else if (n === 'n') out += '\\n';
      else if (n === 't') out += '\\t';
      else out += n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      continue;
    }
    if (!extended && '(){}|+?'.includes(c)) { out += '\\' + c; continue; }
    if (c === '/') { out += '\\/'; continue; }
    out += c;
  }
  return out;
}

function compile(source, flags) {
  try { return new RegExp(source, flags); }
  catch { throw new ShellError(`invalid regular expression: ${source}`, 2); }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ---------- commands ----------

export const commands = Object.create(null);
const command = (names, run) => { for (const name of names.split(' ')) commands[name] = run; };

const HELP = `Computer shell: works on this browser session's temporary files in /work.
Not an OS shell: built-in commands only, no network, no host files, no variables.

Files    ls [-laRhtS] tree [-L N] find (-name -iname -path -type -size -empty -maxdepth -mindepth
         -newer? no; -print -print0 -delete -exec CMD {} \\; | +) stat du [-sahb] file
         cp [-rn] mv [-n] rm [-rf] mkdir [-p] rmdir touch
Read     cat [-n] head/tail [-n N|-c N] wc [-lwcm] nl strings [-n N] xxd [-l -s -c -p]
         base64 [-d -w N] sha256sum sha1sum md5sum
Text     grep [-rinvclLohHqswxFEA B C m e f --include --exclude] sed [-n -E -i -e; s///gip d p q = a i c y]
         sort [-rnuhfb -k -t] uniq [-cdui] cut [-d -f -c -s] tr [-dsc] paste [-d -s] comm [-123]
         diff [-u -U N -q] rev seq echo [-ne] printf tee [-a] xargs [-n -I -0 -d -r]
Archives zip [-r -j -q -0..9] unzip [-l -o -n -p -j -d DIR -x PAT] tar [-c|-x|-t] [-z] [-v] -f FILE [-C DIR]
         gzip/gunzip/zcat [-c -k -f -l]  (links, devices, absolute and ../ names are skipped; 1000 entries)
Media    convert/magick IN [OPTS] OUT  identify [-format F]  ffmpeg [-y] -i IN [OPTS] OUT  ffprobe FILE (JSON)
         Same validated options as file_tool: one PNG/JPEG/GIF/WebP frame; ffmpeg fixed codecs and filters.
PDF      pdfinfo  pdftotext [-f N -l N -layout|-raw] FILE [OUT|-]  pdftoppm [-f N -l N -png|-jpeg -r DPI
         -scale-to PX -singlefile] FILE PREFIX  (at most 20 pages per call)
JSON     jq [-r -c -n -s -e -S -R -j --arg N V --argjson N J] FILTER [FILE]  (no def, input, env or modules)
Browser  page url|title|text [SEL]|html [SEL]|links|tabs  resources [-j] [-t TYPE] [URLPART]  resource ID
         (active tab of this session, read-only; resource bodies up to 2 MB)
SSH      ssh HOST COMMAND...   scp [HOST:]SRC [HOST:]DST   (HOST is a label from your SSH hosts; one command
         or one file per call, no interactive sessions; gated: positive balance, 15 connections/hour)
Web      download [-f] URL [PATH]  curl [-fsSLO -o FILE -H] URL  wget [-q -nv -O FILE -P DIR -nc -i FILE] URL
         Public GET only: no cookies or credentials, no private networks, ports 80/443, 10 MiB, 5 redirects,
         10 downloads per call. HTTP errors fail (curl exit 22, wget 8); response headers are not exposed.
Misc     pwd cd basename dirname true false exit help

Operators: | && || ; > >> < 2> 2>&1 &> /dev/null; globs * ? [..] over /work.
Downloads, attachments, run_code and file_tool share these files (max 200 files, 10 MiB each,
40 MiB per session). Paths: relative, or absolute under /work. Output over 64 KiB is cut: redirect
it to a file. Files are temporary; export_file saves one to the person's disk.
`;

command('help', io => { io.out(HELP); });
command('true', () => 0);
command('false', () => 1);
command('exit', io => {
  const code = io.argv[1] === undefined ? 0 : int(io.argv[1], 'exit status', {max: 255});
  io.shell.exitRequested = code;
  return code;
});
command('pwd', io => { io.out(display(io.cwd) + '\n'); });
command('cd', async io => {
  const target = resolvePath(io.cwd, io.argv[1] ?? '/work');
  const entry = await io.vfs.stat(target);
  if (entry?.kind !== 'dir') throw new ShellError(`${io.argv[1]}: No such directory`);
  io.shell.cwd = target;
});

// ---- echo / printf ----

function escapes(text, {stopAtC = false} = {}) {
  let out = '', stop = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\\' || i + 1 >= text.length) { out += c; continue; }
    const n = text[++i];
    const map = {n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\'};
    if (n in map) out += map[n];
    else if (n === 'c' && stopAtC) { stop = true; break; }
    else if (n === '0' || /[1-7]/.test(n)) {
      const digits = /^[0-7]{0,3}/.exec(text.slice(n === '0' ? i + 1 : i))[0];
      out += String.fromCharCode(parseInt(digits || '0', 8));
      i += digits.length - (n === '0' ? 0 : 1);
    } else if (n === 'x') {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 1))?.[0];
      if (hex) { out += String.fromCharCode(parseInt(hex, 16)); i += hex.length; } else out += '\\x';
    } else if (n === 'u') {
      const hex = /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 1))?.[0];
      if (hex) { out += String.fromCodePoint(parseInt(hex, 16)); i += hex.length; } else out += '\\u';
    } else out += '\\' + n;
  }
  return {text: out, stop};
}

command('echo', io => {
  let args = io.argv.slice(1), newline = true, interpret = false;
  while (args.length && /^-[neE]+$/.test(args[0])) {
    for (const c of args[0].slice(1)) { if (c === 'n') newline = false; if (c === 'e') interpret = true; if (c === 'E') interpret = false; }
    args = args.slice(1);
  }
  let text = args.join(' ');
  if (interpret) { const result = escapes(text, {stopAtC: true}); text = result.text; if (result.stop) newline = false; }
  io.out(text + (newline ? '\n' : ''));
});

function printf(format, args) {
  let out = '', index = 0;
  const next = () => args[index++] ?? '';
  const number = value => {
    if (value === '') return 0;
    if (/^['"]/.test(value)) return value.codePointAt(1) ?? 0;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new ShellError(`'${value}': invalid number`);
    return n;
  };
  do {
    const start = index;
    const {text: fmt} = escapes(format);
    out += fmt.replace(/%([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?([sdiouxXfFeEgGcb%])/g, (match, flags, width, precision, conv) => {
      if (conv === '%') return '%';
      if (width === '*') width = String(int(next(), 'width', {min: -1e6, max: 1e6}));
      if (precision === '*') precision = String(int(next(), 'precision'));
      let value;
      switch (conv) {
        case 's': value = String(next()); if (precision !== undefined) value = value.slice(0, Number(precision)); break;
        case 'b': value = escapes(String(next())).text; break;
        case 'c': value = String(next()).slice(0, 1); break;
        case 'd': case 'i': { const n = Math.trunc(number(next())); value = String(Math.abs(n)); if (precision) value = value.padStart(Number(precision), '0'); value = (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + value; break; }
        case 'u': value = String(Math.trunc(Math.abs(number(next())))); break;
        case 'o': value = Math.trunc(number(next())).toString(8); break;
        case 'x': value = Math.trunc(number(next())).toString(16); break;
        case 'X': value = Math.trunc(number(next())).toString(16).toUpperCase(); break;
        case 'f': case 'F': { const n = number(next()); value = n.toFixed(precision === undefined ? 6 : Number(precision)); if (n >= 0 && flags.includes('+')) value = '+' + value; break; }
        case 'e': case 'E': { value = number(next()).toExponential(precision === undefined ? 6 : Number(precision)).replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'E') value = value.toUpperCase(); break; }
        case 'g': case 'G': { value = String(Number(number(next()).toPrecision(precision === undefined ? 6 : Math.max(1, Number(precision))))); break; }
      }
      const w = Number(width || 0);
      if (Math.abs(w) > value.length) {
        if (flags.includes('-') || w < 0) value = value.padEnd(Math.abs(w));
        else if (flags.includes('0') && /[diouxXfFeEgG]/.test(conv)) {
          const sign = /^[-+ ]/.test(value) ? value[0] : '';
          value = sign + value.slice(sign.length).padStart(w - sign.length, '0');
        } else value = value.padStart(w);
      }
      return value;
    });
    if (index === start) break;
  } while (index < args.length);
  return out;
}

command('printf', io => {
  if (io.argv.length < 2) throw new ShellError('usage: printf FORMAT [ARGUMENT]...', 2);
  io.out(printf(io.argv[1], io.argv.slice(2)));
});

// ---- reading ----

command('cat', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'nbAsvET'});
  let n = 0;
  for await (const {data} of inputs(io, rest)) {
    if (!opts.n && !opts.b) { io.out(data); continue; }
    const text = decode(data), lines = text.split('\n');
    const last = lines.pop();
    let out = '';
    for (const line of lines) out += (opts.b && line === '' ? '' : String(++n).padStart(6) + '\t') + line + '\n';
    if (last) out += String(++n).padStart(6) + '\t' + last;
    io.out(out);
  }
  return status(io);
});

function headTailArgs(io) {
  const args = io.argv.slice(1).map((a, i, all) => ['-n', '-c', '--lines', '--bytes'].includes(all[i - 1]) ? a
    : /^-\d+$/.test(a) ? '-n' + a.slice(1) : /^\+\d+$/.test(a) && io.argv[0] === 'tail' ? '-n' + a : a);
  return getopt(args, {flags: 'qv', values: 'nc', long: {lines: '=n', bytes: '=c', quiet: 'q', silent: 'q', verbose: 'v'}});
}

command('head', async io => {
  const {opts, rest} = headTailArgs(io);
  const many = (rest.length > 1 && !opts.q) || opts.v;
  let first = true;
  for await (const {shown, data} of inputs(io, rest)) {
    if (many) io.out((first ? '' : '\n') + `==> ${shown === '-' ? 'standard input' : shown} <==\n`);
    first = false;
    if (opts.c !== undefined) {
      const n = Number(opts.c);
      if (!Number.isInteger(n)) throw new ShellError(`invalid number of bytes: '${opts.c}'`, 2);
      io.out(n >= 0 ? data.subarray(0, n) : data.subarray(0, Math.max(0, data.length + n)));
      continue;
    }
    const n = opts.n === undefined ? 10 : Number(opts.n);
    if (!Number.isInteger(n)) throw new ShellError(`invalid number of lines: '${opts.n}'`, 2);
    const text = decode(data), lines = text.split('\n');
    const ended = text.endsWith('\n');
    if (ended) lines.pop();
    const chosen = n >= 0 ? lines.slice(0, n) : lines.slice(0, Math.max(0, lines.length + n));
    io.out(chosen.join('\n') + (chosen.length && (ended || chosen.length < lines.length) ? '\n' : ''));
  }
  return status(io);
});

command('tail', async io => {
  const {opts, rest} = headTailArgs(io);
  const many = (rest.length > 1 && !opts.q) || opts.v;
  let first = true;
  for await (const {shown, data} of inputs(io, rest)) {
    if (many) io.out((first ? '' : '\n') + `==> ${shown === '-' ? 'standard input' : shown} <==\n`);
    first = false;
    if (opts.c !== undefined) {
      const from = String(opts.c).startsWith('+');
      const n = int(String(opts.c).replace(/^[+-]/, ''), 'number of bytes');
      io.out(from ? data.subarray(Math.max(0, n - 1)) : data.subarray(Math.max(0, data.length - n)));
      continue;
    }
    const raw = opts.n === undefined ? '10' : String(opts.n), from = raw.startsWith('+');
    const n = int(raw.replace(/^[+-]/, ''), 'number of lines');
    const text = decode(data), lines = text.split('\n'), ended = text.endsWith('\n');
    if (ended) lines.pop();
    const chosen = from ? lines.slice(Math.max(0, n - 1)) : n === 0 ? [] : lines.slice(-n);
    io.out(chosen.join('\n') + (chosen.length && ended ? '\n' : ''));
  }
  return status(io);
});

command('wc', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'lwcm', long: {lines: 'l', words: 'w', bytes: 'c', chars: 'm'}});
  const picked = ['l', 'w', 'm', 'c'].filter(k => opts[k]);
  const columns = picked.length ? picked : ['l', 'w', 'c'];
  const rows = [], total = {l: 0, w: 0, c: 0, m: 0};
  for await (const {shown, data} of inputs(io, rest)) {
    const text = decode(data);
    const row = {l: data.filter(b => b === 10).length, w: (text.match(/\S+/g) || []).length, c: data.length, m: [...text].length};
    for (const k in total) total[k] += row[k];
    rows.push([row, rest.length ? shown : '']);
  }
  if (rows.length > 1) rows.push([total, 'total']);
  const width = rows.length === 1 && columns.length === 1 ? 0 : Math.max(1, ...rows.flatMap(([r]) => columns.map(k => String(r[k]).length)));
  for (const [row, name] of rows) io.out(columns.map(k => String(row[k]).padStart(width)).join(' ') + (name ? ' ' + name : '') + '\n');
  return status(io);
});

command('nl', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {values: 'bws'});
  const all = opts.b === 'a', width = opts.w ? int(opts.w, 'width', {min: 1, max: 20}) : 6, sep = opts.s ?? '\t';
  let n = 0;
  const lines = splitLines(await allText(io, rest));
  io.out(joinLines(lines.map(line => (all || line.trim() !== '' ? String(++n).padStart(width) + sep : ''.padStart(width) + ' ') + line)));
  return status(io);
});

command('rev', async io => {
  io.out(joinLines(splitLines(await allText(io, io.argv.slice(1))).map(line => [...line].reverse().join(''))));
  return status(io);
});

command('strings', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {values: 'n'});
  const min = opts.n ? int(opts.n, 'length', {min: 1, max: 1000}) : 4;
  for await (const {data} of inputs(io, rest)) {
    let run = [];
    const lines = [];
    const flush = () => { if (run.length >= min) lines.push(Buffer.from(run).toString('latin1')); run = []; };
    for (const byte of data) { if ((byte >= 32 && byte < 127) || byte === 9) run.push(byte); else flush(); }
    flush();
    io.out(joinLines(lines));
  }
  return status(io);
});

command('xxd', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'pu', values: 'lsc'});
  const offset = opts.s ? int(opts.s, 'offset') : 0, length = opts.l ? int(opts.l, 'length') : Infinity;
  const cols = opts.c ? int(opts.c, 'columns', {min: 1, max: 256}) : opts.p ? 30 : 16;
  for await (const {data} of inputs(io, rest.slice(0, 1))) {
    const bytes = data.subarray(offset, offset + length);
    let out = '';
    for (let i = 0; i < bytes.length; i += cols) {
      const row = bytes.subarray(i, i + cols);
      let hex = row.toString('hex');
      if (opts.u) hex = hex.toUpperCase();
      if (opts.p) { out += hex + '\n'; continue; }
      const groups = hex.match(/.{1,4}/g).join(' ');
      const width = Math.ceil(cols / 2) * 5 - 1;
      out += (offset + i).toString(16).padStart(8, '0') + ': ' + groups.padEnd(width) + '  ' + [...row].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('') + '\n';
    }
    io.out(out);
  }
  return status(io);
});

command('base64', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'di', values: 'w', long: {decode: 'd', wrap: '=w', 'ignore-garbage': 'i'}});
  const parts = [];
  for await (const input of inputs(io, rest.slice(0, 1))) parts.push(input.data);
  const data = Buffer.concat(parts);
  if (opts.d) {
    const text = decode(data).replace(opts.i ? /[^A-Za-z0-9+/=_-]/g : /\s/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new ShellError('invalid input');
    io.out(Buffer.from(text, 'base64'));
  } else {
    const wrap = opts.w === undefined ? 76 : int(opts.w, 'wrap');
    const encoded = data.toString('base64');
    io.out((wrap ? encoded.match(new RegExp(`.{1,${wrap}}`, 'g'))?.join('\n') ?? '' : encoded) + '\n');
  }
  return status(io);
});

for (const [name, algorithm] of [['sha256sum', 'sha256'], ['sha1sum', 'sha1'], ['md5sum', 'md5'], ['sha512sum', 'sha512']]) {
  command(name, async io => {
    const {rest} = getopt(io.argv.slice(1), {flags: 'bt'});
    for await (const {shown, data} of inputs(io, rest)) io.out(createHash(algorithm).update(data).digest('hex') + '  ' + shown + '\n');
    return status(io);
  });
}

// ---- grep ----

command('grep egrep fgrep', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'ivnclLrRhHoqswxFEPaIz', values: 'eABCmf',
    long: {include: '=include', exclude: '=exclude', 'exclude-dir': '=exclude-dir', color: '=color', colour: '=color',
      'ignore-case': 'i', 'invert-match': 'v', 'line-number': 'n', count: 'c', 'files-with-matches': 'l', 'files-without-match': 'L',
      recursive: 'r', 'only-matching': 'o', quiet: 'q', silent: 'q', 'no-messages': 's', 'word-regexp': 'w', 'line-regexp': 'x',
      'fixed-strings': 'F', 'extended-regexp': 'E', 'perl-regexp': 'P', text: 'a', 'max-count': '=m', context: '=C',
      'after-context': '=A', 'before-context': '=B', 'no-filename': 'h', 'with-filename': 'H', regexp: '=e', file: '=f'}});
  if (io.argv[0] === 'egrep') opts.E = true;
  if (io.argv[0] === 'fgrep') opts.F = true;
  let patterns = opts.all.e ? [...opts.all.e] : [];
  for (const file of opts.all.f || []) patterns.push(...splitLines(decode(await io.vfs.read(resolvePath(io.cwd, file)))));
  if (!opts.all.e && !opts.all.f) {
    if (!rest.length) throw new ShellError('usage: grep [OPTION]... PATTERNS [FILE]...', 2);
    patterns = rest.shift().split('\n');
  }
  const extended = opts.E || opts.P;
  let source = patterns.map(p => opts.F ? escapeRegExp(p) : posixRegExp(p, {extended})).map(p => `(?:${p})`).join('|') || '(?:)';
  if (opts.w) source = `(?<![\\w])(?:${source})(?![\\w])`;
  if (opts.x) source = `^(?:${source})$`;
  const regexp = compile(source, 'g' + (opts.i ? 'i' : ''));
  const after = Number(opts.A ?? opts.C ?? 0), before = Number(opts.B ?? opts.C ?? 0);
  if (![after, before].every(Number.isInteger)) throw new ShellError('invalid context length', 2);
  const max = opts.m !== undefined ? int(opts.m, 'max count') : Infinity;
  const recursive = opts.r || opts.R;
  const include = (opts.all.include || []).map(g => globRegExp(g)), exclude = (opts.all.exclude || []).map(g => globRegExp(g));
  const excludeDir = (opts.all['exclude-dir'] || []).map(g => globRegExp(g));
  const keep = name => (!include.length || include.some(r => r.test(name))) && !exclude.some(r => r.test(name));

  // Expand recursive operands to files.
  let targets = [];
  if (recursive) {
    for (const operand of rest.length ? rest : ['.']) {
      if (operand === '-') { targets.push('-'); continue; }
      let path;
      try { path = resolvePath(io.cwd, operand); } catch (error) { io.err(`grep: ${error.message}\n`); io.failed = true; continue; }
      const entry = await io.vfs.stat(path);
      if (!entry) { if (!opts.s) io.err(`grep: ${operand}: No such file or directory\n`); io.failed = true; continue; }
      if (entry.kind === 'file') { targets.push(operand); continue; }
      const prefix = operand.replace(/\/+$/, '');
      await io.vfs.walk(path, child => {
        if (child.kind === 'dir') return !excludeDir.some(r => r.test(child.name));
        if (keep(child.name)) targets.push((prefix === '.' && !rest.length ? '' : prefix + '/') + child.path.slice(path ? path.length + 1 : 0));
      });
    }
  } else {
    targets = rest.length ? rest : ['-'];
    targets = targets.filter(t => t === '-' || keep(t.split('/').pop()));
  }
  const names = opts.H || (!opts.h && (recursive || targets.length > 1));
  let matched = false;
  for (const target of targets) {
    let data;
    if (target === '-') data = io.stdin();
    else {
      let path, entry;
      try { path = resolvePath(io.cwd, target); entry = await io.vfs.stat(path); } catch (error) { io.err(`grep: ${error.message}\n`); io.failed = true; continue; }
      if (entry?.kind === 'dir') { if (!opts.s) io.err(`grep: ${target}: Is a directory\n`); continue; }
      try { data = await io.vfs.read(path); }
      catch (error) { if (!(error instanceof ShellError)) throw error; if (!opts.s) io.err(`grep: ${target}: ${error.message.replace(/^\/work\S*: /, '')}\n`); io.failed = true; continue; }
    }
    const shown = target === '-' ? '(standard input)' : target;
    const binary = !opts.a && data.subarray(0, 8192).includes(0);
    if (binary && opts.I) continue;
    const lines = splitLines(decode(data));
    let count = 0, lastPrinted = -1, pendingAfter = 0, anyPrinted = false;
    const prefix = (i, sep) => (names ? shown + sep : '') + (opts.n ? (i + 1) + sep : '');
    for (let i = 0; i < lines.length && count < max; i++) {
      regexp.lastIndex = 0;
      const hit = regexp.test(lines[i]) !== Boolean(opts.v);
      if (!hit) {
        if (pendingAfter > 0 && !opts.c && !opts.l && !opts.L && !opts.q && !binary && !opts.o) { io.out(prefix(i, '-') + lines[i] + '\n'); lastPrinted = i; pendingAfter--; }
        continue;
      }
      count++; matched = true;
      if (opts.q) return 0;
      if (opts.c || opts.l || opts.L || binary) continue;
      if (before || after) {
        const from = Math.max(lastPrinted + 1, i - before);
        if (anyPrinted && from > lastPrinted + 1) io.out('--\n');
        for (let j = from; j < i; j++) io.out(prefix(j, '-') + lines[j] + '\n');
      }
      if (opts.o && !opts.v) {
        regexp.lastIndex = 0;
        for (const match of lines[i].matchAll(regexp)) if (match[0]) io.out(prefix(i, ':') + match[0] + '\n');
      } else io.out(prefix(i, ':') + lines[i] + '\n');
      lastPrinted = i; anyPrinted = true; pendingAfter = after;
    }
    if (opts.c) io.out((names ? shown + ':' : '') + count + '\n');
    else if (opts.l && count) io.out(shown + '\n');
    else if (opts.L && !count) io.out(shown + '\n');
    else if (binary && count) io.out(`Binary file ${shown} matches\n`);
  }
  if (opts.L) return io.failed ? 2 : 0;
  return matched ? 0 : io.failed && !opts.s ? 2 : 1;
});

// ---- sed ----

function sedSplit(text, start, delimiter) {
  let out = '', i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] === delimiter) { out += delimiter; i++; continue; }
      if (text[i + 1] === 'n' && delimiter !== 'n') { out += '\\n'; i++; continue; }
      out += c + text[++i]; continue;
    }
    if (c === delimiter) return {part: out, end: i};
    if (c === '\n') break;
    out += c;
  }
  throw new ShellError(`unterminated address or command near '${text.slice(start - 1, start + 20)}'`);
}

function sedReplacement(template) {
  const parts = [];
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '\\' && i + 1 < template.length) {
      const n = template[++i];
      if (/[0-9]/.test(n)) parts.push({group: Number(n)});
      else if (n === 'n') parts.push('\n');
      else if (n === 't') parts.push('\t');
      else parts.push(n);
    } else if (c === '&') parts.push({group: 0});
    else parts.push(c);
  }
  return (match, groups) => parts.map(p => typeof p === 'string' ? p : p.group === 0 ? match : groups[p.group - 1] ?? '').join('');
}

function sedProgram(script, extended) {
  const program = [];
  let i = 0;
  const regex = (source, flags = '') => compile(posixRegExp(source, {extended}), flags);
  const address = () => {
    if (/\d/.test(script[i] || '')) { const n = /^\d+/.exec(script.slice(i))[0]; i += n.length; return {line: Number(n)}; }
    if (script[i] === '$') { i++; return {last: true}; }
    if (script[i] === '/' || script[i] === '\\') {
      const delimiter = script[i] === '\\' ? script[++i] : '/';
      const {part, end} = sedSplit(script, i + 1, delimiter);
      i = end + 1;
      let flags = '';
      if (script[i] === 'I') { flags = 'i'; i++; }
      return {regexp: regex(part, flags)};
    }
    return null;
  };
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
    if (i >= script.length) break;
    if (script[i] === '#') { while (i < script.length && script[i] !== '\n') i++; continue; }
    const entry = {from: address(), to: null, negate: false, active: false};
    if (entry.from && script[i] === ',') { i++; entry.to = address(); if (!entry.to) throw new ShellError('unexpected `,\''); }
    while (script[i] === ' ') i++;
    if (script[i] === '!') { entry.negate = true; i++; while (script[i] === ' ') i++; }
    const name = script[i++];
    entry.name = name;
    if (name === 's') {
      const delimiter = script[i];
      if (!delimiter || delimiter === '\n' || delimiter === '\\') throw new ShellError('unterminated `s\' command');
      const pattern = sedSplit(script, i + 1, delimiter);
      const replacement = sedSplit(script, pattern.end + 1, delimiter);
      i = replacement.end + 1;
      let global = false, ignore = false, print = false, nth = 1;
      while (i < script.length && /[gIipM0-9]/.test(script[i])) {
        const f = script[i];
        if (f === 'g') global = true; else if (f === 'i' || f === 'I') ignore = true; else if (f === 'p') print = true;
        else if (/\d/.test(f)) { const n = /^\d+/.exec(script.slice(i))[0]; nth = Number(n); i += n.length - 1; }
        i++;
      }
      if (script[i] === 'w') throw new ShellError('the w flag is unavailable; redirect output instead');
      const compiled = regex(pattern.part, 'g' + (ignore ? 'i' : ''));
      const groups = new RegExp(compiled.source + '|').exec('').length - 1;
      Object.assign(entry, {regexp: compiled, groups, replace: sedReplacement(replacement.part), global, print, nth});
    } else if (name === 'y') {
      const delimiter = script[i];
      const a = sedSplit(script, i + 1, delimiter), b = sedSplit(script, a.end + 1, delimiter);
      i = b.end + 1;
      const from = [...escapes(a.part).text], to = [...escapes(b.part).text];
      if (from.length !== to.length) throw new ShellError('strings for `y\' command are different lengths');
      entry.map = new Map(from.map((c, k) => [c, to[k]]));
    } else if ('aic'.includes(name)) {
      if (script[i] === '\\') i++;
      if (script[i] === '\n') i++;
      while (script[i] === ' ') i++;
      let end = script.indexOf('\n', i);
      if (end < 0) end = script.length;
      entry.text = escapes(script.slice(i, end)).text;
      i = end;
    } else if ('dpqQ=nNlhHgGx'.includes(name)) {
      if ('qQ'.includes(name)) { const n = /^\s*\d+/.exec(script.slice(i)); if (n) { entry.code = Number(n[0]); i += n[0].length; } }
      if (!'dpqQ='.includes(name)) throw new ShellError(`the \`${name}' command is unavailable; supported: s y d p q Q = a i c`);
    } else if (name === '{' || name === '}') throw new ShellError('command blocks are unavailable');
    else throw new ShellError(`unknown command: \`${name ?? ''}'`);
    program.push(entry);
  }
  return program;
}

function sedRun(program, lines, {quiet}) {
  const out = [];
  let quitCode = null;
  const matches = (addr, line, n, last) => addr.line !== undefined ? n === addr.line : addr.last ? last : (addr.regexp.lastIndex = 0, addr.regexp.test(line));
  for (let index = 0; index < lines.length && quitCode === null; index++) {
    let space = lines[index], deleted = false, printed = false;
    const n = index + 1, last = index === lines.length - 1;
    const append = [];
    for (const entry of program) {
      let selected;
      if (!entry.from) selected = true;
      else if (!entry.to) selected = matches(entry.from, space, n, last);
      else if (entry.active) {
        selected = true;
        if (entry.to.line !== undefined ? n >= entry.to.line : matches(entry.to, space, n, last)) entry.active = false;
      } else if (matches(entry.from, space, n, last)) {
        selected = true;
        entry.active = !(entry.to.line !== undefined && entry.to.line <= n);
      } else selected = false;
      if (selected === entry.negate) continue;
      switch (entry.name) {
        case 's': {
          let k = 0, changed = false;
          entry.regexp.lastIndex = 0;
          space = space.replace(entry.regexp, (match, ...rest) => {
            const groups = rest.slice(0, entry.groups);
            k++;
            if (k < entry.nth || (!entry.global && k > entry.nth)) return match;
            changed = true;
            return entry.replace(match, groups);
          });
          if (changed && entry.print) out.push(space);
          break;
        }
        case 'y': space = [...space].map(c => entry.map.get(c) ?? c).join(''); break;
        case 'd': deleted = true; break;
        case 'p': out.push(space); break;
        case '=': out.push(String(n)); break;
        case 'a': append.push(entry.text); break;
        case 'i': out.push(entry.text); break;
        case 'c': if (!entry.to || !entry.active) out.push(entry.text); deleted = true; break;
        case 'q': quitCode = entry.code ?? 0; break;
        case 'Q': quitCode = entry.code ?? 0; deleted = true; printed = true; break;
      }
      if (deleted || quitCode !== null) break;
    }
    if (!deleted && !quiet && !printed) out.push(space);
    out.push(...append);
  }
  return {lines: out, quitCode};
}

command('sed', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'nErsiz', values: 'ef', long: {quiet: 'n', silent: 'n', 'regexp-extended': 'E', 'in-place': 'i', expression: '=e', file: '=f', separate: 's'}});
  const scripts = [...(opts.all.e || [])];
  for (const file of opts.all.f || []) scripts.push(decode(await io.vfs.read(resolvePath(io.cwd, file))));
  if (!scripts.length) {
    if (!rest.length) throw new ShellError('usage: sed [-n] [-E] [-i] SCRIPT [FILE]...', 2);
    scripts.push(rest.shift());
  }
  const extended = opts.E || opts.r;
  const program = () => sedProgram(scripts.join('\n'), extended);
  if (opts.i) {
    if (!rest.length) throw new ShellError('-i requires a file', 2);
    for (const name of rest) {
      const path = resolvePath(io.cwd, name);
      const text = decode(await io.vfs.read(path));
      const {lines} = sedRun(program(), splitLines(text), {quiet: opts.n});
      await io.vfs.write(path, joinLines(lines).slice(0, text.endsWith('\n') || !text ? undefined : -1), true);
    }
    return 0;
  }
  if (opts.s && rest.length > 1) {
    for await (const {data} of inputs(io, rest)) io.out(joinLines(sedRun(program(), splitLines(decode(data)), {quiet: opts.n}).lines));
    return status(io);
  }
  const text = await allText(io, rest);
  const {lines, quitCode} = sedRun(program(), splitLines(text), {quiet: opts.n});
  let out = joinLines(lines);
  if (text && !text.endsWith('\n') && quitCode === null && out.endsWith('\n')) out = out.slice(0, -1);
  io.out(out);
  return quitCode ?? status(io);
});

// ---- sort / uniq / cut / tr / paste / comm ----

function parseKeys(specs) {
  return specs.map(spec => {
    const match = /^(\d+)(?:\.(\d+))?([bfnrhV]*)(?:,(\d+)(?:\.(\d+))?([bfnrhV]*))?$/.exec(spec);
    if (!match || match[1] === '0') throw new ShellError(`invalid key: ${spec}`, 2);
    return {from: Number(match[1]), fromChar: Number(match[2] || 1), to: match[4] ? Number(match[4]) : null, toChar: match[5] ? Number(match[5]) : 0, flags: (match[3] || '') + (match[6] || '')};
  });
}

const humanNumber = text => {
  const match = /^\s*([-+]?\d*\.?\d+)\s*([KMGTPE]?)/i.exec(text);
  if (!match) return 0;
  return Number(match[1]) * 1024 ** ' KMGTPE'.indexOf((match[2] || ' ').toUpperCase());
};
const leadingNumber = text => { const match = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/.exec(text); return match ? Number(match[1]) : 0; };
const natural = (a, b) => a.localeCompare(b, 'en', {numeric: true});

command('sort', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'rnuhfbVsMgc', values: 'kto', long: {reverse: 'r', 'numeric-sort': 'n', unique: 'u', 'human-numeric-sort': 'h', 'ignore-case': 'f', 'version-sort': 'V', key: '=k', 'field-separator': '=t', stable: 's', 'general-numeric-sort': 'g'}});
  if (opts.o) throw new ShellError('-o is unavailable; redirect output with >', 2);
  if (opts.t !== undefined && [...opts.t].length !== 1) throw new ShellError('the separator must be a single character', 2);
  const keys = parseKeys(opts.all.k || []);
  const fields = line => opts.t !== undefined ? line.split(opts.t) : line.trim().split(/\s+/);
  const extract = (line, key) => {
    const f = fields(line);
    if (key.to === null) return f.slice(key.from - 1).join(opts.t ?? ' ').slice(key.fromChar - 1);
    let value = f.slice(key.from - 1, key.to).join(opts.t ?? ' ');
    if (key.toChar) value = value.slice(0, value.length - (f[key.to - 1]?.length ?? 0) + key.toChar);
    return value.slice(key.fromChar - 1);
  };
  const compareWith = flags => (a, b) => {
    if (flags.includes('b')) { a = a.trimStart(); b = b.trimStart(); }
    if (flags.includes('f')) { a = a.toUpperCase(); b = b.toUpperCase(); }
    if (flags.includes('n') || flags.includes('g')) return leadingNumber(a) - leadingNumber(b);
    if (flags.includes('h')) return humanNumber(a) - humanNumber(b);
    if (flags.includes('V')) return natural(a, b);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const global = ['b', 'f', 'n', 'g', 'h', 'V'].filter(k => opts[k]).join('');
  const compare = (a, b) => {
    for (const key of keys) {
      const flags = key.flags.replace('r', '') || global;
      let result = compareWith(flags)(extract(a, key), extract(b, key));
      if (key.flags.includes('r')) result = -result;
      if (result) return result;
    }
    if (!keys.length) { const result = compareWith(global)(a, b); if (result) return result; }
    return 0;
  };
  const lines = splitLines(await allText(io, rest));
  if (opts.c) {
    for (let i = 1; i < lines.length; i++) {
      const order = compare(lines[i - 1], lines[i]) * (opts.r ? -1 : 1);
      if (order > 0 || (opts.u && order === 0)) { io.err(`sort: -:${i + 1}: disorder: ${lines[i]}\n`); return 1; }
    }
    return 0;
  }
  const order = (a, b) => {
    let result = compare(a, b);
    if (opts.r) result = -result;
    if (result || opts.s || opts.u) return result;
    return opts.r ? (a < b ? 1 : a > b ? -1 : 0) : (a < b ? -1 : a > b ? 1 : 0);
  };
  lines.sort(order);
  io.out(joinLines(opts.u ? lines.filter((line, i) => i === 0 || compare(lines[i - 1], line) !== 0) : lines));
  return status(io);
});

command('uniq', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'cdui', values: 'fs', long: {count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i', 'skip-fields': '=f', 'skip-chars': '=s'}});
  if (rest.length > 1) throw new ShellError('an output file is unavailable; redirect output with >', 2);
  const skipFields = opts.f ? int(opts.f, 'fields') : 0, skipChars = opts.s ? int(opts.s, 'chars') : 0;
  const key = line => {
    let value = line;
    for (let k = 0; k < skipFields; k++) value = value.replace(/^\s*\S+/, '');
    value = value.slice(skipChars);
    return opts.i ? value.toLowerCase() : value;
  };
  const lines = splitLines(await allText(io, rest)), out = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && key(lines[j]) === key(lines[i])) j++;
    const n = j - i;
    if ((!opts.d || n > 1) && (!opts.u || n === 1)) out.push(opts.c ? String(n).padStart(7) + ' ' + lines[i] : lines[i]);
    i = j;
  }
  io.out(joinLines(out));
  return status(io);
});

function ranges(list) {
  return list.split(',').map(part => {
    const match = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!match || (!match[1] && !match[3]) || match[1] === '0') throw new ShellError(`invalid field list: ${list}`, 2);
    const from = match[1] ? Number(match[1]) : 1, to = match[2] ? (match[3] ? Number(match[3]) : Infinity) : from;
    return [from, to];
  });
}
const inRanges = (list, n) => list.some(([from, to]) => n >= from && n <= to);

command('cut', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'sn', values: 'dfcb', long: {delimiter: '=d', fields: '=f', characters: '=c', bytes: '=b', 'only-delimited': 's', 'output-delimiter': '=output-delimiter'}});
  const lines = splitLines(await allText(io, rest));
  if (opts.f) {
    const delimiter = opts.d ?? '\t';
    if ([...delimiter].length !== 1) throw new ShellError('the delimiter must be a single character', 2);
    const list = ranges(opts.f), out = opts['output-delimiter'] ?? delimiter;
    io.out(joinLines(lines.flatMap(line => {
      if (!line.includes(delimiter)) return opts.s ? [] : [line];
      return [line.split(delimiter).filter((_, i) => inRanges(list, i + 1)).join(out)];
    })));
  } else if (opts.c || opts.b) {
    const list = ranges(opts.c || opts.b);
    io.out(joinLines(lines.map(line => [...line].filter((_, i) => inRanges(list, i + 1)).join(opts['output-delimiter'] ?? ''))));
  } else throw new ShellError('you must specify a list of bytes, characters, or fields', 2);
  return status(io);
});

function trSet(spec) {
  const out = [];
  const chars = [...escapes(spec.replace(/\\-/g, '\x00DASH\x00')).text.replace(/\x00DASH\x00/g, '\x01')];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '[' && chars[i + 1] === ':') {
      const end = chars.indexOf(']', i + 2);
      const name = chars.slice(i + 2, end - 1).join('');
      if (end > 0 && chars[end - 1] === ':') {
        const set = {alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \t\n\r\f\v', blank: ' \t',
          punct: '!-/:-@[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\x00-\x1f\x7f'}[name];
        if (set === undefined) throw new ShellError(`invalid character class '${name}'`, 2);
        out.push(...trSet(set));
        i = end; continue;
      }
    }
    if (chars[i + 1] === '-' && i + 2 < chars.length) {
      const from = chars[i].codePointAt(0), to = chars[i + 2].codePointAt(0);
      if (to < from) throw new ShellError(`range-endpoints of '${chars[i]}-${chars[i + 2]}' are in reverse collating sequence order`, 2);
      if (to - from > 65536) throw new ShellError('range is too large', 2);
      for (let c = from; c <= to; c++) out.push(String.fromCodePoint(c));
      i += 2; continue;
    }
    out.push(chars[i] === '\x01' ? '-' : chars[i]);
  }
  return out;
}

command('tr', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'dscC', long: {delete: 'd', 'squeeze-repeats': 's', complement: 'c'}});
  if (!rest.length || rest.length > 2) throw new ShellError('usage: tr [-dsc] SET1 [SET2]', 2);
  const set1 = new Set(trSet(rest[0])), list1 = trSet(rest[0]), list2 = rest[1] !== undefined ? trSet(rest[1]) : [];
  const complement = opts.c || opts.C;
  const inSet1 = c => set1.has(c) !== Boolean(complement);
  const text = [...decode(io.stdin())];
  let out = [];
  if (opts.d) out = text.filter(c => !inSet1(c));
  else if (list2.length) {
    const map = new Map();
    if (!complement) list1.forEach((c, i) => map.set(c, list2[Math.min(i, list2.length - 1)]));
    out = text.map(c => complement ? (inSet1(c) ? list2[list2.length - 1] : c) : map.get(c) ?? c);
  } else out = text;
  if (opts.s) {
    const squeeze = new Set(opts.d || list2.length ? list2 : list1);
    out = out.filter((c, i) => !(i > 0 && c === out[i - 1] && (list2.length || opts.d ? squeeze.has(c) : inSet1(c))));
  } else if (!opts.d && !list2.length) throw new ShellError('missing operand after SET1', 2);
  io.out(out.join(''));
});

command('paste', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 's', values: 'd', long: {serial: 's', delimiters: '=d'}});
  const delimiters = [...escapes(opts.d ?? '\t').text];
  const files = [];
  for await (const {data} of inputs(io, rest)) files.push(splitLines(decode(data)));
  const join = cells => cells.reduce((acc, cell, i) => i === 0 ? cell : acc + (delimiters.length ? delimiters[(i - 1) % delimiters.length] : '') + cell, '');
  if (opts.s) io.out(joinLines(files.map(join)));
  else {
    const rows = Math.max(0, ...files.map(f => f.length));
    io.out(joinLines(Array.from({length: rows}, (_, r) => join(files.map(f => f[r] ?? '')))));
  }
  return status(io);
});

command('comm', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: '123'});
  if (rest.length !== 2) throw new ShellError('usage: comm [-123] FILE1 FILE2', 2);
  const texts = [];
  for await (const {data} of inputs(io, rest)) texts.push(splitLines(decode(data)));
  if (texts.length !== 2) return 1;
  const [left, right] = texts, out = [];
  const column = (n, line) => { if (!opts[n]) out.push('\t'.repeat([1, 2, 3].slice(0, n - 1).filter(k => !opts[k]).length) + line); };
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length || (i < left.length && left[i] < right[j])) column(1, left[i++]);
    else if (i >= left.length || right[j] < left[i]) column(2, right[j++]);
    else { column(3, left[i]); i++; j++; }
  }
  io.out(joinLines(out));
  return status(io);
});

// ---- diff (Myers) ----

const MAX_EDITS = 2000;
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops = [];
        let cx = n, cy = m;
        for (let step = d; step > 0; step--) {
          const saved = trace[step], get = kk => saved[kk + step + 1];
          const ck = cx - cy;
          const prevK = (ck === -step || (ck !== step && get(ck - 1) < get(ck + 1))) ? ck + 1 : ck - 1;
          const prevX = get(prevK), prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) { ops.push([' ', a[cx - 1]]); cx--; cy--; }
          if (prevK === ck + 1) ops.push(['+', b[cy - 1]]); else ops.push(['-', a[cx - 1]]);
          cx = prevX; cy = prevY;
        }
        while (cx > 0 && cy > 0) { ops.push([' ', a[cx - 1]]); cx--; cy--; }
        return ops.reverse();
      }
    }
  }
  return [];
}

function unified(ops, context) {
  const out = [];
  let i = 0;
  const lineAt = [];
  let la = 0, lb = 0;
  for (const [type] of ops) { lineAt.push([la, lb]); if (type !== '+') la++; if (type !== '-') lb++; }
  while (i < ops.length) {
    while (i < ops.length && ops[i][0] === ' ') i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') { end++; continue; }
      let run = end;
      while (run < ops.length && ops[run][0] === ' ') run++;
      if (run >= ops.length || run - end > 2 * context) { end = Math.min(ops.length, end + context); break; }
      end = run;
    }
    const hunk = ops.slice(start, end);
    const [a0, b0] = lineAt[start];
    const aLen = hunk.filter(([t]) => t !== '+').length, bLen = hunk.filter(([t]) => t !== '-').length;
    const range = (from, len) => (len === 0 ? from : from + 1) + (len === 1 ? '' : ',' + len);
    out.push(`@@ -${range(a0, aLen)} +${range(b0, bLen)} @@`);
    for (const [type, line] of hunk) out.push(type + line);
    i = end;
  }
  return out;
}

command('diff', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'uqswiBN', values: 'U', long: {unified: 'u', brief: 'q', 'ignore-all-space': 'w', 'ignore-case': 'i', 'report-identical-files': 's'}});
  if (rest.length !== 2) throw new ShellError('usage: diff [-u] [-q] FILE1 FILE2', 2);
  const texts = [];
  for (const name of rest) {
    if (name === '-') { texts.push(decode(io.stdin())); continue; }
    texts.push(decode(await io.vfs.read(resolvePath(io.cwd, name))));
  }
  const normalize = line => { if (opts.w) line = line.replace(/\s+/g, ''); if (opts.i) line = line.toLowerCase(); return line; };
  const [a, b] = texts.map(splitLines);
  const na = a.map(normalize), nb = b.map(normalize);
  if (na.length === nb.length && na.every((line, i) => line === nb[i])) { if (opts.s) io.out(`Files ${rest[0]} and ${rest[1]} are identical\n`); return 0; }
  if (opts.q) { io.out(`Files ${rest[0]} and ${rest[1]} differ\n`); return 1; }
  const ops = myers(na, nb);
  if (!ops) { io.out(`Files ${rest[0]} and ${rest[1]} differ (more than ${MAX_EDITS} changed lines)\n`); return 1; }
  let ia = 0, ib = 0;
  const original = ops.map(([type]) => type === '+' ? ['+', b[ib++]] : type === '-' ? ['-', a[ia++]] : (ib++, [' ', a[ia++]]));
  const context = opts.U !== undefined ? int(opts.U, 'context') : 3;
  io.out(`--- ${rest[0]}\n+++ ${rest[1]}\n` + joinLines(unified(original, context)));
  return 1;
});

// ---- seq / basename / dirname / tee / xargs ----

command('seq', io => {
  const {rest} = getopt(io.argv.slice(1).map(a => /^-\d/.test(a) ? '\x00' + a : a), {});
  const nums = rest.map(a => Number(a.replace('\x00', '')));
  if (!nums.length || nums.length > 3 || nums.some(n => !Number.isFinite(n))) throw new ShellError('usage: seq [FIRST [INCREMENT]] LAST', 2);
  const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
  if (step === 0) throw new ShellError('increment must not be 0', 2);
  const count = Math.floor((last - first) / step) + 1;
  if (count > 1_000_000) throw new ShellError('sequence is longer than 1,000,000 numbers', 2);
  const out = [];
  for (let k = 0; k < count; k++) out.push(String(Math.round((first + k * step) * 1e10) / 1e10));
  io.out(joinLines(out));
});

command('basename', io => {
  const args = io.argv.slice(1);
  if (!args.length) throw new ShellError('missing operand', 2);
  let name = args[0].replace(/\/+$/, '').split('/').pop() || '/';
  if (args[1] && name.endsWith(args[1]) && name !== args[1]) name = name.slice(0, -args[1].length);
  io.out(name + '\n');
});
command('dirname', io => {
  if (io.argv.length < 2) throw new ShellError('missing operand', 2);
  for (const arg of io.argv.slice(1)) {
    const trimmed = arg.replace(/\/+$/, '');
    const index = trimmed.lastIndexOf('/');
    io.out((index < 0 ? '.' : index === 0 ? '/' : trimmed.slice(0, index)) + '\n');
  }
});

command('tee', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'a', long: {append: 'a'}});
  const data = io.stdin();
  for (const name of rest) {
    const path = resolvePath(io.cwd, name);
    let content = data;
    if (opts.a && (await io.vfs.stat(path))?.kind === 'file') content = Buffer.concat([await io.vfs.read(path), data]);
    await io.vfs.write(path, content, true);
  }
  io.out(data);
});

function xargsSplit(text) {
  const out = [];
  let current = '', quote = null, has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; else current += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < text.length) { current += text[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || current) out.push(current); current = ''; has = false; continue; }
    current += c;
  }
  if (quote) throw new ShellError(`unmatched ${quote === '"' ? 'double' : 'single'} quote`);
  if (has || current) out.push(current);
  return out;
}

command('xargs', async io => {
  const args = io.argv.slice(1), opts = {};
  let i = 0;
  for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (arg === '-0' || arg === '--null') opts.null = true;
    else if (arg === '-r' || arg === '--no-run-if-empty') opts.r = true;
    else if (arg === '-t') opts.t = true;
    else if (/^-n\d*$/.test(arg)) opts.n = int(arg.slice(2) || args[++i], 'max args', {min: 1});
    else if (/^-L\d*$/.test(arg)) opts.L = int(arg.slice(2) || args[++i], 'max lines', {min: 1});
    else if (arg.startsWith('-I')) opts.I = arg.slice(2) || args[++i];
    else if (arg.startsWith('-d')) opts.d = escapes(arg.slice(2) || args[++i]).text;
    else throw new ShellError(`invalid option -- '${arg}'`, 2);
  }
  const base = args.slice(i).length ? args.slice(i) : ['echo'];
  const text = decode(io.stdin());
  let items;
  if (opts.null) items = text.split('\0').filter((v, k, all) => v !== '' || k < all.length - 1);
  else if (opts.d !== undefined) items = text.split(opts.d).filter((v, k, all) => !(k === all.length - 1 && (v === '' || v === '\n')));
  else if (opts.I !== undefined || opts.L) items = splitLines(text).map(l => opts.I !== undefined ? l.trim() : l).filter(Boolean);
  else items = xargsSplit(text);
  const batches = [];
  if (opts.I !== undefined) for (const item of items) batches.push(base.map(word => word.replaceAll(opts.I, item)));
  else if (opts.L) for (let k = 0; k < items.length; k += opts.L) batches.push([...base, ...items.slice(k, k + opts.L).flatMap(xargsSplit)]);
  else {
    const size = opts.n || 5000;
    for (let k = 0; k < items.length; k += size) batches.push([...base, ...items.slice(k, k + size)]);
  }
  if (!batches.length && !opts.r && opts.I === undefined) batches.push(base);
  let failed = false;
  for (const argv of batches) {
    if (opts.t) io.err(argv.join(' ') + '\n');
    if (await io.shell.invoke(argv, io) !== 0) failed = true;
  }
  return failed ? 123 : 0;
});

// ---- files ----

const entryAt = async (io, name) => {
  const path = resolvePath(io.cwd, name);
  return {path, entry: await io.vfs.stat(path)};
};

function stateNote(entry) {
  return entry.kind === 'file' && entry.state !== 'ready' ? ` [${entry.state}${entry.error ? ': ' + entry.error : ''}]` : '';
}

command('ls', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'laAR1htSrdFi', long: {all: 'a', recursive: 'R', 'human-readable': 'h', reverse: 'r', directory: 'd'}});
  const format = entry => {
    const name = entry.name + (opts.F && entry.kind === 'dir' ? '/' : '');
    if (!opts.l) return name + stateNote(entry);
    const size = entry.kind === 'dir' ? '-' : opts.h ? human(entry.size) : String(entry.size);
    return `${entry.kind === 'dir' ? 'd' : '-'} ${size.padStart(opts.h ? 5 : 9)} ${entry.kind === 'dir' ? '                ' : time(entry.mtime)} ${name}${stateNote(entry)}`;
  };
  const sortEntries = list => {
    list = list.filter(e => opts.a || opts.A || !e.name.startsWith('.'));
    if (opts.t) list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    if (opts.S) list.sort((a, b) => b.size - a.size);
    if (opts.r) list.reverse();
    return list;
  };
  const operands = rest.length ? rest : ['.'];
  const files = [], dirs = [];
  for (const name of operands) {
    let found;
    try { found = await entryAt(io, name); } catch (error) { io.err(`ls: ${error.message}\n`); io.failed = true; continue; }
    if (!found.entry) { io.err(`ls: cannot access '${name}': No such file or directory\n`); io.failed = true; continue; }
    if (found.entry.kind === 'file' || opts.d) files.push({...found.entry, name});
    else dirs.push({name, path: found.path});
  }
  const out = [];
  for (const entry of sortEntries(files)) out.push(format(entry));
  const listDir = async (name, path, header) => {
    const children = sortEntries(await io.vfs.children(path));
    if (header) out.push((out.length ? '\n' : '') + name + ':');
    if (opts.l) out.push(`total ${children.length}`);
    for (const child of children) out.push(format(child));
    if (opts.R) for (const child of children) if (child.kind === 'dir') await listDir(name.replace(/\/$/, '') + '/' + child.name, child.path, true);
  };
  for (const {name, path} of dirs) await listDir(name, path, operands.length > 1 || opts.R || files.length > 0);
  io.out(joinLines(out));
  return status(io) ? 2 : 0;
});

command('tree', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'ahsd', values: 'L'});
  const maxDepth = opts.L ? int(opts.L, 'level', {min: 1}) : Infinity;
  let dirs = 0, files = 0;
  const out = [];
  for (const name of rest.length ? rest : ['.']) {
    const {path, entry} = await entryAt(io, name);
    if (entry?.kind !== 'dir') { io.err(`tree: ${name}: not a directory\n`); io.failed = true; continue; }
    out.push(name);
    const walk = async (dir, prefix, depth) => {
      const children = (await io.vfs.children(dir)).filter(c => (opts.a || !c.name.startsWith('.')) && (!opts.d || c.kind === 'dir'));
      for (let k = 0; k < children.length; k++) {
        const child = children[k], last = k === children.length - 1;
        const size = opts.s || opts.h ? `[${(opts.h ? human(child.size) : String(child.size)).padStart(opts.h ? 5 : 9)}]  ` : '';
        out.push(prefix + (last ? '└── ' : '├── ') + size + child.name + stateNote(child));
        if (child.kind === 'dir') { dirs++; if (depth < maxDepth) await walk(child.path, prefix + (last ? '    ' : '│   '), depth + 1); }
        else files++;
      }
    };
    await walk(path, '', 1);
  }
  out.push('', `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
  io.out(joinLines(out));
  return status(io);
});

command('stat', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {values: 'c', long: {format: '=c'}});
  if (!rest.length) throw new ShellError('missing operand', 2);
  for (const name of rest) {
    const {path, entry} = await entryAt(io, name);
    if (!entry) { io.err(`stat: cannot stat '${name}': No such file or directory\n`); io.failed = true; continue; }
    if (opts.c) {
      io.out(opts.c.replace(/%([nsFy%])/g, (m, k) => ({n: name, s: String(entry.size), F: entry.kind === 'dir' ? 'directory' : 'regular file', y: time(entry.mtime), '%': '%'})[k]) + '\n');
      continue;
    }
    const lines = [`  File: ${display(path)}`, `  Type: ${entry.kind === 'dir' ? 'directory' : 'regular file'}`];
    if (entry.kind === 'file') {
      lines.push(`  Size: ${entry.size}`, ` State: ${entry.state}${entry.error ? ' (' + entry.error + ')' : ''}`, `Source: ${entry.source}`, `  File ID: ${entry.file_id}`, `Modify: ${time(entry.mtime)} UTC`);
    }
    io.out(joinLines(lines));
  }
  return status(io);
});

command('du', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'sahbck', values: 'd', long: {summarize: 's', all: 'a', 'human-readable': 'h', bytes: 'b', total: 'c', 'max-depth': '=d'}});
  const size = bytes => opts.h ? human(bytes) : opts.b ? String(bytes) : String(Math.ceil(bytes / 1024));
  const maxDepth = opts.s ? 0 : opts.d !== undefined ? int(opts.d, 'depth') : Infinity;
  let grand = 0;
  for (const name of rest.length ? rest : ['.']) {
    const {path, entry} = await entryAt(io, name);
    if (!entry) { io.err(`du: cannot access '${name}': No such file or directory\n`); io.failed = true; continue; }
    if (entry.kind === 'file') { io.out(size(entry.size) + '\t' + name + '\n'); grand += entry.size; continue; }
    const base = name.replace(/\/+$/, '');
    const visit = async (dir, shown, depth) => {
      let total = 0;
      for (const child of await io.vfs.children(dir)) {
        const childShown = shown + '/' + child.name;
        if (child.kind === 'dir') total += await visit(child.path, childShown, depth + 1);
        else { total += child.size; if (opts.a && depth + 1 <= maxDepth) io.out(size(child.size) + '\t' + childShown + '\n'); }
      }
      if (depth <= maxDepth) io.out(size(total) + '\t' + shown + '\n');
      return total;
    };
    grand += await visit(path, base, 0);
  }
  if (opts.c) io.out(size(grand) + '\ttotal\n');
  return status(io);
});

command('file', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'biL', long: {'mime-type': 'i', mime: 'i', brief: 'b'}});
  if (!rest.length) throw new ShellError('usage: file [-b] [-i] FILE...', 2);
  for (const name of rest) {
    const {entry, path} = await entryAt(io, name);
    let description;
    if (!entry) { description = 'cannot open (No such file or directory)'; io.failed = true; }
    else if (entry.kind === 'dir') description = opts.i ? 'inode/directory' : 'directory';
    else if (entry.state !== 'ready') description = entry.state;
    else { const type = detectType(await io.vfs.read(path)); description = opts.i ? type.mime : type.description; }
    io.out((opts.b ? '' : name + ': ') + description + '\n');
  }
  return status(io);
});

command('mkdir', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'pv', long: {parents: 'p'}});
  if (!rest.length) throw new ShellError('missing operand', 2);
  for (const name of rest) {
    const {path, entry} = await entryAt(io, name);
    if (entry) { if (!opts.p || entry.kind !== 'dir') { io.err(`mkdir: cannot create directory '${name}': File exists\n`); io.failed = true; } continue; }
    const parent = path.split('/').slice(0, -1).join('/');
    if (!opts.p && (await io.vfs.stat(parent))?.kind !== 'dir') { io.err(`mkdir: cannot create directory '${name}': No such file or directory\n`); io.failed = true; continue; }
    await io.vfs.mkdir(path);
  }
  return status(io);
});

command('rmdir', async io => {
  const {rest} = getopt(io.argv.slice(1), {flags: 'p'});
  for (const name of rest) {
    const {path, entry} = await entryAt(io, name);
    if (entry?.kind !== 'dir' || !path) { io.err(`rmdir: failed to remove '${name}': Not a directory\n`); io.failed = true; continue; }
    if ((await io.vfs.children(path)).length) { io.err(`rmdir: failed to remove '${name}': Directory not empty\n`); io.failed = true; continue; }
    await io.vfs.rmdir(path);
  }
  return status(io);
});

command('touch', async io => {
  const {rest} = getopt(io.argv.slice(1), {flags: 'cam'});
  if (!rest.length) throw new ShellError('missing file operand', 2);
  for (const name of rest) {
    const {path, entry} = await entryAt(io, name);
    if (!entry) await io.vfs.write(path, Buffer.alloc(0), false);
  }
});

async function filesUnder(io, path) {
  const out = [];
  await io.vfs.walk(path, child => { if (child.kind === 'file') out.push(child.path); else out.push({dir: child.path}); });
  return out;
}

command('rm', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'rRfdiv', long: {recursive: 'r', force: 'f', dir: 'd'}});
  if (!rest.length && !opts.f) throw new ShellError('missing operand', 2);
  for (const name of rest) {
    let found;
    try { found = await entryAt(io, name); } catch (error) { io.err(`rm: ${error.message}\n`); io.failed = true; continue; }
    const {path, entry} = found;
    if (!entry) { if (!opts.f) { io.err(`rm: cannot remove '${name}': No such file or directory\n`); io.failed = true; } continue; }
    if (entry.kind === 'file') { await io.vfs.remove(path); continue; }
    if (!path) { io.err("rm: refusing to remove '/work'; use rm -r /work/* to clear it\n"); io.failed = true; continue; }
    const children = await filesUnder(io, path);
    if (!opts.r && !opts.R) {
      if (opts.d && !children.length) { await io.vfs.rmdir(path); continue; }
      io.err(`rm: cannot remove '${name}': Is a directory\n`); io.failed = true; continue;
    }
    for (const child of children) if (typeof child === 'string') await io.vfs.remove(child);
    await io.vfs.rmdir(path);
  }
  return status(io);
});

// Destination for cp/mv: into an existing directory, or the exact path.
async function destinations(io, operands, verb) {
  if (operands.length < 2) throw new ShellError(`missing destination file operand after '${operands[0] ?? ''}'`, 2);
  const target = operands[operands.length - 1], sources = operands.slice(0, -1);
  const {path: targetPath, entry: targetEntry} = await entryAt(io, target);
  const intoDir = targetEntry?.kind === 'dir' || target.endsWith('/');
  if (sources.length > 1 && !intoDir) throw new ShellError(`target '${target}' is not a directory`);
  if (intoDir && !targetEntry) throw new ShellError(`target '${target}': No such directory`);
  const out = [];
  for (const source of sources) {
    const {path, entry} = await entryAt(io, source);
    if (!entry) { io.err(`${verb}: cannot stat '${source}': No such file or directory\n`); io.failed = true; continue; }
    const name = path.split('/').pop();
    out.push({source, path, entry, dest: intoDir ? (targetPath ? targetPath + '/' : '') + name : targetPath});
  }
  return out;
}

command('cp', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'rRanfvTp', long: {recursive: 'r', 'no-clobber': 'n', force: 'f', archive: 'a'}});
  for (const {source, path, entry, dest} of await destinations(io, rest, 'cp')) {
    if (path === dest) { io.err(`cp: '${source}' and destination are the same file\n`); io.failed = true; continue; }
    if (entry.kind === 'dir') {
      if (!opts.r && !opts.R && !opts.a) { io.err(`cp: -r not specified; omitting directory '${source}'\n`); io.failed = true; continue; }
      if (dest.startsWith(path + '/') || !path) { io.err(`cp: cannot copy a directory, '${source}', into itself\n`); io.failed = true; continue; }
      await io.vfs.mkdir(dest);
      for (const child of await filesUnder(io, path)) {
        const relative = (typeof child === 'string' ? child : child.dir).slice(path.length);
        if (typeof child !== 'string') { await io.vfs.mkdir(dest + relative); continue; }
        const existing = await io.vfs.stat(dest + relative);
        if (existing && opts.n) continue;
        await io.vfs.write(dest + relative, await io.vfs.read(child), true);
      }
      continue;
    }
    const existing = await io.vfs.stat(dest);
    if (existing?.kind === 'dir') { io.err(`cp: cannot overwrite directory '${display(dest)}' with non-directory\n`); io.failed = true; continue; }
    if (existing && opts.n) continue;
    await io.vfs.write(dest, await io.vfs.read(path), true);
  }
  return status(io);
});

command('mv', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'nfvT', long: {'no-clobber': 'n', force: 'f'}});
  for (const {source, path, entry, dest} of await destinations(io, rest, 'mv')) {
    if (path === dest) continue;
    if (!path || dest.startsWith(path + '/')) { io.err(`mv: cannot move '${source}' to a subdirectory of itself\n`); io.failed = true; continue; }
    const existing = await io.vfs.stat(dest);
    if (existing && opts.n) continue;
    if (entry.kind === 'file') {
      if (existing?.kind === 'dir') { io.err(`mv: cannot overwrite directory '${display(dest)}' with non-directory\n`); io.failed = true; continue; }
      await io.vfs.rename(path, dest, true);
      continue;
    }
    if (existing?.kind === 'file') { io.err(`mv: cannot overwrite non-directory '${display(dest)}' with directory\n`); io.failed = true; continue; }
    if (existing && (await io.vfs.children(dest)).length) { io.err(`mv: cannot move '${source}': Directory not empty\n`); io.failed = true; continue; }
    await io.vfs.mkdir(dest);
    for (const child of await filesUnder(io, path)) {
      if (typeof child === 'string') await io.vfs.rename(child, dest + child.slice(path.length), false);
      else await io.vfs.mkdir(dest + child.dir.slice(path.length));
    }
    await io.vfs.rmdir(path);
  }
  return status(io);
});

// ---- find ----

function findSize(spec) {
  const match = /^([+-]?)(\d+)([bckMG]?)$/.exec(spec);
  if (!match) throw new ShellError(`invalid argument '${spec}' to -size`, 2);
  const unit = {b: 512, '': 512, c: 1, k: 1024, M: 1 << 20, G: 1 << 30}[match[3]];
  const n = Number(match[2]);
  return size => {
    const blocks = Math.ceil(size / unit);
    return match[1] === '+' ? blocks > n : match[1] === '-' ? blocks < n : blocks === n;
  };
}

command('find', async io => {
  const args = io.argv.slice(1);
  let i = 0;
  const starts = [];
  while (i < args.length && !/^[-!(]/.test(args[i]) && args[i] !== '!') starts.push(args[i++]);
  if (!starts.length) starts.push('.');
  let maxDepth = Infinity, minDepth = 0, hasAction = false;
  const deferred = [], deletions = [];
  const peek = () => args[i];
  const primary = () => {
    const token = args[i++];
    if (token === undefined) throw new ShellError('expected an expression', 2);
    const value = () => { const v = args[i++]; if (v === undefined) throw new ShellError(`missing argument to '${token}'`, 2); return v; };
    switch (token) {
      case '-name': case '-iname': { const r = globRegExp(value(), {ignoreCase: token === '-iname'}); return e => r.test(e.name); }
      case '-path': case '-wholename': case '-ipath': {
        const pattern = value();
        const r = new RegExp(globRegExp(pattern, {ignoreCase: token === '-ipath'}).source.replaceAll('[^/]*', '.*').replaceAll('[^/]', '.'), token === '-ipath' ? 'iu' : 'u');
        return e => r.test(e.shown);
      }
      case '-type': { const t = value(); if (!['f', 'd'].includes(t)) throw new ShellError(`-type ${t} is unavailable (use f or d)`, 2); return e => (t === 'd') === (e.kind === 'dir'); }
      case '-size': { const test = findSize(value()); return e => e.kind === 'file' && test(e.size); }
      case '-empty': return async e => e.kind === 'file' ? e.size === 0 : !(await io.vfs.children(e.path)).length;
      case '-newer': { const name = value(); return async e => { const ref = (await entryAt(io, name)).entry; if (!ref) throw new ShellError(`'${name}': No such file or directory`); return (e.mtime || 0) > (ref.mtime || 0); }; }
      case '-mmin': case '-mtime': {
        const spec = value(), match = /^([+-]?)(\d+)$/.exec(spec);
        if (!match) throw new ShellError(`invalid argument '${spec}' to ${token}`, 2);
        const unit = token === '-mmin' ? 60_000 : 86_400_000, n = Number(match[2]);
        return e => { const age = Math.floor((Date.now() - (e.mtime || 0)) / unit); return match[1] === '+' ? age > n : match[1] === '-' ? age < n : age === n; };
      }
      case '-maxdepth': maxDepth = int(value(), 'maxdepth'); return () => true;
      case '-mindepth': minDepth = int(value(), 'mindepth'); return () => true;
      case '-true': return () => true;
      case '-false': return () => false;
      case '-print': hasAction = true; return e => { io.out(e.shown + '\n'); return true; };
      case '-print0': hasAction = true; return e => { io.out(e.shown + '\0'); return true; };
      case '-delete': hasAction = true; return e => { if (e.path) deletions.push(e); return true; };
      case '-exec': case '-execdir': case '-ok': {
        if (token !== '-exec') throw new ShellError(`${token} is unavailable; use -exec`, 2);
        hasAction = true;
        const template = [];
        while (i < args.length && args[i] !== ';' && args[i] !== '+') template.push(args[i++]);
        const mode = args[i++];
        if (!mode || !template.length) throw new ShellError("missing argument to '-exec'", 2);
        if (mode === '+') {
          if (template[template.length - 1] !== '{}') throw new ShellError("'-exec ... +' needs {} last", 2);
          const batch = {template: template.slice(0, -1), paths: []};
          deferred.push(batch);
          return e => { batch.paths.push(e.shown); return true; };
        }
        return async e => await io.shell.invoke(template.map(word => word.replaceAll('{}', e.shown)), io) === 0;
      }
      case '-fprint': case '-fls': case '-fprintf': case '-printf': case '-ls': throw new ShellError(`${token} is unavailable; use -print with other commands`, 2);
      case '(': { const inner = or(); if (args[i++] !== ')') throw new ShellError("missing ')'", 2); return inner; }
      default: throw new ShellError(`unknown predicate '${token}'`, 2);
    }
  };
  const unary = () => {
    if (peek() === '!' || peek() === '-not') { i++; const inner = unary(); return async e => !await inner(e); }
    return primary();
  };
  const and = () => {
    let left = unary();
    while (i < args.length && ![')', '-o', '-or', ','].includes(peek())) {
      if (peek() === '-a' || peek() === '-and') i++;
      const a = left, b = unary();
      left = async e => await a(e) && await b(e);
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (peek() === '-o' || peek() === '-or') { i++; const a = left, b = and(); left = async e => await a(e) || await b(e); }
    return left;
  };
  const expression = i < args.length ? or() : () => true;
  if (i < args.length) throw new ShellError(`unexpected '${args[i]}'`, 2);
  const test = hasAction ? expression : async e => { if (await expression(e)) io.out(e.shown + '\n'); return true; };
  for (const start of starts) {
    let found;
    try { found = await entryAt(io, start); } catch (error) { io.err(`find: ${error.message}\n`); io.failed = true; continue; }
    if (!found.entry) { io.err(`find: '${start}': No such file or directory\n`); io.failed = true; continue; }
    const root = {...found.entry, name: found.path.split('/').pop() || 'work', shown: start, path: found.path};
    if (minDepth <= 0) await test(root);
    if (root.kind === 'dir' && maxDepth > 0) {
      const base = start.endsWith('/') ? start : start + '/';
      await io.vfs.walk(found.path, async (child, depth) => {
        const entry = {...child, shown: base + child.path.slice(found.path ? found.path.length + 1 : 0)};
        if (depth >= minDepth && depth <= maxDepth) await test(entry);
        return depth < maxDepth;
      });
    }
  }
  for (const batch of deferred) if (batch.paths.length && await io.shell.invoke([...batch.template, ...batch.paths], io) !== 0) io.failed = true;
  for (const entry of deletions.reverse()) {
    if (entry.kind === 'file') await io.vfs.remove(entry.path);
    else if (!(await io.vfs.children(entry.path)).length) await io.vfs.rmdir(entry.path);
    else { io.err(`find: cannot delete '${entry.shown}': Directory not empty\n`); io.failed = true; }
  }
  return status(io);
});

// ---- download / curl / wget ----
// GET only, through the runner's checked-IP downloader (as download_file): no
// browser cookies or credentials, public hosts on 80/443, 10 MiB, 5 redirects.

function remoteName(url) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* invalid URL fails at download */ }
  name = name.replace(/[/\\:\x00-\x1f\x7f]/g, '_').slice(0, 200);
  return name && name !== '.' && name !== '..' ? name : '';
}

function downloadError(error) {
  const message = error.message || String(error);
  const kind = error.code === 'download_failed' ? 'http' : error.code === 'download_timeout' ? 'timeout' : error.code === 'file_size_limit' ? 'size'
    : /URL|web ports|http\(s\)/.test(message) ? 'url' : /ENOTFOUND|EAI_AGAIN/.test(error.code || message) ? 'resolve'
    : /Private or reserved/.test(message) ? 'denied' : /limit|budget|exists|busy|folder|Session/.test(message) ? 'local' : 'connect';
  return {kind, message};
}
const CURL_EXIT = {http: 22, timeout: 28, size: 63, url: 3, resolve: 6, denied: 7, connect: 7, local: 23};
const WGET_EXIT = {http: 8, timeout: 4, size: 1, url: 1, resolve: 4, denied: 4, connect: 4, local: 3};

function header(value, headers, name) {
  const match = /^([A-Za-z-]+):\s*(.*)$/.exec(value);
  const key = match?.[1].toLowerCase();
  if (!match || !['accept', 'accept-language'].includes(key)) throw new ShellError(`${name}: only Accept and Accept-Language headers can be set; requests carry no cookies or credentials`, 2);
  headers[key] = match[2];
}

const unavailable = (name, option, why) => new ShellError(`${option} is unavailable: ${why}`, 2);
const GET_ONLY = 'only public GET downloads (use the browser session for forms, logins and APIs)';

command('download', async io => {
  const {opts, rest} = getopt(io.argv.slice(1), {flags: 'f', values: 'H', long: {force: 'f', header: '=H'}});
  if (!rest.length || rest.length > 2) throw new ShellError('usage: download [-f] [-H "Accept: …"] URL [PATH]', 2);
  const headers = {};
  for (const value of opts.all.H || []) header(value, headers, 'download');
  const name = remoteName(rest[0]) || 'index.html';
  const path = resolvePath(io.cwd, rest[1] ?? 'downloads/' + name);
  try {
    const file = await io.vfs.download(rest[0], headers, path, Boolean(opts.f));
    io.out(`${file.path} ${file.size}\n`);
  } catch (error) {
    if (!(error instanceof ShellError)) throw error;
    const {kind, message} = downloadError(error);
    throw new ShellError(message + (kind === 'local' && /exists/.test(message) ? ' (use -f to overwrite)' : ''));
  }
});

command('curl', async io => {
  const args = io.argv.slice(1), urls = [], outputs = [], headers = {};
  let remote = false, silent = false, showError = false;
  const takes = {o: 'output', H: 'header', X: 'request', m: 'max-time', d: 'data', F: 'form', u: 'user', b: 'cookie', c: 'cookie-jar', A: 'user-agent', e: 'referer', w: 'write-out', T: 'upload-file', x: 'proxy', r: 'range', C: 'continue-at', K: 'config'};
  const handle = (name, value) => {
    switch (name) {
      case 'silent': silent = true; break;
      case 'show-error': showError = true; break;
      case 'fail': case 'fail-with-body': case 'location': case 'compressed': case 'create-dirs': case 'globoff': case 'no-progress-meter': case 'progress-bar': break;
      case 'max-time': case 'connect-timeout': case 'retry': if (!Number.isFinite(Number(value))) throw new ShellError(`--${name}: expected a number`, 2); break;
      case 'output': outputs.push(value); break;
      case 'remote-name': case 'remote-name-all': remote = true; break;
      case 'header': header(value, headers, 'curl'); break;
      case 'url': urls.push(value); break;
      case 'request': if (value.toUpperCase() !== 'GET') throw unavailable('curl', `-X ${value}`, GET_ONLY); break;
      case 'data': case 'data-raw': case 'data-binary': case 'data-urlencode': case 'json': case 'form': case 'upload-file': case 'get':
        throw unavailable('curl', `--${name}`, GET_ONLY);
      case 'user': case 'cookie': case 'cookie-jar': case 'oauth2-bearer': throw unavailable('curl', `--${name}`, 'downloads carry no cookies or credentials');
      case 'user-agent': case 'referer': case 'proxy': throw unavailable('curl', `--${name}`, 'the download identity and route are fixed');
      case 'insecure': throw unavailable('curl', '--insecure', 'TLS verification cannot be disabled');
      case 'include': case 'head': case 'dump-header': case 'write-out': case 'verbose': case 'trace': throw unavailable('curl', `--${name}`, 'response headers are not exposed; use the browser resources action');
      case 'range': case 'continue-at': case 'config': case 'next': case 'parallel': throw unavailable('curl', `--${name}`, 'not supported by the computer shell');
      default: throw new ShellError(`option --${name}: is unknown`, 2);
    }
  };
  const short = {s: 'silent', S: 'show-error', f: 'fail', L: 'location', O: 'remote-name', k: 'insecure', i: 'include', I: 'head', v: 'verbose', G: 'get', g: 'globoff', Z: 'parallel', '#': 'progress-bar', J: 'remote-header-name'};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('='), name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const valued = Object.values(takes).includes(name) || ['url', 'connect-timeout', 'retry', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'dump-header', 'oauth2-bearer'].includes(name);
      const value = valued ? (eq < 0 ? args[++i] : arg.slice(eq + 1)) : undefined;
      if (valued && value === undefined) throw new ShellError(`option --${name}: requires parameter`, 2);
      handle(name, value);
    } else if (arg.length > 1 && arg[0] === '-') {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (takes[c]) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) throw new ShellError(`option -${c}: requires parameter`, 2);
          handle(takes[c], value); break;
        }
        if (c === 'J') { remote = true; continue; }
        if (!short[c]) throw new ShellError(`option -${c}: is unknown`, 2);
        handle(short[c]);
      }
    } else urls.push(arg);
  }
  if (!urls.length) throw new ShellError('no URL specified (curl [-fsSLO] [-o FILE] [-H "Accept: …"] URL…)', 2);
  let exit = 0;
  for (let k = 0; k < urls.length; k++) {
    const url = urls[k];
    let target = outputs[k];
    try {
      if (target === undefined && remote) {
        target = remoteName(url);
        if (!target) throw Object.assign(new ShellError('Remote file name has no length'), {code: 'local'});
      }
      if (target === undefined || target === '-') io.out(await io.vfs.download(url, headers));
      else await io.vfs.download(url, headers, resolvePath(io.cwd, target), true);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      const {kind, message} = downloadError(error);
      exit = CURL_EXIT[kind];
      if (!silent || showError) io.err(`curl: (${exit}) ${message}\n`);
    }
  }
  return exit;
});

command('wget', async io => {
  // wget spells some long options with one dash: -nv, -nc.
  const argv = io.argv.slice(1).map(arg => arg === '-nv' ? '--no-verbose' : arg === '-nc' ? '--no-clobber' : arg);
  const {opts, rest: args} = getopt(argv, {flags: 'qvcrNSmkpb', values: 'OPiTtUe', long: {quiet: 'q', 'output-document': '=O', 'directory-prefix': '=P',
    'input-file': '=i', header: '=header', 'no-clobber': 'no-clobber', nc: 'no-clobber', 'no-verbose': 'nv', 'show-progress': 'v', verbose: 'v',
    timeout: '=T', tries: '=t', 'user-agent': '=U', 'post-data': '=post-data', 'post-file': '=post-file', method: '=method', recursive: 'r', mirror: 'm',
    'no-check-certificate': 'no-check-certificate', continue: 'c', 'page-requisites': 'p', 'convert-links': 'k', 'server-response': 'S', 'background': 'b', 'execute': '=e'}});
  for (const [key, why] of [['post-data', GET_ONLY], ['post-file', GET_ONLY], ['U', 'the download identity is fixed'], ['no-check-certificate', 'TLS verification cannot be disabled'],
    ['r', 'recursive retrieval is unavailable'], ['m', 'mirroring is unavailable'], ['p', 'page requisites are unavailable'], ['k', 'link conversion is unavailable'],
    ['c', 'resuming is unavailable'], ['N', 'timestamping is unavailable'], ['S', 'response headers are not exposed'], ['b', 'background jobs are unavailable'], ['e', 'wgetrc commands are unavailable']])
    if (opts[key] !== undefined) throw unavailable('wget', key.length === 1 ? '-' + key : '--' + key, why);
  if (opts.method && opts.method.toUpperCase() !== 'GET') throw unavailable('wget', '--method', GET_ONLY);
  for (const key of ['T', 't']) if (opts[key] !== undefined && !Number.isFinite(Number(opts[key]))) throw new ShellError(`-${key}: expected a number`, 2);
  const headers = {};
  for (const value of opts.all.header || []) header(value, headers, 'wget');
  const urls = [...args];
  if (opts.i) urls.push(...splitLines(decode(await io.vfs.read(resolvePath(io.cwd, opts.i)))).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  if (!urls.length) throw new ShellError('missing URL (wget [-q] [-O FILE] [-P DIR] URL…)', 1);
  const quiet = opts.q, brief = opts.nv;
  let exit = 0, documentStarted = false;
  for (const url of urls) {
    try {
      if (opts.O === '-') { io.out(await io.vfs.download(url, headers)); continue; }
      let path;
      if (opts.O !== undefined) {
        path = resolvePath(io.cwd, opts.O);
        if (documentStarted) {
          // Several URLs with one -O concatenate into that document, as wget does.
          const data = await io.vfs.download(url, headers);
          await io.vfs.write(path, Buffer.concat([await io.vfs.read(path), data]), true);
          if (!quiet) io.err(`'${opts.O}' appended [${data.length}]\n`);
          continue;
        }
        documentStarted = true;
      } else {
        const dir = opts.P !== undefined ? resolvePath(io.cwd, opts.P) : io.cwd;
        const name = remoteName(url) || 'index.html';
        path = (dir ? dir + '/' : '') + name;
        if (await io.vfs.stat(path)) {
          if (opts['no-clobber']) { if (!quiet) io.err(`File '${name}' already there; not retrieving.\n`); continue; }
          let n = 1;
          while (await io.vfs.stat(`${path}.${n}`)) n++;
          path = `${path}.${n}`;
        }
      }
      const file = await io.vfs.download(url, headers, path, true);
      const shown = display(path).slice(display(io.cwd).length + 1) || display(path);
      if (brief && !quiet) io.err(`${url} -> "${shown}" [${file.size}]\n`);
      else if (!quiet) io.err(`Saving to: '${shown}'\n'${shown}' saved [${file.size}]\n`);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      const {kind, message} = downloadError(error);
      exit = Math.max(exit, WGET_EXIT[kind]);
      if (!quiet) io.err(`wget: ${url}: ${message}\n`);
    }
  }
  return exit;
});

command('jq', async io => {
  const result = await jq(io.argv.slice(1), async files => {
    if (!files.length) return decode(io.stdin());
    const parts = [];
    for (const name of files) parts.push(await io.vfs.read(resolvePath(io.cwd, name)));
    return decode(Buffer.concat(parts));
  });
  io.out(result.stdout);
  if (result.error) io.err(result.error);
  return result.status;
});

export {getopt, int, decode, splitLines, joinLines, inputs, allText, status, human, time, entryAt, command, escapes};
