import { isIP, BlockList } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { getDomain } from 'tldts';

export interface AuthPolicy {
  publicOrigin: string;
  origins: readonly string[];
  local: boolean;
  trustProxy: false | string[];
}
export function loopback(address: string): boolean {
  return (
    address === '::1' ||
    (address.startsWith('127.') && isIP(address) === 4) ||
    (address.startsWith('::ffff:127.') && isIP(address) === 6)
  );
}
function origin(text: string): URL {
  const url = new URL(text);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    text === 'null'
  )
    throw new Error('Invalid authentication origin');
  return url;
}
export function readAuthPolicy(env: NodeJS.ProcessEnv = process.env): AuthPolicy {
  const local = env.AUTH_COOKIE_MODE === 'loopback';
  if (!local && env.AUTH_COOKIE_MODE !== 'secure')
    throw new Error('AUTH_COOKIE_MODE must be secure or loopback');
  if (local && env.NODE_ENV === 'production')
    throw new Error('Loopback cookies forbidden in production');
  const publicUrl = origin(env.AUTH_PUBLIC_ORIGIN ?? '');
  const origins = (env.AUTH_ORIGINS ?? '').split(',').map((value) => origin(value.trim()));
  for (const url of [publicUrl, ...origins]) {
    if (local) {
      if (
        url.protocol !== 'http:' ||
        !(url.hostname === 'localhost' || loopback(url.hostname.replace(/^\[|\]$/g, '')))
      )
        throw new Error('Loopback cookie origins must be local HTTP');
      if (url.hostname !== publicUrl.hostname)
        throw new Error('Cross-site loopback origins forbidden');
    } else {
      if (url.protocol !== 'https:') throw new Error('Authentication requires HTTPS');
      // PSL-aware schemeful site check, including private suffixes (e.g. hosting tenants).
      const site = (u: URL) => getDomain(u.hostname, { allowPrivateDomains: true }) ?? u.hostname;
      if (site(url) !== site(publicUrl))
        throw new Error('Cross-site authentication origins forbidden');
    }
  }
  const trustProxy = env.AUTH_TRUST_PROXY
    ? env.AUTH_TRUST_PROXY.split(',').map((value) => value.trim())
    : false;
  if (trustProxy && trustProxy.some((value) => !value || !isIP(value.split('/')[0]!)))
    throw new Error('AUTH_TRUST_PROXY requires explicit IP/CIDR entries');
  if (trustProxy) {
    const check = new BlockList();
    for (const entry of trustProxy) {
      const [ip, prefix, extra] = entry.split('/');
      const bits = isIP(ip!) === 6 ? 128 : 32;
      if (extra || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > bits)))
        throw new Error('Invalid trusted proxy CIDR');
      check.addSubnet(
        ip!,
        prefix === undefined ? bits : Number(prefix),
        bits === 128 ? 'ipv6' : 'ipv4',
      );
    }
  }
  return {
    publicOrigin: publicUrl.origin,
    origins: Object.freeze(origins.map((url) => url.origin)),
    local,
    trustProxy,
  };
}
export function allowedOrigin(policy: AuthPolicy, value: string | undefined): boolean {
  if (!value || value === 'null') return false;
  try {
    return policy.origins.includes(origin(value).origin);
  } catch {
    return false;
  }
}
export function sessionToken(cookie: string | undefined, policy: AuthPolicy): string {
  const name = policy.local ? 'trivia_session' : '__Host-trivia_session';
  const parts = (cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='));
  if (parts.length !== 1) return '';
  const token = parts[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
export function sessionCookie(policy: AuthPolicy, token: string): string {
  return `${policy.local ? 'trivia_session' : '__Host-trivia_session'}=${token}; Path=/; HttpOnly; SameSite=Lax${policy.local ? '' : '; Secure'}${token ? '' : '; Max-Age=0'}`;
}

/** Forwarded TLS is trusted only from explicitly configured proxy addresses. */
export function secureRequest(policy: AuthPolicy, request: IncomingMessage): boolean {
  if (policy.local) return loopback(request.socket.remoteAddress ?? '');
  if ('encrypted' in request.socket && request.socket.encrypted) return true;
  return trustedHttpsProxy(policy, request);
}

function trustedHttpsProxy(policy: AuthPolicy, request: IncomingMessage): boolean {
  const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const trusted = new BlockList();
  for (const entry of policy.trustProxy || []) {
    const [ip, prefix] = entry.split('/');
    const family = isIP(ip!) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) trusted.addAddress(ip!, family);
    else trusted.addSubnet(ip!, Number(prefix), family);
  }
  return (
    !!isIP(address) &&
    trusted.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4') &&
    request.headers['x-forwarded-proto'] === 'https'
  );
}

/** Origin-less browser polling is contextual authorization, never authentication. */
export function allowedSocketRequest(policy: AuthPolicy, request: IncomingMessage): boolean {
  if (!secureRequest(policy, request)) return false;
  if (request.headers.origin !== undefined) return allowedOrigin(policy, request.headers.origin);
  if (
    policy.local ||
    !trustedHttpsProxy(policy, request) ||
    request.method !== 'GET' ||
    request.headers.upgrade !== undefined ||
    request.headers['sec-fetch-site'] !== 'same-origin' ||
    request.headers['sec-fetch-mode'] !== 'cors' ||
    request.headers['sec-fetch-dest'] !== 'empty' ||
    !allowedOrigin(policy, policy.publicOrigin)
  )
    return false;
  try {
    const target = new URL(request.url ?? '', policy.publicOrigin);
    const publicUrl = new URL(policy.publicOrigin);
    const referer = new URL(request.headers.referer ?? '');
    return (
      target.pathname === '/socket.io/' &&
      target.searchParams.getAll('EIO').length === 1 &&
      target.searchParams.get('EIO') === '4' &&
      target.searchParams.getAll('transport').length === 1 &&
      target.searchParams.get('transport') === 'polling' &&
      request.headers.host === publicUrl.host &&
      referer.origin === policy.publicOrigin &&
      !referer.username &&
      !referer.password
    );
  } catch {
    return false;
  }
}
