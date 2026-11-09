import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, realpath} from 'node:fs/promises';
import {join, extname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Failure, check} from './errors.js';
import {MAX_FILE_BYTES, fileType, workPath} from './browser-files.js';
import {workspaceImagePlan} from './workspace-magick.js';

const policy = fileURLToPath(new URL('../deploy/magick/', import.meta.url));
let active = 0;
const ffOptions = {
  '-c:v': /^(libx264|libvpx-vp9|mjpeg|png|copy)$/,
  '-c:a': /^(aac|libmp3lame|libopus|pcm_s16le|flac|copy)$/,
  '-b:v': /^[1-9][0-9]{0,3}k$/, '-b:a': /^[1-9][0-9]{0,2}k$/,
  '-crf': /^(?:[0-9]|[1-4][0-9]|5[01])$/,
  '-preset': /^(ultrafast|superfast|veryfast|faster|fast|medium|slow)$/,
  '-ar': /^(8000|16000|22050|24000|44100|48000)$/, '-ac': /^[12]$/,
  '-r': /^(?:[1-9]|[1-5][0-9]|60)$/,
  '-t': /^(?:[0-9]{1,2}|[12][0-9]{2}|300)(?:\.[0-9]{1,3})?$/,
  '-ss': /^(?:[0-9]{1,2}|[12][0-9]{2}|300)(?:\.[0-9]{1,3})?$/,
};
function videoFilter(value) {
  return value.split(',').length <= 4 && value.split(',').every(filter => {
    if (/^fps=(?:[1-9]|[1-5][0-9]|60)$/.test(filter) || /^transpose=[0-3]$/.test(filter)) return true;
    const match = /^scale=(-?[0-9]{1,4}):(-?[0-9]{1,4})$/.exec(filter);
    return match && match.slice(1).every(n => Number(n) >= -2 && Number(n) <= 4096 && Number(n) !== 0) && match.slice(1).some(n => Number(n) > 0);
  });
}
export function validateWorkTool(c) {
  check(c && ['archive', 'image', 'ffmpeg'].includes(c.tool), 'tool must be archive, image or ffmpeg');
  check(Array.isArray(c.inputs) && c.inputs.length > 0 && c.inputs.length <= (c.tool === 'archive' ? 20 : 1) && c.inputs.every(v => typeof v === 'string' && v.length <= 512), 'Invalid tool inputs');
  workPath(c.output);
  check(c.overwrite === undefined || typeof c.overwrite === 'boolean', 'overwrite must be boolean');
  const options = c.options || [];
  check(Array.isArray(options) && options.length <= 64 && options.every(v => typeof v === 'string') && options.join('').length <= 8192, 'Invalid tool options');
  if (c.tool === 'archive') check(options.length === 0 && c.output.endsWith('.zip'), 'archive writes ZIP; options are unavailable');
  if (c.tool === 'image') {
    const output = extname(c.output).slice(1).replace('jpg', 'jpeg');
    workspaceImagePlan({tool: 'convert', input_format: 'png', output_format: output, options, data: 'AA=='});
  }
  if (c.tool === 'ffmpeg') {
    check(/\.(mp4|webm|mp3|wav|ogg|flac|png|jpg|jpeg|gif)$/.test(c.output), 'Unsupported FFmpeg output format');
    for (let i = 0; i < options.length; i++) {
      const key = options[i];
      if (key === '-vn' || key === '-an') continue;
      const value = options[++i];
      check(typeof value === 'string' && (key === '-vf' ? videoFilter(value) : Object.hasOwn(ffOptions, key) && ffOptions[key].test(value)), 'Unsupported FFmpeg option or value');
    }
  }
}

// ZIP STORE: no subprocess, extraction, host filenames or caller flags.
export function zipFiles(entries) {
  let offset = 0; const contents = [], directory = [];
  for (const {path, data} of entries) {
    const name = Buffer.from(workPath(path)), local = Buffer.alloc(30), central = Buffer.alloc(46);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    contents.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
    check(offset <= MAX_FILE_BYTES, 'ZIP exceeds 10 MiB');
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  check(offset + central.length + end.length <= MAX_FILE_BYTES, 'ZIP exceeds 10 MiB');
  return Buffer.concat([...contents, central, end]);
}

function mediaFormat(data) {
  const image = fileType(data);
  if (image.startsWith('image/')) return { 'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'image/gif': 'gif', 'image/webp': 'webp_pipe' }[image];
  if (data.subarray(4, 8).toString() === 'ftyp') return 'mov';
  if (data.subarray(0, 4).toString('hex') === '1a45dfa3') return 'matroska';
  if (data.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (data.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (data.subarray(0, 3).toString() === 'ID3' || (data[0] === 255 && (data[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new Failure(400, 'unsupported_media', 'FFmpeg accepts raster images, MP4, WebM/MKV, MP3, WAV, Ogg or FLAC; playlists and arbitrary demuxers are unavailable');
}

export function sandboxArgs(input, output) {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives', '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', input, '/input', '--bind', output, '/output', '--ro-bind', policy, '/policy',
    '--setenv', 'PATH', '/usr/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'MAGICK_CONFIGURE_PATH', '/policy',
    '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '2', '--chdir', '/output', '--'];
}
async function nativeJob(dir, binary, args, signal, {stdoutLimit = 0} = {}) {
  check(process.platform === 'linux', 'Native file tools require the Linux sandbox worker');
  // Debian's convert is an /etc/alternatives symlink; host /etc is deliberately
  // absent inside the sandbox. Resolve the fixed executable before entering it.
  const executable = await realpath('/usr/bin/' + binary);
  check(executable.startsWith('/usr/bin/'), 'Native executable is outside the runtime');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/prlimit', ['--as=1073741824', '--cpu=30', '--fsize=' + MAX_FILE_BYTES, '--nofile=128', '--',
      '/usr/bin/bwrap', ...sandboxArgs(join(dir, 'input'), join(dir, 'output')), executable, ...args],
    {env: {PATH: '/usr/bin', LANG: 'C.UTF-8'}, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL'});
    let stderr = '', size = 0, failure;
    const stdout = [];
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, 40000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536 + stdoutLimit) stop(); else if (stdoutLimit) stdout.push(chunk); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size <= 65536) stderr += chunk; else stop(); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || signal.aborted) reject(new Failure(422, 'file_tool_failed', signal.aborted ? 'File job cancelled' : 'File tool failed: ' + (stderr.slice(-8192) || failure?.code || 'time/resource limit reached')));
      else resolve(stdoutLimit ? {stderr: stderr.slice(-8192), stdout: Buffer.concat(stdout)} : stderr.slice(-8192));
    });
  });
}

export async function runWorkTool(files, c, signal) {
  validateWorkTool(c);
  check(!files.closed && !signal.aborted, 'Session or code run is closed');
  if (active >= 3) throw new Failure(429, 'file_tools_busy', 'File worker capacity reached');
  active++;
  let dir;
  try {
    const inputs = [];
    for (const id of c.inputs) {
      const {file, data} = await files.bytes(id);
      check(!inputs.some(f => f.path === file.path), 'Duplicate input');
      inputs.push({path: file.path, data});
    }
    if (c.tool === 'archive') return {file: await files.write(c.output, zipFiles(inputs), !!c.overwrite, 'archive', signal)};
    const input = inputs[0].data, options = c.options || [], ext = extname(c.output).slice(1).replace('jpg', 'jpeg');
    let args, binary;
    if (c.tool === 'image') {
      const format = fileType(input).replace('image/', '');
      workspaceImagePlan({tool: 'convert', input_format: format, output_format: ext, options, data: input.toString('base64')});
      binary = 'convert';
      args = ['-limit', 'memory', '256MiB', '-limit', 'map', '0', '-limit', 'disk', '64MiB', '-limit', 'width', '8192', '-limit', 'height', '8192', '-limit', 'thread', '2', '-limit', 'time', '25', format + ':/input/0[0]', ...options, ext + ':/output/result'];
    } else {
      binary = 'ffmpeg';
      args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-filter_threads', '2', '-max_alloc', '67108864',
        '-protocol_whitelist', 'file', '-f', mediaFormat(input), '-i', '/input/0', ...options, '-threads', '2', ...(options.includes('-t') ? [] : ['-t', '300']), '-fs', String(MAX_FILE_BYTES), '-map_metadata', '-1', '-f', {mp4:'mp4',webm:'webm',mp3:'mp3',wav:'wav',ogg:'ogg',flac:'flac',png:'image2',jpeg:'image2',gif:'gif'}[ext]];
      if (['png', 'jpeg'].includes(ext)) args.push('-frames:v', '1', '-c:v', ext === 'png' ? 'png' : 'mjpeg', '-update', '1');
      args.push('/output/result');
    }
    signal.throwIfAborted();
    dir = await mkdtemp(join(files.dir, 'job-'));
    await mkdir(join(dir, 'input')); await mkdir(join(dir, 'output'));
    await writeFile(join(dir, 'input', '0'), input, {mode: 0o400, flag: 'wx'});
    const stderr = await nativeJob(dir, binary, args, signal);
    const output = join(dir, 'output', 'result'), stat = await lstat(output);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_FILE_BYTES, 'Invalid or oversized output');
    return {file: await files.write(c.output, await readFile(output), !!c.overwrite, c.tool, signal), stderr};
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(422, 'file_tool_failed', 'Native file runtime unavailable or output could not be read');
  } finally {
    if (dir) await rm(dir, {recursive: true, force: true});
    active--;
  }
}

// Read-only inspection and PDF jobs for the computer shell. Fixed argv per
// tool; callers choose only validated numbers/flags, never paths or options.
const IDENTIFY_FORMAT = /^(?:[^%\x00-\x1f@/\\]|%[whmnbezxyQ%]|\\n){1,128}$/;
export function validateInspect(r) {
  check(r && ['identify', 'ffprobe', 'pdfinfo', 'pdftotext', 'pdftoppm'].includes(r.tool), 'Unknown inspection tool');
  check(typeof r.input === 'string' && r.input.length <= 512, 'Invalid tool input');
  const page = v => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 100000);
  check(page(r.first) && page(r.last), 'Invalid page number');
  if (r.tool === 'identify') check(r.format === undefined || (typeof r.format === 'string' && IDENTIFY_FORMAT.test(r.format)), 'Unsupported identify -format');
  if (r.tool === 'pdftotext') {
    check(r.mode === undefined || ['layout', 'raw'].includes(r.mode), 'Invalid pdftotext mode');
    check(r.output === undefined || typeof r.output === 'string', 'Invalid output');
    if (r.output !== undefined) workPath(r.output);
  }
  if (r.tool === 'pdftoppm') {
    check(['png', 'jpeg'].includes(r.format), 'pdftoppm writes png or jpeg');
    check(r.dpi === undefined || (Number.isInteger(r.dpi) && r.dpi >= 10 && r.dpi <= 300), 'DPI must be 10-300');
    check(r.scale === undefined || (Number.isInteger(r.scale) && r.scale >= 16 && r.scale <= 4096), 'scale-to must be 16-4096');
    check(typeof r.prefix === 'string', 'Output prefix required');
    workPath(r.prefix);
  }
}

export async function runInspectTool(files, r, signal) {
  validateInspect(r);
  check(!files.closed && !signal.aborted, 'Session or code run is closed');
  if (active >= 3) throw new Failure(429, 'file_tools_busy', 'File worker capacity reached');
  active++;
  let dir;
  try {
    const {data} = await files.bytes(r.input);
    const type = fileType(data);
    if (r.tool.startsWith('pdf')) check(type === 'application/pdf', 'Input is not a PDF');
    dir = await mkdtemp(join(files.dir, 'job-'));
    await mkdir(join(dir, 'input')); await mkdir(join(dir, 'output'));
    await writeFile(join(dir, 'input', '0'), data, {mode: 0o400, flag: 'wx'});
    const pages = [...(r.first ? ['-f', String(r.first)] : []), ...(r.last ? ['-l', String(r.last)] : [])];
    switch (r.tool) {
      case 'identify': {
        check(type.startsWith('image/'), 'identify reads PNG, JPEG, GIF or WebP images');
        const format = type.replace('image/', '');
        const {stdout} = await nativeJob(dir, 'identify', ['-limit', 'memory', '256MiB', '-limit', 'map', '0', '-limit', 'disk', '64MiB', '-limit', 'time', '25',
          ...(r.format ? ['-format', r.format] : []), format + ':/input/0'], signal, {stdoutLimit: 65536});
        const name = basename(r.input);
        return {stdout: stdout.toString('utf8').replaceAll(`${format}:/input/0=>/input/0`, name).replaceAll(`${format}:/input/0`, name).replaceAll('/input/0', name)};
      }
      case 'ffprobe': {
        const {stdout} = await nativeJob(dir, 'ffprobe', ['-hide_banner', '-v', 'error', '-protocol_whitelist', 'file', '-f', mediaFormat(data),
          '-show_format', '-show_streams', '-of', 'json', '/input/0'], signal, {stdoutLimit: 1 << 20});
        const info = JSON.parse(stdout.toString('utf8'));
        if (info.format) info.format.filename = basename(r.input);
        return {stdout: JSON.stringify(info, null, 2) + '\n'};
      }
      case 'pdfinfo': {
        const {stdout} = await nativeJob(dir, 'pdfinfo', [...pages, '/input/0'], signal, {stdoutLimit: 1 << 20});
        return {stdout: stdout.toString('utf8')};
      }
      case 'pdftotext': {
        await nativeJob(dir, 'pdftotext', [...pages, ...(r.mode ? ['-' + r.mode] : []), '-enc', 'UTF-8', '/input/0', '/output/result'], signal);
        const text = await readFile(join(dir, 'output', 'result'));
        check(text.length <= MAX_FILE_BYTES, 'Text output exceeds 10 MiB');
        if (r.output === undefined) return {stdout: text.toString('utf8')};
        return {file: await files.write(r.output, text, true, 'pdf', signal)};
      }
      case 'pdftoppm': {
        const first = r.first || 1, last = r.last || first;
        check(last >= first && last - first < 20, 'Render at most 20 pages per call');
        await nativeJob(dir, 'pdftoppm', ['-f', String(first), '-l', String(last), r.format === 'png' ? '-png' : '-jpeg',
          ...(r.scale ? ['-scale-to', String(r.scale)] : ['-r', String(r.dpi || 100)]), '/input/0', '/output/page'], signal);
        const outputs = (await readdir(join(dir, 'output'))).filter(n => /^page-\d+\.(png|jpg)$/.test(n)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
        const written = [];
        for (const name of outputs) {
          const path = join(dir, 'output', name), info = await lstat(path);
          check(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE_BYTES, 'Invalid or oversized page image');
          const pageNumber = Number(/\d+/.exec(name)[0]);
          written.push(await files.write(`${r.prefix}-${pageNumber}.${r.format === 'png' ? 'png' : 'jpg'}`, await readFile(path), true, 'pdf', signal));
        }
        return {files: written};
      }
    }
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(422, 'file_tool_failed', 'Inspection failed or the file is unsupported');
  } finally {
    if (dir) await rm(dir, {recursive: true, force: true});
    active--;
  }
}
