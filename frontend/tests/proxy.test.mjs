import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import configuration from '../proxy.conf.mjs';

const [pattern, options] = Object.entries(configuration)[0];

test('HTTP and upgrade forwarding replace untrusted headers using actual TLS peer data', () => {
  for (const event of ['proxyReq', 'proxyReqWs']) {
    for (const hostField of ['host', ':authority']) {
      const proxy = new EventEmitter();
      options.configure(proxy);
      const headers = new Map(
        Object.entries({
          origin: 'https://unapproved.example',
          cookie: 'opaque=fixture',
          forwarded: 'for=spoofed',
          'x-forwarded-for': 'spoofed',
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'spoofed',
        }),
      );
      const outgoing = {
        getHeaderNames: () => [...headers.keys()],
        removeHeader: (key) => headers.delete(key),
        setHeader: (key, value) => {
          assert.notEqual(value, undefined);
          headers.set(key, value);
        },
      };
      proxy.emit(event, outgoing, {
        socket: { encrypted: true, remoteAddress: '127.0.0.1' },
        headers: { [hostField]: 'localhost:4200' },
      });
      assert.equal(headers.get('origin'), 'https://unapproved.example');
      assert.equal(headers.get('cookie'), 'opaque=fixture');
      assert.equal(headers.has('forwarded'), false);
      assert.equal(headers.get('x-forwarded-for'), '127.0.0.1');
      assert.equal(headers.get('x-forwarded-proto'), 'https');
      assert.equal(headers.get('host'), 'localhost:4200');
    }
  }
});

test('client-forwarded HTTPS cannot substitute for incoming TLS', () => {
  const proxy = new EventEmitter();
  options.configure(proxy);
  let destroyed = false;
  proxy.emit(
    'proxyReq',
    {
      destroy: () => {
        destroyed = true;
      },
    },
    {
      socket: { encrypted: false, remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-proto': 'https' },
    },
  );
  assert.equal(destroyed, true);
});

test('proxy includes route roots, query strings and descendants but excludes SPA paths', () => {
  const match = new RegExp(pattern);
  for (const path of [
    '/auth/login',
    '/history',
    '/history?limit=20',
    '/history/id',
    '/socket.io/?EIO=4',
  ])
    assert.equal(match.test(path), true);
  for (const path of ['/', '/play/history', '/history-extra', '/socketXio/'])
    assert.equal(match.test(path), false);
});
