// The desktop-capture endpoint hands out a picture of the user's screen, so it must be locked down.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server.js';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let calls = 0, lastKind, srv, base;
test.before(async () => { srv = await startServer({ port: 0, capture: async (kind) => { calls++; lastKind = kind; return JPEG; } }); base = `http://127.0.0.1:${srv.port}`; });
test.after(() => srv.close());
// fetch() cannot set Host, so use a raw request (this is also what DNS rebinding looks like to the server)
const raw = (path, headers, method = 'POST') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
  req.on('error', reject); req.end();
});
const post = (path, headers = {}, method = 'POST') => (headers.host ? raw(path, headers, method) : fetch(base + path, { method, headers }));

test('capture: right token + same origin returns the image bytes', async () => {
  const r = await post(`/capture?t=${srv.token}`, { origin: base });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
});

test('capture: kind picks wallpaper or screen (screen by default); anything else is a 400', async () => {
  await post(`/capture?t=${srv.token}&kind=wallpaper`, { origin: base }); assert.equal(lastKind, 'wallpaper');
  await post(`/capture?t=${srv.token}&kind=screen`, { origin: base }); assert.equal(lastKind, 'screen');
  await post(`/capture?t=${srv.token}`, { origin: base }); assert.equal(lastKind, 'screen');
  const before = calls;
  assert.equal((await post(`/capture?t=${srv.token}&kind=../../etc/passwd`, { origin: base })).status, 400);
  assert.equal(calls, before);
});

test('capture: refused without the token, with a wrong token, or from another origin, and nothing is captured', async () => {
  const before = calls;
  for (const [path, headers] of [
    ['/capture', { origin: base }],
    ['/capture?t=wrong', { origin: base }],
    [`/capture?t=${srv.token}`, {}],                                // no Origin (e.g. curl)
    [`/capture?t=${srv.token}`, { origin: 'http://evil.example' }], // another web page
    [`/capture?t=${srv.token}`, { origin: base, host: 'evil.example' }],
  ]) {
    const r = await post(path, headers).catch(() => ({ status: 'blocked' }));
    assert.ok(r.status === 403 || r.status === 'blocked', `${path} ${JSON.stringify(headers)} -> ${r.status}`);
  }
  assert.equal(calls, before);
});

test('capture: GET is not allowed, and a failing capture gives a helpful 500', async () => {
  assert.equal((await post(`/capture?t=${srv.token}`, { origin: base }, 'GET')).status, 405);
  const bad = await startServer({ port: 0, capture: async () => { throw new Error('denied'); } });
  const b = `http://127.0.0.1:${bad.port}`;
  const r = await fetch(`${b}/capture?t=${bad.token}`, { method: 'POST', headers: { origin: b } });
  assert.equal(r.status, 500);
  assert.match(await r.text(), /Screen Recording/);
  bad.close();
});
