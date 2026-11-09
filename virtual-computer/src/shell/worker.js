// One shell command line per Worker: parse and run builtins here, touch files
// only through the parent's RPC. Deadline and heap limits are enforced by the
// parent; this thread has no environment, network or file access of its own.
import {parentPort, workerData} from 'node:worker_threads';
import {Shell} from './interpreter.js';
import {ShellError} from './parse.js';

let sequence = 0;
const pending = new Map();
parentPort.on('message', message => {
  if (message?.kind !== 'reply') return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error !== undefined) request.reject(Object.assign(new ShellError(message.error), {code: message.code}));
  else request.resolve(message.value);
});
const rpc = (op, fields = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, {resolve, reject});
  parentPort.postMessage({kind: 'rpc', id, op, ...fields});
});

const backend = {
  list: () => rpc('list'),
  read: async path => (await rpc('read', {path})).data,
  write: (path, data, overwrite) => rpc('write', {path, data, overwrite}),
  remove: path => rpc('remove', {path}),
  rename: (from, to, overwrite) => rpc('rename', {from, to, overwrite}),
  mkdir: path => rpc('mkdir', {path}),
  rmdir: path => rpc('rmdir', {path}),
  tool: request => rpc('tool', {request}),
  inspect: request => rpc('inspect', {request}),
  page: async (name, arg) => { const value = await rpc('page', {name, arg}); return value?.data ?? value; },
  ssh: (sshOp, args) => rpc('ssh', {sshOp, args}),
  download: async (url, headers, path, overwrite) => { const value = await rpc('download', {url, headers, path, overwrite}); return value?.data ?? value; },
};

try {
  const shell = new Shell(backend, {cwd: workerData.cwd, stdin: workerData.stdin});
  parentPort.postMessage({kind: 'done', result: await shell.run(workerData.command)});
} catch (error) {
  parentPort.postMessage({kind: 'failed', message: String(error?.message || error).slice(0, 2048)});
}
