import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Condition,
  POST_COLUMNS,
  PostRow,
  conversionRefusal,
  publishConditions,
  hlsFolderFor,
  isUuid,
  revokeRequired,
  sourceOf,
} from '../src/services/hls-policy.js';

const ID = '0b0e7c55-1111-4222-8333-444455556666';
const PUBLIC = 'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/1.mp4';
const NOW = new Date('2026-11-02T12:00:00Z');

function priv(over: Partial<PostRow> = {}): PostRow {
  return {
    id: ID, profile_id: 'p1', video_url: null, hls_url: null,
    media_bucket: 'unfiltered', media_path: 'u1/a.mp4', media_count: 1,
    post_type: 'video', channel: 'standard', in_general_feed: true, type: 'UNFILTERED',
    is_hidden: false, is_vip: false, expires_at: null, ...over,
  };
}
function legacy(over: Partial<PostRow> = {}): PostRow {
  return {
    ...priv(), media_bucket: null, media_path: null, media_count: null,
    post_type: null, channel: null, in_general_feed: null, type: 'PUBLIC',
    video_url: PUBLIC, ...over,
  };
}
const ok = (p: PostRow | null, bucket = 'unfiltered', path = 'u1/a.mp4', del = false) =>
  conversionRefusal(p, bucket, path, del, NOW);

test('ids and folders', () => {
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid('../x'), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(hlsFolderFor(ID.toUpperCase()), `converted/${ID}/hls`);
  assert.equal(hlsFolderFor(ID, 'out'), `out/${ID}/hls`);
});

test('a published single private video may be converted (General Feed, Unfiltered, both)', () => {
  assert.equal(ok(priv()), null);
  assert.equal(ok(priv({ in_general_feed: false, channel: 'unfiltered' })), null);
  assert.equal(ok(priv({ channel: 'unfiltered' })), null);
  assert.equal(ok(priv({ type: 'PUBLIC' })), null);
});

test('private media is refused when it would not be visible, or is not this post\'s', () => {
  assert.match(ok(null)!, /not found/);
  assert.match(ok(priv(), 'unfiltered', 'u1/a.mp4', true)!, /being deleted/);
  assert.match(ok(priv({ is_hidden: true }))!, /hidden/);
  assert.match(ok(priv({ is_vip: true }))!, /VIP/);
  assert.match(ok(priv({ expires_at: '2027-01-01T00:00:00Z' }))!, /expiring/);
  assert.match(ok(priv({ expires_at: '2026-01-01T00:00:00Z' }))!, /expiring/);
  assert.match(ok(priv({ media_count: 3 }))!, /carousel/);
  assert.match(ok(priv({ post_type: 'photo' }))!, /not a video/);
  assert.match(ok(priv({ in_general_feed: false, channel: 'standard' }))!, /not published/);
  assert.match(ok(priv({ type: 'VIP' }))!, /access type/);
  assert.match(ok(priv(), 'unfiltered', 'u1/other.mp4')!, /not this post/);
  assert.match(ok(priv({ media_bucket: 'FlutterFlow' }))!, /not this post/);
  assert.match(ok(priv(), 'avatars', 'u1/a.mp4')!, /not a conversion source/);
});

test('a legacy public video may be converted only from its own video_url', () => {
  assert.equal(ok(legacy(), 'FlutterFlow', 'Videos/1.mp4'), null);
  assert.equal(ok(legacy({ expires_at: '2027-01-01T00:00:00Z' }), 'FlutterFlow', 'Videos/1.mp4'), null);
  assert.match(ok(legacy(), 'FlutterFlow', 'Videos/2.mp4')!, /not this post/);
  assert.match(ok(legacy({ expires_at: '2026-01-01T00:00:00Z' }), 'FlutterFlow', 'Videos/1.mp4')!, /expired/);
  assert.match(ok(legacy({ is_hidden: true }), 'FlutterFlow', 'Videos/1.mp4')!, /hidden/);
  assert.match(ok(priv({ video_url: PUBLIC }), 'FlutterFlow', 'Videos/1.mp4')!, /private media/);
  const encoded = legacy({ video_url: PUBLIC.replace('1.mp4', 'a%20b.mp4') });
  assert.equal(ok(encoded, 'FlutterFlow', 'Videos/a b.mp4'), null);
});

test('sourceOf reads the post\'s own media', () => {
  assert.deepEqual(sourceOf(priv()), { bucket: 'unfiltered', path: 'u1/a.mp4' });
  assert.deepEqual(sourceOf(legacy()), { bucket: 'FlutterFlow', path: 'Videos/1.mp4' });
  assert.equal(sourceOf(legacy({ video_url: null })), null);
});

test('revoke is required exactly when the post may no longer have HLS', () => {
  assert.equal(revokeRequired(null, false, NOW), true);
  assert.equal(revokeRequired(priv(), false, NOW), false);
  assert.equal(revokeRequired(legacy(), false, NOW), false);
  assert.equal(revokeRequired(priv({ is_hidden: true }), false, NOW), true);
  assert.equal(revokeRequired(priv({ is_vip: true }), false, NOW), true);
  assert.equal(revokeRequired(priv({ expires_at: '2026-01-01T00:00:00Z' }), false, NOW), true);
  assert.equal(revokeRequired(priv(), true, NOW), true);
  assert.equal(revokeRequired(priv({ in_general_feed: false }), false, NOW), true);
  assert.equal(revokeRequired(legacy({ expires_at: '2026-01-01T00:00:00Z' }), false, NOW), true);
  assert.equal(revokeRequired(legacy({ video_url: null }), false, NOW), true);
});

test('R3: the publishing UPDATE re-applies exactly the conversion policy', async () => {
  const { publishConditions, rowMeets } = await import('../src/services/hls-policy.js');
  // Every single-field change an eligible row can undergo: the UPDATE's
  // conditions must accept the changed row exactly when conversionRefusal
  // would still accept it from the same source (and hls_url is still null).
  const mutations: Partial<PostRow>[] = [
    { is_hidden: true }, { is_hidden: null }, { is_vip: true }, { is_vip: null },
    { channel: 'standard' }, { channel: 'unfiltered' }, { in_general_feed: false }, { in_general_feed: true },
    { in_general_feed: null }, { type: 'PRIVATE' }, { type: 'PUBLIC' }, { type: 'UNFILTERED' },
    { media_count: 2 }, { media_count: null }, { media_count: 1 }, { post_type: 'photo' },
    { expires_at: '2027-01-01T00:00:00Z' }, { expires_at: '2026-01-01T00:00:00Z' }, { expires_at: null },
    { media_path: 'u1/b.mp4' }, { media_bucket: 'FlutterFlow' }, { video_url: PUBLIC.replace('1.mp4', '2.mp4') },
    { video_url: null }, { media_path: null, media_bucket: null }, { hls_url: 'https://x/converted/y/hls/master.m3u8' },
  ];
  const starts: [PostRow, string, string][] = [
    [priv(), 'unfiltered', 'u1/a.mp4'],
    [priv({ channel: 'unfiltered', in_general_feed: false }), 'unfiltered', 'u1/a.mp4'],
    [legacy(), 'FlutterFlow', 'Videos/1.mp4'],
    [legacy({ expires_at: '2027-01-01T00:00:00Z' }), 'FlutterFlow', 'Videos/1.mp4'],
  ];
  for (const [start, bucket, objectPath] of starts) {
    assert.equal(conversionRefusal(start, bucket, objectPath, false, NOW), null);
    const conds = publishConditions(start, NOW);
    assert.equal(rowMeets(start, conds), true);
    for (const m of mutations) {
      const changed = { ...start, ...m };
      const allowed = changed.hls_url === null && conversionRefusal(changed, bucket, objectPath, false, NOW) === null;
      assert.equal(rowMeets(changed, conds), allowed, `${JSON.stringify(m)} from ${start.media_path ? 'private' : 'legacy'}`);
    }
  }
});

test('the publish selects every column its or= filters name (PostgREST filters the returned rows too)', () => {
  const selected = new Set(POST_COLUMNS.split(',').map(c => c.trim()));
  const orColumns = (conds: Condition[]): string[] =>
    conds.flatMap(c => ('or' in c ? c.or.map(o => ('or' in o ? '' : String(o.col))) : []));
  for (const post of [priv(), legacy()]) {
    const cols = orColumns(publishConditions(post, NOW));
    assert.ok(cols.length > 0);
    for (const col of cols) assert.ok(selected.has(col), `${col} is filtered with or= but not selected`);
  }
});
