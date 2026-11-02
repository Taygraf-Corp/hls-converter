/**
 * Who may get a public HLS rendition, and when it must go away.
 *
 * HLS output always lands in the public FlutterFlow bucket under
 * converted/<postId>/hls/, and the API key that guards this service ships in
 * the app, so every rule here is enforced server-side from the post row the
 * service reads with the service role, never from what a caller claims.
 *
 * Product decision 2026-11-02: a single-video post gets HLS whether it is in
 * the General Feed, Unfiltered or both; the copy is public by link while the
 * post is published. CTO review 2026-11-02 (finding 3): a hidden, VIP,
 * expiring, expired or deleted private video must not get or keep one.
 */

export const PUBLIC_SOURCE_BUCKET = 'FlutterFlow';
export const PRIVATE_SOURCE_BUCKET = 'unfiltered';
export const HLS_ROOT = 'converted';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The post columns the policy reads. */
export interface PostRow {
  id: string;
  profile_id: string | null;
  video_url: string | null;
  hls_url: string | null;
  media_bucket: string | null;
  media_path: string | null;
  media_count: number | null;
  post_type: string | null;
  channel: string | null;
  in_general_feed: boolean | null;
  type: string | null;
  is_hidden: boolean | null;
  is_vip: boolean | null;
  expires_at: string | null;
}

export const POST_COLUMNS =
  'id, profile_id, video_url, hls_url, media_bucket, media_path, media_count, ' +
  'post_type, channel, in_general_feed, type, is_hidden, is_vip, expires_at';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The only folder a post's HLS may be written to. [root] is TARGET_FOLDER
 * ("converted" in production), the same layout the converter always used.
 */
export function hlsFolderFor(postId: string, root: string = HLS_ROOT): string {
  return `${root}/${postId.toLowerCase()}/hls`;
}

/** Whether a public object URL names bucket/objectPath (URL-encoding ignored). */
export function urlNamesObject(url: string | null, bucket: string, objectPath: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname.endsWith(`/storage/v1/object/public/${bucket}/${objectPath}`);
  } catch {
    return false;
  }
}

function expired(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) {
    return false;
  }
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) || t <= now.getTime();
}

/**
 * Why this post may not be converted from bucket/objectPath, or null when it may.
 * [deletionPending]: the author has an account-deletion job (any status).
 */
export function conversionRefusal(
  post: PostRow | null,
  bucket: string,
  objectPath: string,
  deletionPending: boolean,
  now: Date = new Date()
): string | null {
  if (!post) {
    return 'post not found';
  }
  if (deletionPending) {
    return 'the author\'s account is being deleted';
  }
  if (post.is_hidden === true) {
    return 'post is hidden';
  }
  if (post.is_vip === true) {
    return 'VIP posts are not converted';
  }

  if (bucket === PUBLIC_SOURCE_BUCKET) {
    if (post.media_path) {
      return 'post has private media; its public video_url is not the source';
    }
    if (!urlNamesObject(post.video_url, bucket, objectPath)) {
      return 'videoPath is not this post\'s video';
    }
    if (expired(post.expires_at, now)) {
      return 'post has expired';
    }
    return null;
  }

  if (bucket !== PRIVATE_SOURCE_BUCKET) {
    return `bucket ${bucket} is not a conversion source`;
  }
  if (post.media_bucket !== bucket || post.media_path !== objectPath) {
    return 'videoPath is not this post\'s media';
  }
  if ((post.media_count ?? 1) !== 1) {
    return 'carousel posts are not converted';
  }
  if (post.post_type !== 'video') {
    return 'post is not a video';
  }
  if (post.channel !== 'unfiltered' && post.in_general_feed !== true) {
    return 'post is not published in any feed';
  }
  if (post.type !== 'UNFILTERED' && post.type !== 'PUBLIC') {
    return 'post access type is not convertible';
  }
  // A public copy cannot be made to expire with the post, so private media
  // that expires (now or later) never gets one.
  if (post.expires_at) {
    return 'expiring private media is not converted';
  }
  return null;
}

/** The source a post's own HLS came from, or null when it has none. */
export function sourceOf(post: PostRow): { bucket: string; path: string } | null {
  if (post.media_bucket && post.media_path) {
    return { bucket: post.media_bucket, path: post.media_path };
  }
  const m = /\/storage\/v1\/object\/public\/([^/?]+)\/([^?]+)/.exec(post.video_url ?? '');
  if (!m) {
    return null;
  }
  try {
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * Whether converted/<postId>/ must be removed now: the post is gone, or it would
 * no longer be allowed a conversion (hidden, VIP, expired, author being deleted,
 * media changed). A post that is still eligible keeps its HLS.
 */
export function revokeRequired(
  post: PostRow | null,
  deletionPending: boolean,
  now: Date = new Date()
): boolean {
  if (!post) {
    return true;
  }
  const source = sourceOf(post);
  if (!source) {
    return true;
  }
  return conversionRefusal(post, source.bucket, source.path, deletionPending, now) !== null;
}

// ---------------------------------------------------------------------------
// Publication (CTO re-review 2026-11-02, R1-R3)
// ---------------------------------------------------------------------------

/** One PostgREST filter; `or` holds alternatives. */
export type Condition =
  | { col: keyof PostRow; op: 'eq' | 'gt'; value: string | number }
  | { col: keyof PostRow; op: 'is'; value: null | boolean }
  | { col: keyof PostRow; op: 'in'; value: string[] }
  | { or: Condition[] };

/**
 * Every condition the UPDATE that publishes hls_url must meet: the complete
 * mutable eligibility policy of conversionRefusal() for this post's source,
 * plus "no hls_url yet" (the first finished attempt wins). The author's
 * deletion state lives in another table and is checked right after.
 */
export function publishConditions(post: PostRow, now: Date = new Date()): Condition[] {
  const common: Condition[] = [
    { col: 'id', op: 'eq', value: post.id },
    { col: 'hls_url', op: 'is', value: null },
    { or: [{ col: 'is_hidden', op: 'is', value: null }, { col: 'is_hidden', op: 'is', value: false }] },
    { or: [{ col: 'is_vip', op: 'is', value: null }, { col: 'is_vip', op: 'is', value: false }] },
  ];
  if (post.media_path) {
    return [
      ...common,
      { col: 'media_bucket', op: 'eq', value: post.media_bucket as string },
      { col: 'media_path', op: 'eq', value: post.media_path },
      { or: [{ col: 'media_count', op: 'is', value: null }, { col: 'media_count', op: 'eq', value: 1 }] },
      { col: 'post_type', op: 'eq', value: 'video' },
      { or: [{ col: 'channel', op: 'eq', value: 'unfiltered' }, { col: 'in_general_feed', op: 'is', value: true }] },
      { col: 'type', op: 'in', value: ['UNFILTERED', 'PUBLIC'] },
      { col: 'expires_at', op: 'is', value: null },
    ];
  }
  return [
    ...common,
    { col: 'media_path', op: 'is', value: null },
    { col: 'video_url', op: 'eq', value: post.video_url as string },
    { or: [{ col: 'expires_at', op: 'is', value: null }, { col: 'expires_at', op: 'gt', value: now.toISOString() }] },
  ];
}

/** Evaluate conditions the way PostgREST would (for tests and local checks). */
export function rowMeets(row: PostRow, conditions: Condition[]): boolean {
  const one = (c: Condition): boolean => {
    if ('or' in c) return c.or.some(one);
    const cell = row[c.col] as unknown;
    switch (c.op) {
      case 'eq': return cell !== null && cell !== undefined && String(cell) === String(c.value);
      case 'is': return c.value === null ? cell === null || cell === undefined : cell === c.value;
      case 'in': return cell !== null && cell !== undefined && c.value.includes(String(cell));
      case 'gt': {
        if (cell === null || cell === undefined) return false;
        return Date.parse(String(cell)) > Date.parse(String(c.value));
      }
    }
  };
  return conditions.every(one);
}

/** Attempt folders: v<13-digit epoch ms>-<8 chars>, so names sort by start time. */
export const ATTEMPT_DIR = /^v\d{13}-[0-9a-z]{8}$/;

export function newAttemptId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `v${String(now).padStart(13, '0')}-${rand}`;
}

/**
 * The storage directory (inside the public bucket) that a published hls_url's
 * master playlist sits in, or null when the URL is not a public object URL.
 */
export function publishedDir(hlsUrl: string | null, bucket: string): string | null {
  if (!hlsUrl) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = hlsUrl.indexOf(marker);
  if (at < 0) return null;
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(hlsUrl.slice(at + marker.length).split('?')[0]);
  } catch {
    return null;
  }
  const slash = objectPath.lastIndexOf('/');
  return slash > 0 ? objectPath.slice(0, slash) : null;
}

/** converted/<x>/hls for a directory inside it, or null. */
export function hlsRootOf(dir: string | null, root: string = HLS_ROOT): string | null {
  if (!dir) return null;
  const parts = dir.split('/');
  if (parts.length < 3 || parts[0] !== root || parts[2] !== 'hls' || !parts[1]) return null;
  return parts.slice(0, 3).join('/');
}
