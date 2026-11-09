import http from 'node:http';
import https from 'node:https';
import {webURL, resolvePublic} from './network.js';
import {Failure, check} from './errors.js';
import {MAX_FILE_BYTES} from './browser-files.js';

// Public downloads do not inherit browser cookies or controller credentials.
// Every redirect is checked and connected to its checked IP, never re-resolved.
export async function downloadWorkFile(raw, signal, hops = 0, headers = {}) {
  check(hops <= 5, 'Too many download redirects');
  signal.throwIfAborted();
  const url = webURL(raw), address = await resolvePublic(url.hostname);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request({
      hostname: address.address, family: address.family, servername: url.hostname,
      port: url.protocol === 'https:' ? 443 : 80, path: url.pathname + url.search,
      headers: {accept: '*/*', ...headers, host: url.host, 'user-agent': 'Fork-Computer/1.0'},
      agent: false, signal, timeout: 20000,
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.destroy();
        resolve(downloadWorkFile(new URL(response.headers.location, url).href, signal, hops + 1, headers));
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy(); reject(new Failure(422, 'download_failed', `Download returned HTTP ${response.statusCode}`)); return;
      }
      if (Number(response.headers['content-length']) > MAX_FILE_BYTES) {
        response.destroy(); reject(new Failure(413, 'file_size_limit', 'Download exceeds 10 MiB')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) request.destroy(new Failure(413, 'file_size_limit', 'Download exceeds 10 MiB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Failure(504, 'download_timeout', 'Download timed out')));
    request.on('error', reject);
    request.end();
  });
}
