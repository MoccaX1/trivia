import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import httpProxy from 'http-proxy';
import configuration from '../proxy.conf.mjs';

// Angular's pre-proxy middleware throws on malformed URLs. Terminate TLS here so
// backend paths reach Fastify directly, without adding a separate Docker service.
const [[, backendOptions]] = Object.entries(configuration);
const backend = httpProxy.createProxyServer(backendOptions);
const angular = httpProxy.createProxyServer({ target: 'http://127.0.0.1:4201', ws: true });
backendOptions.configure(backend);
for (const proxy of [backend, angular]) {
  proxy.on('error', (_error, _request, response) => {
    if ('writeHead' in response && !response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'DEVELOPMENT_PROXY_UNAVAILABLE' }));
    } else response.destroy();
  });
}

function destination(url = '/') {
  // Decode for routing only. Forward the original URL unchanged to the backend.
  const path = decodeURI(url.split('?')[0]);
  return /^\/(auth|history|socket\.io)(\/|$)/.test(path) ? backend : angular;
}

const server = createServer(
  {
    key: readFileSync('.certs/localhost-key.pem'),
    cert: readFileSync('.certs/localhost.pem'),
  },
  (request, response) => {
    try {
      destination(request.url).web(request, response);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'INVALID_REQUEST' }));
    }
  },
);
server.on('upgrade', (request, socket, head) => {
  try {
    destination(request.url).ws(request, socket, head);
  } catch {
    socket.destroy();
  }
});
const child = spawn(
  process.execPath,
  [
    'node_modules/@angular/cli/bin/ng.js',
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    '4201',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
server.listen(4200, '0.0.0.0', () =>
  console.log('Trivia development HTTPS: https://localhost:4200'),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  server.close();
  server.closeAllConnections();
  backend.close();
  angular.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
child.once('exit', (code) => {
  const expected = stopping;
  stop();
  process.exitCode = expected ? 0 : (code ?? 1);
});
