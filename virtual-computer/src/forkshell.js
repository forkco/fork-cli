import {Failure, check} from './errors.js';

// No local shell, user JWT, caller-selected destination or caller-selected identity.
export class ForkShell {
  constructor(config, request = fetch) { this.url = config.shellURL; this.request = request; this.active = 0; }
  async run(body, signal) {
    if (!this.url) throw new Failure(503, 'shell_unavailable', 'Fork shell is not configured');
    const url = new URL(this.url);
    check(!url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))), 'Shell transport requires TLS or loopback');
    check(typeof body.shell_grant === 'string' && body.shell_grant.length <= 2048, 'Backend shell grant required');
    const c = body.command;
    check(c && c.action === 'shell' && Object.keys(c).every(k => ['action','command','cwd','stdin'].includes(k)), 'Invalid shell command fields');
    check(typeof c.command === 'string' && c.command.length > 0 && Buffer.byteLength(c.command) <= 16384, 'Invalid shell command');
    check(c.stdin === undefined || (typeof c.stdin === 'string' && Buffer.byteLength(c.stdin) <= 256*1024), 'Shell stdin exceeds limit');
    check(c.cwd === undefined || c.cwd === '' || (typeof c.cwd === 'string' && Buffer.byteLength(c.cwd) <= 1024 && c.cwd.startsWith('/')), 'Invalid virtual cwd');
    if (this.active >= 8) throw new Failure(429, 'shell_busy', 'Fork shell is busy');
    this.active++;
    try {
      const command = {command:c.command, ...(c.cwd ? {cwd:c.cwd} : {}), ...(c.stdin ? {stdin:c.stdin} : {})};
      const response = await this.request(this.url, {method:'POST', redirect:'error',
        headers:{'content-type':'application/json'},body:JSON.stringify({grant:body.shell_grant,command}),
        signal:AbortSignal.any([AbortSignal.timeout(35000), ...(signal ? [signal] : [])])});
      if (!response.ok) {
        await response.body?.cancel();
        const status = [400,403,409,429].includes(response.status) ? response.status : 503;
        throw new Failure(status, 'shell_rejected', 'Fork shell rejected or could not execute this command. Do not retry mutations automatically.');
      }
      const chunks=[]; let size=0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2*1024*1024) throw new Error('oversized shell response');
        chunks.push(chunk);
      }
      const result=JSON.parse(Buffer.concat(chunks).toString());
      check(typeof result.stdout === 'string' && typeof result.stderr === 'string' && Number.isInteger(result.exit_code) && typeof result.cwd === 'string', 'Invalid shell result');
      return {stdout:result.stdout,stderr:result.stderr,exit_code:result.exit_code,cwd:result.cwd,truncated:result.truncated===true};
    } catch(error) {
      if (error instanceof Failure) throw error;
      throw new Failure(503, 'shell_unavailable', 'Fork shell response unavailable; an operation may have completed. Do not retry mutations automatically.');
    } finally { this.active--; }
  }
}
