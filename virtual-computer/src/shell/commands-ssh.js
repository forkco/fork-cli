import {ShellError} from './parse.js';
import {resolvePath, display} from './interpreter.js';
import {command} from './commands.js';

// Client options end at the host/first operand. Remote command options belong
// to the remote command. Destination, credentials and forwarding come only
// from the registry; never silently ignore an option that would change them.
function operands(argv, allowed) {
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--') { i++; break; }
    if (!argv[i].startsWith('-') || argv[i] === '-') break;
    if (!/^-[A-Za-z0-9]+$/.test(argv[i]) || [...argv[i].slice(1)].some(c => !allowed.includes(c)))
      throw new ShellError(`${argv[i]}: unsupported client option; configure the registered host instead`, 2);
  }
  return argv.slice(i);
}

// ssh LABEL COMMAND...   — run COMMAND on a registered host, stream its output.
// Not an interactive shell: one command per call, like `ssh host 'cmd'`.
command('ssh', async io => {
  const rest = operands(io.argv.slice(1), 'qvTC46');
  if (!rest.length) throw new ShellError('usage: ssh HOST COMMAND...   (HOST is a label from your SSH hosts; runs one command)', 2);
  const label = rest[0];
  const commandLine = rest.slice(1).join(' ');
  if (!commandLine) throw new ShellError('a remote command is required (interactive sessions are unavailable); e.g. ssh myhost "uname -a"', 2);
  const result = await io.vfs.ssh('exec', {label, command: commandLine, stdin: io.stdin().toString('utf8')});
  if (result.stdout) io.out(result.stdout);
  if (result.stderr) io.err(result.stderr);
  if (result.timedOut) io.err('ssh: remote command timed out\n');
  return result.code;
});

// scp [LABEL:]SRC [LABEL:]DST — copy one file between /work and a host.
function remoteSpec(arg) {
  const match = /^([^/:][^:]*):(.+)$/.exec(arg);
  return match ? {label: match[1], path: match[2]} : null;
}

command('scp', async io => {
  const rest = operands(io.argv.slice(1), 'qvC');
  if (rest.length !== 2) throw new ShellError('usage: scp [HOST:]SRC [HOST:]DST   (one side is HOST:path, the other a /work path)', 2);
  const src = remoteSpec(rest[0]), dst = remoteSpec(rest[1]);
  if (src && dst) throw new ShellError('scp between two remote hosts is unavailable', 2);
  if (!src && !dst) throw new ShellError('one side must be HOST:path', 2);
  if (dst) {
    // upload: local /work file -> host
    const data = await io.vfs.read(resolvePath(io.cwd, rest[0]));
    const result = await io.vfs.ssh('upload', {label: dst.label, remotePath: dst.path, data});
    io.err(`${rest[0]} -> ${rest[1]} [${result.bytes}]\n`);
    return 0;
  }
  // download: host -> local /work file
  const result = await io.vfs.ssh('download', {label: src.label, remotePath: src.path});
  let target = rest[1];
  const entry = await io.vfs.stat(resolvePath(io.cwd, target)).catch(() => null);
  if (entry?.kind === 'dir') target = target.replace(/\/?$/, '/') + src.path.split('/').pop();
  await io.vfs.write(resolvePath(io.cwd, target), result.data, true);
  io.err(`${rest[0]} -> ${display(resolvePath(io.cwd, target))} [${result.data.length}]\n`);
  return 0;
});
