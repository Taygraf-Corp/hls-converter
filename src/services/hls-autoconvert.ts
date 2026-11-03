/**
 * Automatic HLS conversion of new videos (Hussam, 2026-11-03).
 *
 * Posts created outside the app (the n8n multi-account workflow writes the row
 * and uploads straight to storage) never ask for HLS, and an app request that
 * fails is never retried. Every HLS_AUTOCONVERT_INTERVAL_MS this asks the
 * database for a few recent video posts without HLS
 * (hls_claim_autoconvert, taygram-backend
 * supabase/proposals/hls-unified/20261103120000_hls_autoconvert.sql) and
 * converts each one exactly as /api/process-from-storage would: the source is
 * taken from the post row itself and HlsLifecycle.convert() applies the full
 * policy, so a claim never widens what may be converted.
 *
 *  - Runs only while the revocation queue is healthy, one post at a time,
 *    never overlapping itself.
 *  - The database bounds the work: 10 minutes to 7 days old, at most three
 *    attempts per post, and a converted or refused post is never claimed again.
 *  - Missing functions (the SQL not applied yet) only log; nothing else changes.
 *  - HLS_AUTOCONVERT_INTERVAL_MS=0 turns it off.
 */
import { logger } from '../utils/logger.js';
import { PostRow, sourceOf } from './hls-policy.js';
import type { Outcome } from './hls-lifecycle.js';

export interface AutoConvertStore {
  getPostForHls(postId: string): Promise<PostRow | null>;
  claimAutoconvert(limit: number): Promise<{ post_id: string; attempts: number }[]>;
  autoconvertResult(postId: string, error: string | null, final: boolean): Promise<void>;
}

/** Converts one post's own video; the route's conversion path. */
export type ConvertPost = (postId: string, bucket: string, objectPath: string) => Promise<Outcome>;

export interface AutoConvertOptions {
  /** Interval between scans; 0 disables. */
  intervalMs: number;
  /** Posts claimed per scan. */
  batch: number;
}

export interface AutoConvertRun {
  claimed: number;
  converted: number;
  refused: number;
  failed: number;
}

/** 403 and 409 mean the converter will not convert this post: no retry. */
export function isFinal(status: number): boolean {
  return status === 403 || status === 409;
}

export class HlsAutoConvert {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private store: AutoConvertStore,
    private convertPost: ConvertPost,
    private healthy: () => boolean,
    private opts: AutoConvertOptions,
  ) {}

  async runOnce(): Promise<AutoConvertRun> {
    const run: AutoConvertRun = { claimed: 0, converted: 0, refused: 0, failed: 0 };
    if (this.running || !this.healthy()) return run;
    this.running = true;
    try {
      let claims: { post_id: string; attempts: number }[];
      try {
        claims = await this.store.claimAutoconvert(Math.max(1, Math.min(this.opts.batch, 20)));
      } catch (error) {
        logger.warn(`Auto-convert unavailable: ${errorText(error)}`);
        return run;
      }
      run.claimed = claims.length;
      for (const c of claims) {
        const { error, final } = await this.convertOne(c.post_id);
        if (error === null) run.converted++;
        else if (final) run.refused++;
        else run.failed++;
        if (error !== null) {
          logger.warn(`Auto-convert attempt ${c.attempts} ${final ? 'refused' : 'failed'}: ${error}`);
        }
        try {
          await this.store.autoconvertResult(c.post_id, error, final);
        } catch (e) {
          logger.error(`Auto-convert result not recorded: ${errorText(e)}`);
        }
      }
      if (run.claimed > 0) logger.info(`Auto-convert: ${JSON.stringify(run)}`);
      return run;
    } finally {
      this.running = false;
    }
  }

  private async convertOne(postId: string): Promise<{ error: string | null; final: boolean }> {
    try {
      const post = await this.store.getPostForHls(postId);
      if (!post) return { error: 'post not found', final: true };
      if (post.hls_url) return { error: null, final: false };
      const source = sourceOf(post);
      if (!source) return { error: 'post has no video source', final: true };
      const outcome = await this.convertPost(postId, source.bucket, source.path);
      if (outcome.status === 200) return { error: null, final: false };
      return { error: `${outcome.status} ${String(outcome.body.error ?? 'conversion failed')}`, final: isFinal(outcome.status) };
    } catch (error) {
      return { error: errorText(error), final: false };
    }
  }

  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer) return;
    // The first scan waits one interval, so the queue has been drained by then.
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
