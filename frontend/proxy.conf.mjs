// The local HTTPS termination boundary. Never rewrite browser Origin.
function forwardSecureRequest(outgoing, incoming) {
  if (!incoming.socket.encrypted || !incoming.socket.remoteAddress) {
    outgoing.destroy(new Error('The development proxy requires real incoming TLS'));
    return;
  }
  for (const name of outgoing.getHeaderNames()) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) outgoing.removeHeader(name);
  }
  outgoing.setHeader('x-forwarded-proto', 'https');
  outgoing.setHeader('x-forwarded-for', incoming.socket.remoteAddress);
  // HTTP/2 carries :authority instead of Host. Both must survive the HTTP/1 hop.
  const host = incoming.headers.host ?? incoming.headers[':authority'];
  if (host) {
    outgoing.setHeader('host', host);
    outgoing.setHeader('x-forwarded-host', host);
  }
}

export default {
  '^/(auth|history|socket\\.io)(/|\\?|$)': {
    target: process.env['TRIVIA_PROXY_TARGET'] ?? 'http://backend:3000',
    changeOrigin: false,
    ws: true,
    configure(proxy) {
      proxy.on('proxyReq', forwardSecureRequest);
      proxy.on('proxyReqWs', forwardSecureRequest);
    },
  },
};
