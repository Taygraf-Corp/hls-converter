/**
 * End-to-end tests of the conversion and revoke routes against an in-memory
 * stand-in for Supabase (PostgREST + Storage) and the real bundled ffmpeg.
 * No network and no real project: SUPABASE_URL points at the stand-in.
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

const posts = new Map<string, Row>();
const deletionJobs: Row[] = [];
const objects = new Map<string, Buffer>(); // "<bucket>/<path>"
const hooks = {
  onUpload: new Map<string, () => void>(), // post id -> run on its first HLS upload
  failPatch: new Set<string>(),
};

function privPost(n: number, over: Row = {}): Row {
  return {
    id: id(n), profile_id: `profile-${n}`, video_url: null, hls_url: null,
    media_bucket: 'unfiltered', media_path: `u${n}/v.mp4`, media_count: 1,
    post_type: 'video', channel: 'standard', in_general_feed: true, type: 'UNFILTERED',
    is_hidden: false, is_vip: false, expires_at: null, ...over,
  };
}

/** Minimal PostgREST filter evaluation for the filters the service sends. */
function matches(row: Row, params: URLSearchParams): boolean {
  const one = (col: string, expr: string): boolean => {
    const dot = expr.indexOf('.');
    const op = expr.slice(0, dot);
    const v = expr.slice(dot + 1);
    const cell = row[col];
    switch (op) {
      case 'eq': return cell !== null && cell !== undefined && String(cell) === v;
      case 'neq': return cell === null || cell === undefined || String(cell) !== v;
      case 'is': return v === 'null' ? cell === null || cell === undefined : String(cell) === v;
      case 'gt': return cell !== null && cell !== undefined && String(cell) > v;
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

function body(req: http.IncomingMessage): Promise<Buffer> {
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
  const raw = await body(req);

  if (u.pathname === '/rest/v1/posts') {
    const rows = [...posts.values()].filter(r => matches(r, u.searchParams));
    if (req.method === 'GET') return send(200, rows);
    if (req.method === 'PATCH') {
      const pid = (u.searchParams.get('id') ?? '').replace('eq.', '');
      if (hooks.failPatch.has(pid)) return send(500, { message: 'simulated database failure' });
      const patch = JSON.parse(raw.toString());
      rows.forEach(r => Object.assign(r, patch));
      return send(200, rows.map(r => ({ id: r.id })));
    }
  }
  if (u.pathname === '/rest/v1/account_deletion_jobs') {
    const pid = (u.searchParams.get('profile_id') ?? '').replace('eq.', '');
    return send(200, deletionJobs.filter(j => j.profile_id === pid).map(j => ({ id: j.id })));
  }
  if (u.pathname.startsWith('/storage/v1/object/list/')) {
    const bucket = u.pathname.split('/').pop();
    const { prefix } = JSON.parse(raw.toString());
    const names = [...objects.keys()]
      .filter(k => k.startsWith(`${bucket}/${prefix}/`))
      .map(k => k.slice(`${bucket}/${prefix}/`.length))
      .filter(n => !n.includes('/'));
    return send(200, names.map(n => ({ name: n, id: `obj-${n}` })));
  }
  if (u.pathname.startsWith('/storage/v1/object/')) {
    const key = decodeURIComponent(u.pathname.slice('/storage/v1/object/'.length));
    if (req.method === 'DELETE') {
      const { prefixes } = JSON.parse(raw.toString());
      for (const p of prefixes) objects.delete(`${key}/${p}`);
      return send(200, prefixes.map((p: string) => ({ name: p })));
    }
    if (req.method === 'GET') {
      const data = objects.get(key);
      if (!data) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.statusCode = 200;
      return res.end(data);
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      objects.set(key, raw);
      const m = /^FlutterFlow\/converted\/([^/]+)\/hls\//.exec(key);
      const hook = m && hooks.onUpload.get(m[1]);
      if (hook) { hooks.onUpload.delete(m![1]); hook(); }
      return send(200, { Key: key });
    }
  }
  send(404, { message: `mock: no route for ${req.method} ${u.pathname}` });
});

let server: ChildProcess;
let port = 0;
let tmp = '';
let clip: Buffer;

async function call(route: string, payload: unknown, method = 'POST') {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const hlsKeys = (n: number) => [...objects.keys()].filter(k => k.startsWith(`FlutterFlow/converted/${id(n)}/`));
const convert = (n: number, over: Row = {}) => call('/api/process-from-storage', {
  videoPath: posts.get(id(n))?.media_path ?? `u${n}/v.mp4`, bucket: 'unfiltered', videoId: id(n), postId: id(n), ...over,
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-routes-'));
  const clipPath = path.join(tmp, 'clip.mp4');
  execFileSync(ffmpegInstaller.path, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clipPath,
  ]);
  clip = fs.readFileSync(clipPath);

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
      PUBLIC_STORAGE_BASE_URL: BASE, ENABLE_ADMIN_ROUTES: '', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(n: number, over: Row = {}) {
  const row = privPost(n, over);
  posts.set(row.id, row);
  if (row.media_path) objects.set(`${row.media_bucket}/${row.media_path}`, clip);
  return row;
}

test('admin-only routes are off by default', async () => {
  assert.equal((await call('/', null, 'GET')).status, 404);
  assert.equal((await call('/api/upload', {})).status, 404);
  assert.equal((await call('/api/metadata', {})).status, 404);
  assert.equal((await call('/api/validate', {})).status, 404);
});

test('an eligible private video is converted into its own folder and published', async () => {
  const row = seed(1);
  const r = await convert(1);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(row.hls_url, `${BASE}converted/${id(1)}/hls/master.m3u8`);
  assert.ok(hlsKeys(1).includes(`FlutterFlow/converted/${id(1)}/hls/master.m3u8`));
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

test('a post hidden during conversion gets nothing published, and its files are removed', async () => {
  const row = seed(8);
  hooks.onUpload.set(id(8), () => { row.is_hidden = true; });
  const r = await convert(8);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(8), []);
});

test('a post deleted during conversion gets nothing published, and its files are removed', async () => {
  seed(9);
  hooks.onUpload.set(id(9), () => { posts.delete(id(9)); });
  const r = await convert(9);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual(hlsKeys(9), []);
});

test('a database failure is reported as a failure, and its files are removed', async () => {
  const row = seed(10);
  hooks.failPatch.add(id(10));
  const r = await convert(10);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.equal(row.hls_url, null);
  assert.deepEqual(hlsKeys(10), []);
});

test('revoke keeps an eligible post\'s HLS and removes an ineligible one\'s', async () => {
  const row = seed(11);
  assert.equal((await convert(11)).status, 200);
  assert.ok(hlsKeys(11).length > 0);

  assert.equal((await call('/api/revoke-hls', { postId: id(11) })).status, 409);
  assert.ok(hlsKeys(11).length > 0, 'an eligible post keeps its HLS');

  row.is_hidden = true;
  const hidden = await call('/api/revoke-hls', { postId: id(11) });
  assert.equal(hidden.status, 200);
  assert.ok(hidden.json.removed > 0);
  assert.deepEqual(hlsKeys(11), []);
  assert.equal(row.hls_url, null);
});

test('revoke after the post row is deleted removes its HLS', async () => {
  seed(12);
  assert.equal((await convert(12)).status, 200);
  posts.delete(id(12));
  const r = await call('/api/revoke-hls', { postId: id(12) });
  assert.equal(r.status, 200);
  assert.deepEqual(hlsKeys(12), []);
  assert.equal((await call('/api/revoke-hls', { postId: '../x' })).status, 400);
});

test('a folder another post plays from is neither overwritten nor removed', async () => {
  seed(14);
  objects.set(`FlutterFlow/converted/${id(14)}/hls/master.m3u8`, Buffer.from('#EXTM3U'));
  seed(15, { hls_url: `${BASE}converted/${id(14)}/hls/master.m3u8` });
  assert.equal((await convert(14)).status, 409);
  posts.delete(id(14));
  assert.equal((await call('/api/revoke-hls', { postId: id(14) })).status, 409);
  assert.equal(hlsKeys(14).length, 1);
});

test('a legacy public post converts only from its own video_url', async () => {
  const row = seed(13, {
    media_bucket: null, media_path: null, media_count: null, post_type: null,
    channel: null, in_general_feed: null, type: 'PUBLIC',
    video_url: 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/13.mp4',
  });
  objects.set('FlutterFlow/Videos/13.mp4', clip);
  const legacy = (videoPath: string) => call('/api/process-from-storage', {
    videoPath, bucket: 'FlutterFlow', videoId: id(13), postId: id(13),
  });
  assert.equal((await legacy('Videos/other.mp4')).status, 403);
  assert.equal((await legacy('Videos/13.mp4')).status, 200);
  assert.equal(row.hls_url, `${BASE}converted/${id(13)}/hls/master.m3u8`);
});
