/**
 * The publish UPDATE against a real PostgREST and Postgres (CI job
 * "postgrest", schema in tests/postgrest-live/schema.sql). Skipped unless
 * PGRST_LIVE_URL is set.
 *
 * routes.test.ts models PostgREST in memory; this checks the model where it
 * was wrong. On 2026-11-03 every production publish failed with "column
 * posts.is_hidden does not exist": PostgREST also applies the UPDATE's
 * or=(...) filters to the rows it returns, and only id was selected.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const LIVE = process.env.PGRST_LIVE_URL;
const skip = !LIVE && 'PGRST_LIVE_URL is not set (runs in the CI postgrest job)';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HLS = (n: number) =>
  `https://ref.supabase.co/storage/v1/object/public/FlutterFlow/converted/${id(n)}/hls/v1793739362281-abcd1234/master.m3u8`;

let proxy: http.Server | undefined;
let store: any;

before(async () => {
  if (!LIVE) return;
  // supabase-js calls <url>/rest/v1/...; PostgREST serves at its root and,
  // with no JWT secret, takes requests without a token as its anon role.
  proxy = http.createServer((req, res) => {
    const target = new URL(req.url!.replace(/^\/rest\/v1/, '') || '/', LIVE);
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.apikey;
    delete headers.host;
    const up = http.request(target, { method: req.method, headers }, r => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', e => { res.statusCode = 502; res.end(String(e)); });
    req.pipe(up);
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', () => resolve()));
  const port = (proxy.address() as { port: number }).port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const { SupabaseStorageService } = await import('../src/services/supabase.js');
  store = new SupabaseStorageService();
});

after(() => { proxy?.close(); });

test('a unified private video in the General Feed gets its hls_url (the production failure)', { skip }, async () => {
  const post = await store.getPostForHls(id(1));
  assert.ok(post, 'seeded post is readable');
  assert.equal(await store.publishHlsUrl(post, HLS(1)), true);
  assert.equal(await store.getHlsUrl(id(1)), HLS(1));
  // The first finished attempt wins: a second publish changes nothing.
  assert.equal(await store.publishHlsUrl(post, HLS(1).replace('abcd1234', 'efgh5678')), false);
  assert.equal(await store.getHlsUrl(id(1)), HLS(1));
});

test('a legacy public post gets its hls_url', { skip }, async () => {
  const post = await store.getPostForHls(id(2));
  assert.equal(await store.publishHlsUrl(post, HLS(2)), true);
  assert.equal(await store.getHlsUrl(id(2)), HLS(2));
});

test('a post hidden after it was read is not published', { skip }, async () => {
  const post = await store.getPostForHls(id(3));
  assert.equal(post.is_hidden, false);
  const r = await fetch(`${LIVE}/posts?id=eq.${id(3)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ is_hidden: true }),
  });
  assert.ok(r.ok, `hide the post: ${r.status}`);
  assert.equal(await store.publishHlsUrl(post, HLS(3)), false);
  assert.equal(await store.getHlsUrl(id(3)), null);
});
