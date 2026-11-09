import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { check } from './errors.js';

export function publicIP(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export function webURL(raw) {
  let u;
  try { u = new URL(raw); } catch { check(false, 'A valid http(s) URL is required'); }
  check(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password, 'Only http(s) URLs without credentials are allowed');
  check(!u.port || u.port === (u.protocol === 'https:' ? '443' : '80'), 'Only standard web ports are allowed');
  return u;
}
export async function resolvePublic(host, resolver = lookup) {
  host = host.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{address: host, family: net.isIP(host)}] : await resolver(host, {all: true});
  check(records.length > 0 && records.every(r => publicIP(r.address)), 'Private or reserved network destination denied');
  return records[0];
}

// The proxy connects to the exact checked IP, so DNS rebinding cannot cause a
// second, unchecked lookup. All Chromium HTTP(S) traffic uses this proxy.
export async function startProxy() {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer(async (req, res) => {
    try {
      const u = webURL(req.url);
      check(u.protocol === 'http:', 'Use CONNECT for HTTPS');
      const address = await resolvePublic(u.hostname);
      if (req.destroyed) return;
      const headers = {...req.headers, host: u.host};
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = http.request({hostname: address.address, family: address.family, port: 80,
        path: u.pathname + u.search, method: req.method, headers, agent: false}, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Destination denied'); }
  });
  server.on('connect', async (req, client, head) => {
    try {
      const u = webURL('https://' + req.url);
      check(u.pathname === '/' && !u.search && !u.hash, 'Invalid CONNECT target');
      const address = await resolvePublic(u.hostname);
      if (client.destroyed) return;
      const upstream = track(net.connect({host: address.address, family: address.family, port: 443}));
      upstream.setTimeout(30_000, () => upstream.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection', track);
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }};
}
