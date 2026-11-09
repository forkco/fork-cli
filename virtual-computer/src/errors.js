export class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function check(ok, message) { if (!ok) throw new Failure(400, 'invalid_request', message); }
