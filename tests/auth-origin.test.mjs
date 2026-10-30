import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('generated auth checks use only configured public origins before forwarding cookies', async () => {
  const js = await readFile(join(root, 'examples/next-js/lib/auth.js'), 'utf8');
  const ts = await readFile(join(root, 'examples/next-ts/lib/auth.ts'), 'utf8');
  for (const source of [js, ts]) {
    assert.match(source, /WAVEBIRD_PUBLIC_ORIGINS/);
    assert.match(source, /new URL\(path, trustedOrigin\)/);
    assert.match(source, /redirect: "manual", signal: AbortSignal\.timeout\(1500\)/);
    assert.doesNotMatch(source, /new URL\(path, request\.url\)/);
  }

  const moduleSource = js.replace('import "server-only";', '');
  const { sessionIdForRequest } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  const oldFetch = globalThis.fetch;
  const oldPath = process.env.PUBLISHER_AUTH_CHECK_PATH;
  const oldOrigins = process.env.WAVEBIRD_PUBLIC_ORIGINS;
  const calls = [];
  try {
    process.env.PUBLISHER_AUTH_CHECK_PATH = '/auth/check';
    process.env.WAVEBIRD_PUBLIC_ORIGINS = 'https://publisher.example, https://other.example';
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), cookie: init.headers.cookie, redirect: init.redirect, signal: init.signal });
      return new Response(null, { status: 204, headers: { 'x-publisher-session-id': 'synthetic-session' } });
    };
    const request = url => new Request(url, { headers: { cookie: 'session=synthetic-test-only' } });
    assert.equal(await sessionIdForRequest(request('https://attacker.invalid/api/sponsor-session')), null);
    assert.equal(await sessionIdForRequest(request('https://publisher.example.evil/api/sponsor-session')), null);
    assert.equal(calls.length, 0, 'unconfigured hosts must not receive the cookie');

    assert.equal(await sessionIdForRequest(request('https://publisher.example/api/sponsor-session')), 'synthetic-session');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://publisher.example/auth/check');
    assert.equal(calls[0].cookie, 'session=synthetic-test-only');
    assert.equal(calls[0].redirect, 'manual');
    assert.ok(calls[0].signal instanceof AbortSignal);

    process.env.WAVEBIRD_PUBLIC_ORIGINS = '';
    assert.equal(await sessionIdForRequest(request('https://publisher.example/api/sponsor-session')), null);
    assert.equal(calls.length, 1);

    process.env.WAVEBIRD_PUBLIC_ORIGINS = 'https://publisher.example';
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), cookie: init.headers.cookie });
      return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
    };
    assert.equal(await sessionIdForRequest(request('https://publisher.example/api/sponsor-session')), null);
    assert.equal(calls.at(-1).url, 'https://publisher.example/auth/check');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) delete process.env.PUBLISHER_AUTH_CHECK_PATH;
    else process.env.PUBLISHER_AUTH_CHECK_PATH = oldPath;
    if (oldOrigins === undefined) delete process.env.WAVEBIRD_PUBLIC_ORIGINS;
    else process.env.WAVEBIRD_PUBLIC_ORIGINS = oldOrigins;
  }
});
