/**
 * End-to-end tests of the conversion, revoke and reconcile paths against an
 * in-memory stand-in for Supabase (PostgREST, Storage, the reconcile-queue
 * RPCs) and the real bundled ffmpeg. No network and no real project:
 * SUPABASE_URL points at the stand-in. The stand-in can inject faults: failed
 * uploads, failed or committed-then-failed UPDATEs, failed reads, a queue
 * that is down, and row changes in the middle of a conversion.
 *
 * Database triggers are not modelled here; taygram-backend's harness tests
 * those (supabase/proposals/hls-unified/queue_test.sql). Tests put queue
 * entries in directly.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

type Row = Record<string, any>;

const KEY = 'test-key';
const BASE = 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOUR = 3_600_000;

const posts = new Map<string, Row>();
const deletionJobs: Row[] = [];
const objects = new Map<string, { data: Buffer; modifiedAt: number }>(); // "<bucket>/<path>"
const queue = new Map<string, { post_id: string; queued_at: string; attempts: number; next: number; last_error?: string }>();
const faults = {
  /** post id -> run once on that post's Nth HLS upload (1-based) */
  onUpload: new Map<string, { n: number; run: () => void; seen?: number }>(),
  /** post id -> fail the Nth HLS upload with a 500 */
  failUpload: new Map<string, number>(),
  /**
   * post id -> 'error' (500, nothing written) | 'commit-then-error' (written,
   * then 500) | 'commit-then-unreadable' (written, 500, and reads fail after)
   */
  patch: new Map<string, 'error' | 'commit-then-error' | 'commit-then-unreadable'>(),
  /** post ids whose reads fail */
  failRead: new Set<string>(),
  /** fail storage removals under this prefix */
  failRemove: new Set<string>(),
  queueDown: false,
  /** the auto-convert functions do not exist (backend SQL not applied) */
  autoMissing: false,
  /** "<bucket>/<path>" -> delay storage reads of that object by this many ms */
  slowGet: new Map<string, number>(),
  /** post ids whose lease renewals never get an answer */
  hangRenew: new Set<string>(),
  /** post ids whose HLS uploads never get an answer, but are stored anyway once the client gives up */
  hangUpload: new Set<string>(),
  /** the next N claim requests never get an answer */
  hangClaims: 0,
  /** post ids whose result recording never gets an answer */
  hangResult: new Set<string>(),
};
/** hls_claim_autoconvert stand-in: posts the database would offer, and the recorded results. */
const auto = {
  offer: [] as string[],
  attempts: new Map<string, number>(),
  /** the current claim token per post; renew and result must name it */
  tokens: new Map<string, string>(),
  /** posts whose claim another task has taken over: renewals are refused */
  lostClaims: new Set<string>(),
  results: new Map<string, { error: string | null; final: boolean }>(),
  /** claim/renew/result calls in order, e.g. "claim <id>" */
  events: [] as string[],
  claims: 0, calls: 0,
  /** hung renewals the client gave up on */
  renewAborted: 0,
  /** uploads stored after the client had given up on them */
  lateWrites: 0,
  /** hung claim / result requests the client gave up on */
  claimAborted: 0,
  resultAborted: 0,
};
const sent: { patches: string[] } = { patches: [] };

function privPost(n: number, over: Row = {}): Row {
  return {
    id: id(n), profile_id: `profile-${n}`, video_url: null, hls_url: null,
    media_bucket: 'unfiltered', media_path: `u${n}/v.mp4`, media_count: 1,
    post_type: 'video', channel: 'standard', in_general_feed: true, type: 'UNFILTERED',
    is_hidden: false, is_vip: false, expires_at: null, ...over,
  };
}

/** PostgREST filter evaluation for the filters the service sends. */
function matches(row: Row, params: URLSearchParams): boolean {
  const one = (col: string, expr: string): boolean => {
    const dot = expr.indexOf('.');
    const op = expr.slice(0, dot);
    const v = expr.slice(dot + 1);
    const cell = row[col];
    const present = cell !== null && cell !== undefined;
    switch (op) {
      case 'eq': return present && String(cell) === v;
      case 'neq': return !present || String(cell) !== v;
      case 'is': return v === 'null' ? !present : String(cell) === v;
      case 'gt': return present && Date.parse(String(cell)) > Date.parse(v);
      case 'in': return present && v.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(cell));
      case 'like': {
        const re = new RegExp('^' + v.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return typeof cell === 'string' && re.test(cell);
      }
      default: throw new Error(`unsupported filter ${op}`);
    }
  };
  for (const [k, v] of params) {
    if (k === 'select' || k === 'limit') continue;
    if (k === 'or') {
      const parts = v.replace(/^\(|\)$/g, '').split(',');
      if (!parts.some(p => { const d = p.indexOf('.'); return one(p.slice(0, d), p.slice(d + 1)); })) return false;
      continue;
    }
    if (!one(k, v)) return false;
  }
  return true;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://mock');
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  };
  const raw = await readBody(req);
  const pid = (u.searchParams.get('id') ?? '').replace('eq.', '');

  if (u.pathname === '/rest/v1/posts') {
    if (faults.failRead.has(pid) && req.method === 'GET') return send(500, { message: 'simulated read failure' });
    const rows = [...posts.values()].filter(r => matches(r, u.searchParams));
    if (req.method === 'GET') return send(200, rows);
    if (req.method === 'PATCH') {
      // Real PostgREST (v12.2.12 and v13.0.7, checked 2026-11-03) also applies
      // an or=(...) filter to the rows a mutation returns, so every column it
      // names must be in select=, or the UPDATE fails with 42703. Production
      // failed this way on every publish ("column posts.is_hidden does not
      // exist"); the stand-in now does too.
      const selected = new Set((u.searchParams.get('select') ?? '*').split(',').map(s => s.trim()));
      for (const orExpr of u.searchParams.getAll('or')) {
        for (const part of orExpr.replace(/^\(|\)$/g, '').split(',')) {
          const col = part.slice(0, part.indexOf('.'));
          if (!selected.has('*') && !selected.has(col)) {
            return send(400, { code: '42703', message: `column posts.${col} does not exist` });
          }
        }
      }
      sent.patches.push(pid);
      const mode = faults.patch.get(pid);
      if (mode === 'error') return send(500, { message: 'simulated database failure' });
      const patch = JSON.parse(raw.toString());
      rows.forEach(r => Object.assign(r, patch));
      if (mode === 'commit-then-unreadable') faults.failRead.add(pid);
      if (mode === 'commit-then-error' || mode === 'commit-then-unreadable') {
        return send(500, { message: 'simulated failure after commit' });
      }
      return send(200, rows.map(r => ({ id: r.id })));
    }
  }
  if (u.pathname === '/rest/v1/account_deletion_jobs') {
    const profile = (u.searchParams.get('profile_id') ?? '').replace('eq.', '');
    return send(200, deletionJobs.filter(j => j.profile_id === profile).map(j => ({ id: j.id })));
  }
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    if (u.pathname.endsWith('/hls_claim_autoconvert')) auto.calls++;
    if (faults.queueDown) return send(503, { message: 'simulated queue outage' });
    const args = raw.length ? JSON.parse(raw.toString()) : {};
    switch (u.pathname.slice('/rest/v1/rpc/'.length)) {
      case 'hls_claim_reconcile': {
        const now = Date.now();
        const due = [...queue.values()].filter(q => q.next <= now).slice(0, args.p_limit);
        due.forEach(q => { q.attempts++; q.next = now + 100; });
        return send(200, due.map(q => ({ post_id: q.post_id, queued_at: q.queued_at, attempts: q.attempts })));
      }
      case 'hls_complete_reconcile': {
        const q = queue.get(args.p_post_id);
        const ok = !!q && q.queued_at === args.p_queued_at;
        if (ok) queue.delete(args.p_post_id);
        return send(200, ok);
      }
      case 'hls_fail_reconcile': {
        const q = queue.get(args.p_post_id);
        if (q) q.last_error = args.p_error;
        return send(200, null);
      }
      case 'hls_enqueue_reconcile':
        return send(200, 0);
      case 'hls_claim_autoconvert': {
        if (faults.autoMissing) return send(404, { code: 'PGRST202', message: 'Could not find the function public.hls_claim_autoconvert' });
        if ('p_limit' in args) return send(400, { message: 'mock: a claim is one post (no p_limit)' });
        if (faults.hangClaims > 0) {
          faults.hangClaims--;
          auto.events.push('claim hung');
          res.on('close', () => { auto.claimAborted++; });
          return; // never answered
        }
        auto.claims++;
        const p = auto.offer.shift();
        if (!p) return send(200, []);
        const n = (auto.attempts.get(p) ?? 0) + 1;
        auto.attempts.set(p, n);
        const token = `token-${p}-${n}`;
        auto.tokens.set(p, token);
        auto.events.push(`claim ${p}`);
        return send(200, [{ post_id: p, attempts: n, claim_token: token, lease_until: new Date().toISOString() }]);
      }
      case 'hls_autoconvert_renew': {
        if (faults.hangRenew.has(args.p_post_id)) {
          auto.events.push(`renew ${args.p_post_id} hung`);
          res.on('close', () => { auto.renewAborted++; });
          return; // never answered
        }
        const ok = auto.tokens.get(args.p_post_id) === args.p_claim_token && !auto.lostClaims.has(args.p_post_id);
        auto.events.push(`renew ${args.p_post_id} ${ok}`);
        return send(200, ok);
      }
      case 'hls_autoconvert_result': {
        if (faults.hangResult.has(args.p_post_id)) {
          auto.events.push(`result ${args.p_post_id} hung`);
          res.on('close', () => { auto.resultAborted++; });
          return; // never answered
        }
        const ok = auto.tokens.get(args.p_post_id) === args.p_claim_token && !auto.lostClaims.has(args.p_post_id);
        auto.events.push(`result ${args.p_post_id} ${ok}`);
        if (ok) {
          auto.tokens.delete(args.p_post_id);
          auto.results.set(args.p_post_id, { error: args.p_error, final: args.p_final });
        }
        return send(200, ok);
      }
    }
  }
  if (u.pathname.startsWith('/storage/v1/object/list/')) {
    const bucket = u.pathname.split('/').pop();
    const { prefix, limit = 100, offset = 0 } = JSON.parse(raw.toString());
    const base = `${bucket}/${prefix}/`;
    const files: Row[] = [];
    const dirs = new Set<string>();
    for (const [k, v] of objects) {
      if (!k.startsWith(base)) continue;
      const rest = k.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const t = new Date(v.modifiedAt).toISOString();
        files.push({ name: rest, id: `obj-${rest}`, updated_at: t, created_at: t });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    const all = [...[...dirs].sort().map(d => ({ name: d, id: null })), ...files.sort((a, b) => a.name.localeCompare(b.name))];
    return send(200, all.slice(offset, offset + limit));
  }
  if (u.pathname.startsWith('/storage/v1/object/')) {
    const key = decodeURIComponent(u.pathname.slice('/storage/v1/object/'.length));
    if (req.method === 'DELETE') {
      const { prefixes } = JSON.parse(raw.toString());
      for (const p of prefixes) {
        if ([...faults.failRemove].some(f => `${key}/${p}`.startsWith(f))) {
          return send(500, { statusCode: '500', error: 'internal', message: 'simulated remove failure' });
        }
      }
      for (const p of prefixes) objects.delete(`${key}/${p}`);
      return send(200, prefixes.map((p: string) => ({ name: p })));
    }
    if (req.method === 'GET') {
      const delay = faults.slowGet.get(key);
      if (delay) await sleep(delay);
      const o = objects.get(key);
      if (!o) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.statusCode = 200;
      return res.end(o.data);
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const m = /^FlutterFlow\/converted\/([^/]+)\/hls\//.exec(key);
      if (m && faults.hangUpload.has(m[1])) {
        // Never answered; storage still stores it once the client has gone.
        res.on('close', () => setTimeout(() => {
          objects.set(key, { data: raw, modifiedAt: Date.now() });
          auto.lateWrites++;
        }, 100));
        return;
      }
      if (m) {
        const post = m[1];
        const counter = (uploads.get(post) ?? 0) + 1;
        uploads.set(post, counter);
        if (faults.failUpload.get(post) === counter) {
          return send(500, { statusCode: '500', error: 'internal', message: 'simulated upload failure' });
        }
        objects.set(key, { data: raw, modifiedAt: Date.now() });
        const hook = faults.onUpload.get(post);
        if (hook && hook.n === counter) { faults.onUpload.delete(post); hook.run(); }
        return send(200, { Key: key });
      }
      objects.set(key, { data: raw, modifiedAt: Date.now() });
      return send(200, { Key: key });
    }
  }
  send(404, { message: `mock: no route for ${req.method} ${u.pathname}` });
});
const uploads = new Map<string, number>();

let server: ChildProcess;
let port = 0;
let tmp = '';
let clip: Buffer;
let longClip: Buffer;

async function call(route: string, payload: unknown, method = 'POST') {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const hlsKeys = (n: number) => [...objects.keys()].filter(k => k.startsWith(`FlutterFlow/converted/${id(n)}/`)).sort();
const convert = (n: number, over: Row = {}) => call('/api/process-from-storage', {
  videoPath: posts.get(id(n))?.media_path ?? `u${n}/v.mp4`, bucket: 'unfiltered', videoId: id(n), postId: id(n), ...over,
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return;
  assert.fail(`timed out waiting for: ${what}`);
}
function enqueue(n: number) {
  queue.set(id(n), { post_id: id(n), queued_at: new Date().toISOString(), attempts: 0, next: 0 });
}
/** The attempt folder hls_url points at, e.g. FlutterFlow/converted/<id>/hls/v…/ */
const publishedPrefix = (n: number) => {
  const url: string = posts.get(id(n))!.hls_url;
  return 'FlutterFlow/' + url.slice(BASE.length).replace(/master\.m3u8$/, '');
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-routes-'));
  const clipPath = path.join(tmp, 'clip.mp4');
  execFileSync(ffmpegInstaller.path, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clipPath,
  ]);
  clip = fs.readFileSync(clipPath);
  // A video that takes far longer than the 4 s auto-convert timeout to convert.
  // Made here, before the stand-in starts: generating it blocks this process.
  const longPath = path.join(tmp, 'long.mp4');
  execFileSync(ffmpegInstaller.path, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '90', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', longPath,
  ]);
  longClip = fs.readFileSync(longPath);

  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  const mockPort = (mock.address() as any).port;
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
      API_KEY: KEY, PORT: String(port), TEMP_DIR: path.join(tmp, 'work'),
      SOURCE_BUCKET: 'FlutterFlow', TARGET_BUCKET: 'FlutterFlow', TARGET_FOLDER: 'converted',
      PUBLIC_STORAGE_BASE_URL: BASE, ENABLE_ADMIN_ROUTES: '', LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
      HLS_RECONCILE_INTERVAL_MS: '150', HLS_QUEUE_HEALTH_MS: '1000', HLS_STALE_MS: String(HOUR),
      HLS_AUTOCONVERT_INTERVAL_MS: '200', HLS_AUTOCONVERT_BATCH: '2',
      HLS_AUTOCONVERT_LEASE_MS: '2000', HLS_AUTOCONVERT_TIMEOUT_MS: '4000',
      HLS_AUTOCONVERT_REQUEST_TIMEOUT_MS: '500', HLS_AUTOCONVERT_LATE_SWEEP_MS: '800',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
    await sleep(200);
  }
  for (let i = 0; i < 50; i++) {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    // (No such field before the queue existed; lets these tests run against
    // older builds to show which failures they reproduce.)
    if (h.revocationQueue === 'ok' || h.revocationQueue === undefined) return;
    await sleep(100);
  }
  throw new Error('server did not start with a healthy queue');
});

after(() => {
  server?.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(n: number, over: Row = {}) {
  const row = privPost(n, over);
  posts.set(row.id, row);
  if (row.media_path) objects.set(`${row.media_bucket}/${row.media_path}`, { data: clip, modifiedAt: Date.now() });
  return row;
}

test('admin-only routes are off by default', async () => {
  assert.equal((await call('/', null, 'GET')).status, 404);
  assert.equal((await call('/api/upload', {})).status, 404);
  assert.equal((await call('/api/metadata', {})).status, 404);
  assert.equal((await call('/api/validate', {})).status, 404);
});

test('an eligible private video is converted into its own attempt folder and published', async () => {
  const row = seed(1);
  const r = await convert(1);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(row.hls_url, new RegExp(`^${BASE}converted/${id(1)}/hls/v\\d{13}-[0-9a-z]{8}/master\\.m3u8$`));
  assert.ok(objects.has(`${publishedPrefix(1)}master.m3u8`));
  assert.ok(hlsKeys(1).every(k => k.startsWith(publishedPrefix(1))));
});

test('the caller cannot choose the output folder or another post', async () => {
  seed(2);
  assert.equal((await convert(2, { videoId: id(99) })).status, 400);
  assert.equal((await convert(2, { postId: 'not-a-uuid', videoId: undefined })).status, 400);
  assert.equal((await convert(2, { videoPath: 'u1/v.mp4' })).status, 403);
  assert.equal((await convert(2, { bucket: 'avatars' })).status, 403);
  assert.equal((await convert(2, { postId: id(98), videoId: id(98) })).status, 403);
  assert.deepEqual(hlsKeys(2), []);
  assert.deepEqual(hlsKeys(99), []);
});

test('ineligible private videos are refused before any work', async () => {
  seed(3, { is_hidden: true });
  seed(4, { is_vip: true });
  seed(5, { expires_at: '2099-01-01T00:00:00Z' });
  seed(6, { media_count: 2 });
  seed(7);
  deletionJobs.push({ id: 'job-7', profile_id: 'profile-7' });
  for (const n of [3, 4, 5, 6, 7]) {
    const r = await convert(n);
    assert.equal(r.status, 403, `post ${n}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(hlsKeys(n), []);
    assert.equal(posts.get(id(n))!.hls_url, null);
  }
});

test('R3: every policy change during conversion stops publication and removes the attempt', async () => {
  const cases: [string, Row, (r: Row) => void][] = [
    ['hidden', {}, r => { r.is_hidden = true; }],
    ['made VIP', {}, r => { r.is_vip = true; }],
    ['row deleted', {}, r => { posts.delete(r.id); }],
    ['Unfiltered-only post moved to channel standard', { channel: 'unfiltered', in_general_feed: false }, r => { r.channel = 'standard'; }],
    ['General Feed post taken out of the feed', {}, r => { r.in_general_feed = false; }],
    ['access type made PRIVATE', {}, r => { r.type = 'PRIVATE'; }],
    ['became a carousel', {}, r => { r.media_count = 3; }],
    ['no longer a video', {}, r => { r.post_type = 'photo'; }],
    ['given an expiry', {}, r => { r.expires_at = '2099-01-01T00:00:00Z'; }],
    ['media replaced', {}, r => { r.media_path = 'u0/other.mp4'; }],
  ];
  let n = 100;
  for (const [what, over, change] of cases) {
    n++;
    const row = seed(n, over);
    faults.onUpload.set(id(n), { n: 1, run: () => change(row) });
    const r = await convert(n);
    assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.json)}`);
    assert.equal(posts.get(id(n))?.hls_url ?? null, null, what);
    assert.deepEqual(hlsKeys(n), [], `${what}: files left behind`);
  }
});

test('R3: an account deletion that starts during conversion revokes what was published', async () => {
  const row = seed(120);
  faults.onUpload.set(id(120), { n: 1, run: () => deletionJobs.push({ id: 'job-120', profile_id: 'profile-120' }) });
  const r = await convert(120);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(120), []);
});

test('R1: an upload that fails part-way leaves no public files', async () => {
  const row = seed(8);
  faults.failUpload.set(id(8), 3);
  const r = await convert(8);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(8), [], 'the two files uploaded before the failure were removed');
  faults.failUpload.delete(id(8));
  assert.equal((await convert(8)).status, 200, 'a later attempt succeeds');
});

test('a database failure on publish is a failure, and the attempt is removed', async () => {
  const row = seed(10);
  faults.patch.set(id(10), 'error');
  const r = await convert(10);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(10), []);
  faults.patch.delete(id(10));
});

test('a publish that committed before failing is recognised, and its files are kept', async () => {
  const row = seed(11);
  faults.patch.set(id(11), 'commit-then-error');
  const r = await convert(11);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(row.hls_url);
  assert.ok(objects.has(`${publishedPrefix(11)}master.m3u8`));
  faults.patch.delete(id(11));
});

test('when the publish outcome cannot be known, nothing is deleted', async () => {
  const row = seed(12);
  // The UPDATE commits, its answer is lost, and the re-read fails too.
  faults.patch.set(id(12), 'commit-then-unreadable');
  const r = await convert(12);
  faults.patch.delete(id(12));
  faults.failRead.delete(id(12));
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.ok(row.hls_url, 'the row was published');
  assert.ok(objects.has(`${publishedPrefix(12)}master.m3u8`), 'and its files are intact');
});

test('R2: a repeat request never touches a published rendition, even when the database fails', async () => {
  const row = seed(13);
  assert.equal((await convert(13)).status, 200);
  const url = row.hls_url;
  const files = hlsKeys(13);

  const again = await convert(13);
  assert.equal(again.status, 200);
  assert.equal(again.json.alreadyPublished, true);

  faults.patch.set(id(13), 'error');
  const patchesBefore = sent.patches.filter(p => p === id(13)).length;
  const failing = await convert(13);
  faults.patch.delete(id(13));
  assert.equal(failing.status, 200, JSON.stringify(failing.json));
  assert.equal(row.hls_url, url);
  assert.deepEqual(hlsKeys(13), files, 'no file was removed or added');
  assert.equal(sent.patches.filter(p => p === id(13)).length, patchesBefore, 'no second publish was attempted');
});

test('R2: concurrent conversions publish once; the loser removes only its own folder', async () => {
  const row = seed(14);
  const [a, b] = await Promise.all([convert(14), convert(14)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 200]);
  assert.ok(row.hls_url);
  const keep = publishedPrefix(14);
  assert.ok(objects.has(`${keep}master.m3u8`));
  assert.deepEqual(hlsKeys(14).filter(k => !k.startsWith(keep)), [], 'the losing attempt left nothing');
});

test('R4: private media is not converted while the revocation queue is down; legacy still is', async () => {
  seed(15);
  const legacy = seed(16, {
    media_bucket: null, media_path: null, media_count: 1, post_type: 'video',
    channel: 'standard', in_general_feed: false, type: 'PUBLIC',
    video_url: 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/16.mp4',
  });
  objects.set('FlutterFlow/Videos/16.mp4', { data: clip, modifiedAt: Date.now() });
  faults.queueDown = true;
  await sleep(1300);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.revocationQueue, 'unavailable');
  const r = await convert(15);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(hlsKeys(15), []);
  const l = await call('/api/process-from-storage', { videoPath: 'Videos/16.mp4', bucket: 'FlutterFlow', postId: id(16) });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.ok(legacy.hls_url);
  faults.queueDown = false;
  await sleep(400);
  assert.equal((await convert(15)).status, 200, 'converts again once the queue is back');
});

test('revoke keeps an eligible post\'s HLS and removes an ineligible one\'s', async () => {
  const row = seed(20);
  assert.equal((await convert(20)).status, 200);
  assert.equal((await call('/api/revoke-hls', { postId: id(20) })).status, 409);
  assert.ok(hlsKeys(20).length > 0, 'an eligible post keeps its HLS');

  row.is_hidden = true;
  const hidden = await call('/api/revoke-hls', { postId: id(20) });
  assert.equal(hidden.status, 200);
  assert.ok(hidden.json.removed > 0);
  assert.deepEqual(hlsKeys(20), []);
  assert.equal(row.hls_url, null);
  assert.equal((await call('/api/revoke-hls', { postId: '../x' })).status, 400);
});

test('a folder another post plays from is neither overwritten nor removed', async () => {
  seed(21);
  objects.set(`FlutterFlow/converted/${id(21)}/hls/master.m3u8`, { data: Buffer.from('#EXTM3U'), modifiedAt: Date.now() });
  seed(22, { hls_url: `${BASE}converted/${id(21)}/hls/master.m3u8` });
  assert.equal((await convert(21)).status, 409);
  posts.delete(id(21));
  assert.equal((await call('/api/revoke-hls', { postId: id(21) })).status, 409);
  assert.equal(hlsKeys(21).length, 1);
});

test('R4: the queue removes a deleted post\'s copy with no app request at all', async () => {
  seed(30);
  assert.equal((await convert(30)).status, 200);
  posts.delete(id(30));          // the app's revoke request never arrives
  enqueue(30);                   // the database's delete trigger
  await until(() => !queue.has(id(30)), 'queue entry completed');
  assert.deepEqual(hlsKeys(30), []);
});

test('R4: a failed revocation stays queued and is retried until it succeeds', async () => {
  const row = seed(31);
  assert.equal((await convert(31)).status, 200);
  row.is_hidden = true;
  faults.failRemove.add(`FlutterFlow/converted/${id(31)}/`);
  enqueue(31);
  await until(() => (queue.get(id(31))?.attempts ?? 0) >= 2, 'two failed attempts');
  assert.match(queue.get(id(31))!.last_error ?? '', /remove/);
  assert.ok(hlsKeys(31).length > 0);
  faults.failRemove.clear();
  await until(() => !queue.has(id(31)), 'retried to completion');
  assert.deepEqual(hlsKeys(31), []);
  assert.equal(row.hls_url, null);
});

test('R4: reconcile removes stale leftovers but keeps the published copy and attempts in flight', async () => {
  seed(32);
  assert.equal((await convert(32)).status, 200);
  const keep = hlsKeys(32);
  const old = Date.now() - 2 * HOUR;
  objects.set(`FlutterFlow/converted/${id(32)}/hls/v0000000000001-oldoldol/360p_000.ts`, { data: Buffer.from('x'), modifiedAt: old });
  objects.set(`FlutterFlow/converted/${id(32)}/hls/master.m3u8`, { data: Buffer.from('x'), modifiedAt: old });
  objects.set(`FlutterFlow/converted/${id(32)}/hls/v9999999999999-inflight/360p_000.ts`, { data: Buffer.from('x'), modifiedAt: Date.now() });
  enqueue(32);
  await until(() => !queue.has(id(32)), 'queue entry completed');
  assert.deepEqual(hlsKeys(32), [...keep, `FlutterFlow/converted/${id(32)}/hls/v9999999999999-inflight/360p_000.ts`].sort());
});

test('reconcile never prunes HLS that another live post still plays', async () => {
  // Third review: A stays eligible and is queued (e.g. UNFILTERED -> PUBLIC);
  // B still plays an older rendition under A's folder.
  seed(33);
  assert.equal((await convert(33)).status, 200);
  const current = hlsKeys(33);
  const old = Date.now() - 2 * HOUR;
  const bDir = `converted/${id(33)}/hls/v0000000000002-sharedbb`;
  const bFiles = [`FlutterFlow/${bDir}/master.m3u8`, `FlutterFlow/${bDir}/360p_000.ts`];
  for (const k of bFiles) objects.set(k, { data: Buffer.from('x'), modifiedAt: old });
  const stray = `FlutterFlow/converted/${id(33)}/hls/v0000000000003-strayccc/360p_000.ts`;
  objects.set(stray, { data: Buffer.from('x'), modifiedAt: old });
  const b = seed(34, { hls_url: `${BASE}${bDir}/master.m3u8` });

  enqueue(33);
  await until(() => !queue.has(id(33)), 'queue entry completed');
  for (const k of [...current, ...bFiles]) assert.ok(objects.has(k), `kept ${k}`);
  assert.equal(b.hls_url, `${BASE}${bDir}/master.m3u8`);

  // Once nothing else plays from the folder, unreferenced stale files go.
  b.hls_url = null;
  enqueue(33);
  await until(() => !queue.has(id(33)), 'second queue entry completed');
  assert.deepEqual(hlsKeys(33), current);
  assert.equal(objects.has(stray), false);
});

test('a legacy public post converts only from its own video_url', async () => {
  const row = seed(40, {
    media_bucket: null, media_path: null, media_count: 1, post_type: 'video',
    channel: 'standard', in_general_feed: false, type: 'PUBLIC',
    video_url: 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/40.mp4',
  });
  objects.set('FlutterFlow/Videos/40.mp4', { data: clip, modifiedAt: Date.now() });
  const legacy = (videoPath: string) => call('/api/process-from-storage', {
    videoPath, bucket: 'FlutterFlow', videoId: id(40), postId: id(40),
  });
  assert.equal((await legacy('Videos/other.mp4')).status, 403);
  assert.equal((await legacy('Videos/40.mp4')).status, 200);
  assert.match(row.hls_url, new RegExp(`^${BASE}converted/${id(40)}/hls/v`));
});

test('revoking a hidden legacy post also removes a copy it alone plays from another folder', async () => {
  const row = seed(41, {
    media_bucket: null, media_path: null, type: 'PUBLIC', is_hidden: true,
    video_url: 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/41.mp4',
    hls_url: `${BASE}converted/1736606618523/hls/master.m3u8`,
  });
  objects.set('FlutterFlow/converted/1736606618523/hls/master.m3u8', { data: Buffer.from('#EXTM3U'), modifiedAt: Date.now() });
  const r = await call('/api/revoke-hls', { postId: id(41) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(objects.has('FlutterFlow/converted/1736606618523/hls/master.m3u8'), false);
  assert.equal(row.hls_url, null);
});

test('auto-convert: new videos nobody asked HLS for are converted from their own row, under the same policy', async () => {
  const unified = seed(50);
  const n8n = seed(51, {
    media_bucket: null, media_path: null, channel: 'standard', in_general_feed: false, type: 'PUBLIC',
    video_url: 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/multi-account/someone/multiacct%2051.mp4',
  });
  objects.set('FlutterFlow/Videos/multi-account/someone/multiacct 51.mp4', { data: clip, modifiedAt: Date.now() });
  seed(52, { is_hidden: true });                                   // the claim offers it anyway
  seed(53);
  objects.delete(`unfiltered/${posts.get(id(53))!.media_path}`);  // source missing
  const done = seed(54, { hls_url: `${BASE}converted/${id(54)}/hls/vx/master.m3u8` });
  auto.offer.push(id(50), id(51), id(52), id(53), id(54), id(55)); // 55: no such post
  await until(() => auto.results.size >= 6, 'six results recorded', 30000);

  assert.deepEqual(auto.results.get(id(50)), { error: null, final: false });
  assert.match(unified.hls_url, new RegExp(`^${BASE}converted/${id(50)}/hls/v\\d{13}-[0-9a-z]{8}/master\\.m3u8$`));
  assert.deepEqual(auto.results.get(id(51)), { error: null, final: false });
  assert.match(n8n.hls_url, new RegExp(`^${BASE}converted/${id(51)}/hls/v`));
  assert.ok(objects.has(`${publishedPrefix(51)}master.m3u8`));

  assert.equal(auto.results.get(id(52))!.final, true, 'a refusal is final');
  assert.match(auto.results.get(id(52))!.error!, /^403 post is hidden/);
  assert.equal(posts.get(id(52))!.hls_url, null);
  assert.deepEqual(hlsKeys(52), []);

  assert.equal(auto.results.get(id(53))!.final, false, 'a failed conversion may be retried');
  assert.match(auto.results.get(id(53))!.error!, /^500 /);
  assert.deepEqual(hlsKeys(53), [], 'a failed attempt leaves nothing');

  assert.deepEqual(auto.results.get(id(54)), { error: null, final: false }, 'already published: nothing to do');
  assert.equal(done.hls_url, `${BASE}converted/${id(54)}/hls/vx/master.m3u8`);
  assert.deepEqual(hlsKeys(54), []);
  assert.deepEqual(auto.results.get(id(55)), { error: 'post not found', final: true });

  // P1: each post is claimed only when its work starts, right after the
  // previous post's result, so no post waits while holding a claim.
  const mine = new Set([50, 51, 52, 53, 54, 55].map(id));
  const seq = auto.events.filter(e => mine.has(e.split(' ')[1]) && !e.startsWith('renew'));
  assert.equal(seq.length, 12, seq.join('\n'));
  for (let i = 0; i < seq.length; i += 2) {
    const p = seq[i].split(' ')[1];
    assert.deepEqual([seq[i], seq[i + 1]], [`claim ${p}`, `result ${p} true`]);
  }
});

test('auto-convert: without the backend functions or a healthy queue it does nothing, and the rest keeps working', async () => {
  faults.autoMissing = true;
  seed(56);
  auto.offer.push(id(56));
  const before = auto.calls;
  await sleep(700);
  assert.ok(auto.calls > before, 'it keeps asking');
  assert.equal(posts.get(id(56))!.hls_url, null);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).revocationQueue, 'ok');
  faults.autoMissing = false;

  faults.queueDown = true;
  await sleep(1300);
  const callsWhileDown = auto.calls;
  await sleep(600);
  assert.equal(auto.calls, callsWhileDown, 'no claims while the revocation queue is unhealthy');
  faults.queueDown = false;
  await until(() => auto.results.has(id(56)), 'converted once both are back', 30000);
  assert.deepEqual(auto.results.get(id(56)), { error: null, final: false });
  assert.ok(posts.get(id(56))!.hls_url);
});

test('auto-convert P1: a conversion that runs past the timeout is cancelled, ffmpeg is killed and nothing is published', async () => {
  const row = seed(57);
  objects.set(`unfiltered/${row.media_path}`, { data: longClip, modifiedAt: Date.now() });
  const started = Date.now();
  auto.offer.push(id(57));
  await until(() => auto.results.has(id(57)), 'the timed-out attempt recorded', 30000)
    .catch(e => { throw new Error(`${e.message}; events: ${auto.events.filter(x => x.includes(id(57))).join(' | ')}`); });
  const took = Date.now() - started;
  assert.ok(took < 9000, `cancelled after about the 4 s timeout, took ${took} ms`);
  assert.equal(auto.results.get(id(57))!.final, false, 'a timeout may be retried');
  assert.match(auto.results.get(id(57))!.error!, /timed out after 4000 ms/);
  assert.equal(row.hls_url, null);
  await until(() => hlsKeys(57).length === 0, 'the attempt folder removed');
  const work = path.join(tmp, 'work');
  const ffmpegs = execFileSync('ps', ['-ww', '-eo', 'args']).toString().split('\n').filter(l => l.includes('ffmpeg') && l.includes(work));
  assert.deepEqual(ffmpegs, [], 'no ffmpeg left running');
});

test('auto-convert P1: a worker that loses its claim stops at once and records nothing', async () => {
  const row = seed(58);
  objects.set(`unfiltered/${row.media_path}`, { data: longClip, modifiedAt: Date.now() }); // encodes for far longer than the test
  auto.lostClaims.add(id(58));                               // another task holds the claim now
  seed(59);
  auto.offer.push(id(58), id(59));
  await until(() => auto.events.includes(`claim ${id(58)}`), 'claimed');
  const claimedAt = Date.now();
  await until(() => auto.results.has(id(59)), 'the next post converted', 10000);
  assert.ok(Date.now() - claimedAt < 2500, 'the worker stopped at the first refused renewal (0.5 s) and moved on');
  assert.ok(auto.events.includes(`renew ${id(58)} false`));
  assert.ok(!auto.events.some(e => e.startsWith(`result ${id(58)}`)), 'no result for a claim that is not ours');
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(58), []);
  assert.ok(posts.get(id(59))!.hls_url);
});

test('auto-convert P1: renewals that never answer cannot keep work alive past the lease deadline', async () => {
  const row = seed(60);
  // Encoding this takes far longer than the 4 s timeout.
  objects.set(`unfiltered/${row.media_path}`, { data: longClip, modifiedAt: Date.now() });
  faults.hangRenew.add(id(60));
  seed(61);
  auto.offer.push(id(60), id(61));
  await until(() => auto.events.includes(`claim ${id(60)}`), 'claimed');
  const claimedAt = Date.now();
  await until(() => auto.events.includes(`claim ${id(61)}`), 'the next claim', 10000);
  const stoppedAfter = Date.now() - claimedAt;
  // Lease 2 s: the watchdog cancels 1 s after the last confirmation (the
  // claim), and the work has stopped by 1.5 s, well before the 4 s timeout.
  assert.ok(stoppedAfter < 2000, `stopped ${stoppedAfter} ms after the claim`);
  assert.ok(auto.events.includes(`renew ${id(60)} hung`));
  await until(() => auto.renewAborted >= 1, 'the hung renewal request was given up', 3000);
  assert.ok(!auto.events.some(e => e.startsWith(`result ${id(60)}`)), 'no result for an unconfirmed claim');
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(60), []);
  await until(() => auto.results.has(id(61)), 'the next post converted', 10000);
  const work = path.join(tmp, 'work');
  assert.deepEqual(execFileSync('ps', ['-ww', '-eo', 'args']).toString().split('\n').filter(l => l.includes('ffmpeg') && l.includes(work)), [],
    'no ffmpeg left running');
  faults.hangRenew.clear();
});

test('auto-convert P1: an upload that never answers is cut off, and a copy stored late is removed', async () => {
  const row = seed(62);
  faults.hangUpload.add(id(62));
  seed(63);
  auto.offer.push(id(62), id(63));
  await until(() => auto.events.includes(`claim ${id(62)}`), 'claimed');
  const claimedAt = Date.now();
  await until(() => auto.results.has(id(62)), 'the attempt ended', 10000);
  const took = Date.now() - claimedAt;
  assert.ok(took < 3000, `the hung upload was cut off by the 0.5 s request limit, not waited on (${took} ms)`);
  assert.equal(auto.results.get(id(62))!.final, false);
  assert.equal(row.hls_url, null);
  await until(() => auto.results.has(id(63)), 'the next post was not blocked', 10000);
  await until(() => auto.lateWrites >= 1, 'storage stored the abandoned upload late', 5000);
  await until(() => hlsKeys(62).length === 0, 'the late copy removed by the second sweep', 5000);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.autoConvert.background, 0, 'nothing of the attempt is still running');
  faults.hangUpload.clear();
});

test('health reports the auto-convert state for rollback checks', async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(Object.keys(h.autoConvert).sort(), ['background', 'state']);
  assert.ok(['idle', 'working'].includes(h.autoConvert.state));
});

test('auto-convert round 3: a claim request that never answers is given up and later scans recover', async () => {
  seed(64);
  faults.hangClaims = 2;
  auto.offer.push(id(64));
  await until(() => auto.claimAborted >= 2, 'both hung claims given up (0.25 s limit each)', 3000);
  await until(() => auto.results.has(id(64)), 'a later scan claims and converts the post', 5000);
  assert.deepEqual(auto.results.get(id(64)), { error: null, final: false });
  assert.ok(posts.get(id(64))!.hls_url);
});

test('auto-convert round 3: a result request that never answers is given up and later scans recover', async () => {
  const row = seed(65);
  seed(66);
  faults.hangResult.add(id(65));
  auto.offer.push(id(65), id(66));
  await until(() => auto.events.includes(`result ${id(65)} hung`), 'the result request hangs', 5000);
  const hungAt = Date.now();
  await until(() => auto.resultAborted >= 1, 'the hung result request given up', 3000);
  await until(() => auto.results.has(id(66)), 'the next post claimed and converted', 5000);
  assert.ok(Date.now() - hungAt < 3000, 'the worker was not held by the hung response');
  assert.ok(row.hls_url, 'the conversion itself succeeded; only its record was lost (the lease lapses)');
  faults.hangResult.clear();
  await until(() => auto.offer.length === 0, 'nothing waiting', 1000);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.autoConvert.background, 0);
});
