/**
 * Conversion, revocation and reconciliation of public HLS copies.
 *
 * CTO re-review 2026-11-02:
 *  R1  Each attempt writes to its own folder, converted/<postId>/hls/<attempt>/.
 *      A failed attempt removes that folder by listing it, so files uploaded
 *      before a failure are found even when the upload loop threw.
 *  R2  A post that already has hls_url is not converted again (200, no work),
 *      and an attempt only ever removes its own folder, so a failed or losing
 *      attempt never touches published output. The publishing UPDATE requires
 *      hls_url IS NULL: the first finished attempt wins, the others clean up.
 *  R3  That UPDATE re-applies the complete eligibility policy
 *      (publishConditions); the author's deletion state is checked right
 *      after, and a post caught by it is revoked at once.
 *  R4  revoke() and reconcile() are driven by the database queue
 *      (hls_reconcile_queue, filled by triggers on delete / policy changes /
 *      account deletion and by a periodic scan), with retries and backoff.
 *      Private media is only converted while that queue is being drained.
 */
import path from 'path';
import { logger } from '../utils/logger.js';
import {
  PostRow,
  conversionRefusal,
  hlsFolderFor,
  hlsRootOf,
  newAttemptId,
  PRIVATE_SOURCE_BUCKET,
  publishedDir,
  revokeRequired,
} from './hls-policy.js';

/** What the lifecycle needs from storage and the database. */
export interface HlsStore {
  getPostForHls(postId: string): Promise<PostRow | null>;
  hasDeletionJob(profileId: string | null): Promise<boolean>;
  publishHlsUrl(post: PostRow, hlsUrl: string): Promise<boolean>;
  getHlsUrl(postId: string): Promise<string | null | undefined>;
  clearHlsUrl(postId: string, hlsUrl: string): Promise<void>;
  otherPostUsesFolder(postId: string, folder: string): Promise<boolean>;
  listTree(prefix: string): Promise<{ path: string; modifiedAt: number }[]>;
  removeObjects(paths: string[]): Promise<number>;
  removeTree(prefix: string): Promise<number>;
  claimReconcile(limit: number): Promise<{ post_id: string; queued_at: string; attempts: number }[]>;
  completeReconcile(postId: string, queuedAt: string): Promise<void>;
  failReconcile(postId: string, message: string): Promise<void>;
  enqueueReconcile(limit: number): Promise<number>;
}

/** Converts a local video and uploads its HLS into [folder]. */
export type Converter = (folder: string) => Promise<{ master: string; files: string[]; metadata?: unknown; processingTime?: number }>;

export interface LifecycleOptions {
  /** TARGET_FOLDER, "converted" in production. */
  root: string;
  /** Public bucket the HLS lives in (TARGET_BUCKET). */
  bucket: string;
  /** Prefix of public object URLs in that bucket, ending in "/". */
  publicBase: string;
  /** Leftovers younger than this may belong to an attempt in flight. */
  staleMs: number;
  /** Queue drain interval; 0 disables the worker. */
  intervalMs: number;
  /** How often to run the database scan (hls_enqueue_reconcile). */
  scanMs: number;
  batch: number;
  /** Refuse private conversions while the queue is not being drained. */
  requireQueue: boolean;
  /** How recent the last successful drain must be to count as healthy. */
  healthMs: number;
}

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

export class HlsLifecycle {
  private lastDrainOk = 0;
  private lastScan = 0;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(private store: HlsStore, private opts: LifecycleOptions) {}

  private folderOf(postId: string): string {
    return hlsFolderFor(postId, this.opts.root);
  }

  /** Whether the reconcile queue was drained successfully recently. */
  queueHealthy(now: number = Date.now()): boolean {
    return this.lastDrainOk > 0 && now - this.lastDrainOk <= this.opts.healthMs;
  }

  async loadPolicyInputs(postId: string): Promise<{ post: PostRow | null; deletionPending: boolean }> {
    const post = await this.store.getPostForHls(postId);
    const deletionPending = post ? await this.store.hasDeletionJob(post.profile_id) : false;
    return { post, deletionPending };
  }

  /**
   * Convert [postId]'s own video. [run] downloads and converts; it is only
   * called once the post has been accepted.
   */
  async convert(postId: string, bucket: string, objectPath: string, run: Converter): Promise<Outcome> {
    const before = await this.loadPolicyInputs(postId);
    const refusal = conversionRefusal(before.post, bucket, objectPath, before.deletionPending);
    if (refusal || !before.post) {
      return { status: 403, body: { success: false, error: refusal } };
    }
    const post = before.post;
    if (post.hls_url) {
      // Idempotent: never redo (or put at risk) a published rendition.
      return { status: 200, body: { success: true, alreadyPublished: true } };
    }
    if (bucket === PRIVATE_SOURCE_BUCKET && this.opts.requireQueue && !this.queueHealthy()) {
      return {
        status: 503,
        body: { success: false, error: 'HLS revocation queue is not being drained; private media is not converted' },
      };
    }
    const folder = this.folderOf(postId);
    if (await this.store.otherPostUsesFolder(postId, folder)) {
      return { status: 409, body: { success: false, error: 'another post plays HLS from this folder' } };
    }

    const attemptDir = `${folder}/${newAttemptId()}`;
    let result: Awaited<ReturnType<Converter>>;
    try {
      result = await run(attemptDir);
    } catch (error) {
      await this.discardAttempt(attemptDir);
      return { status: 500, body: { success: false, error: errorText(error, 'conversion failed') } };
    }

    const hlsUrl = `${this.opts.publicBase}${result.master}`;
    let published: boolean;
    try {
      published = await this.store.publishHlsUrl(post, hlsUrl);
    } catch (error) {
      // The UPDATE may or may not have committed. Find out before touching files.
      let current: string | null | undefined;
      try {
        current = await this.store.getHlsUrl(postId);
      } catch {
        logger.error('Publish outcome unknown; attempt kept for the reconciler');
        return { status: 500, body: { success: false, error: 'publish outcome unknown; will be reconciled' } };
      }
      if (current !== hlsUrl) {
        await this.discardAttempt(attemptDir);
        return { status: 500, body: { success: false, error: errorText(error, 'publish failed') } };
      }
      published = true;
    }

    if (!published) {
      await this.discardAttempt(attemptDir);
      let current: string | null | undefined = null;
      try {
        current = await this.store.getHlsUrl(postId);
      } catch {
        /* the 409 below is still correct */
      }
      if (current) {
        return { status: 200, body: { success: true, alreadyPublished: true } };
      }
      return { status: 409, body: { success: false, error: 'post is no longer eligible; nothing published' } };
    }

    // The author's deletion state is in another table; recheck it now.
    let deletionPending: boolean;
    try {
      deletionPending = await this.store.hasDeletionJob(post.profile_id);
    } catch {
      deletionPending = false; // the account-deletion trigger queues this post anyway
    }
    if (deletionPending) {
      await this.revoke(postId).catch(err => logger.error('Revoke after deletion check failed:', err));
      return { status: 409, body: { success: false, error: 'the author\'s account is being deleted' } };
    }

    return {
      status: 200,
      body: {
        success: true,
        message: 'Video processed successfully',
        data: { outputFiles: result.files, metadata: result.metadata, processingTime: result.processingTime, masterPlaylist: result.master },
      },
    };
  }

  /** Remove one attempt's own folder (best effort; the reconciler retries). */
  private async discardAttempt(attemptDir: string): Promise<void> {
    try {
      await this.store.removeTree(attemptDir);
    } catch (error) {
      logger.error('Failed to remove a failed attempt; left for the reconciler:', error);
    }
  }

  /**
   * Remove the post's public copy when it may no longer have one. Returns
   * { revoked: false } for a post that is still eligible.
   */
  async revoke(postId: string): Promise<{ revoked: boolean; removed: number; kept?: string }> {
    const { post, deletionPending } = await this.loadPolicyInputs(postId);
    if (!revokeRequired(post, deletionPending)) {
      return { revoked: false, removed: 0 };
    }
    const roots = new Set<string>([this.folderOf(postId)]);
    const published = hlsRootOf(publishedDir(post?.hls_url ?? null, this.opts.bucket), this.opts.root);
    if (published) roots.add(published);

    let removed = 0;
    let kept: string | undefined;
    for (const folder of roots) {
      if (await this.store.otherPostUsesFolder(postId, folder)) {
        kept = 'another post plays HLS from this folder';
        continue;
      }
      removed += await this.store.removeTree(folder);
    }
    if (post?.hls_url && !kept) {
      await this.store.clearHlsUrl(postId, post.hls_url);
    }
    return { revoked: true, removed, kept };
  }

  /**
   * Bring one post's storage in line with its row: revoke when it may no
   * longer have a copy; otherwise remove anything under its folder that is
   * not the published rendition and is old enough not to be in flight.
   */
  async reconcile(postId: string, now: number = Date.now()): Promise<{ removed: number }> {
    const r = await this.revoke(postId);
    if (r.revoked) {
      // A folder another post plays from is that post's; nothing more to do.
      if (r.kept) logger.warn(`Reconcile kept a folder: ${r.kept}`);
      return { removed: r.removed };
    }
    const post = await this.store.getPostForHls(postId);
    const keepDir = publishedDir(post?.hls_url ?? null, this.opts.bucket);
    const objects = await this.store.listTree(this.folderOf(postId));
    const stale = objects
      .filter(o => path.posix.dirname(o.path) !== keepDir)
      .filter(o => now - o.modifiedAt >= this.opts.staleMs)
      .map(o => o.path);
    if (stale.length === 0) return { removed: 0 };
    return { removed: await this.store.removeObjects(stale) };
  }

  /** One drain of the queue (and, when due, the database scan). */
  async drainOnce(now: number = Date.now()): Promise<{ claimed: number; done: number; failed: number }> {
    if (this.draining) return { claimed: 0, done: 0, failed: 0 };
    this.draining = true;
    try {
      if (now - this.lastScan >= this.opts.scanMs) {
        try {
          const queued = await this.store.enqueueReconcile(500);
          this.lastScan = now;
          if (queued > 0) logger.info(`Reconcile scan queued ${queued} post(s)`);
        } catch (error) {
          logger.error('Reconcile scan failed:', error);
        }
      }
      const claims = await this.store.claimReconcile(this.opts.batch);
      this.lastDrainOk = Date.now();
      let done = 0;
      let failed = 0;
      for (const c of claims) {
        try {
          await this.reconcile(c.post_id);
          await this.store.completeReconcile(c.post_id, c.queued_at);
          done++;
        } catch (error) {
          failed++;
          logger.error(`Reconcile attempt ${c.attempts} failed:`, error);
          await this.store.failReconcile(c.post_id, errorText(error, 'reconcile failed')).catch(() => {});
        }
      }
      return { claimed: claims.length, done, failed };
    } catch (error) {
      logger.error('Reconcile queue unavailable:', error);
      return { claimed: 0, done: 0, failed: 0 };
    } finally {
      this.draining = false;
    }
  }

  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer) return;
    void this.drainOnce();
    this.timer = setInterval(() => void this.drainOnce(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
