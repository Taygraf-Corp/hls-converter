/**
 * Automatic HLS conversion of new videos (Hussam, 2026-11-03).
 *
 * Posts created outside the app (the n8n multi-account workflow writes the row
 * and uploads straight to storage) never ask for HLS, and an app request that
 * fails is never retried. Every HLS_AUTOCONVERT_INTERVAL_MS this asks the
 * database for recent video posts without HLS (hls_claim_autoconvert,
 * taygram-backend supabase/proposals/hls-unified/20261103120000_hls_autoconvert.sql)
 * and converts each one exactly as /api/process-from-storage would: the source
 * is taken from the post row itself and HlsLifecycle.convert() applies the
 * full policy, so a claim never widens what may be converted.
 *
 * Ownership (CTO review 2026-11-03):
 *  P1  A post is claimed only when work on it starts, one at a time, so a post
 *      never waits behind another while its attempts are counted. The claim is
 *      a lease the worker renews while it works (every lease/3). When renewal
 *      says the claim is no longer ours, or renewals keep failing until the
 *      lease is nearly over, or HLS_AUTOCONVERT_TIMEOUT_MS passes, the work is
 *      cancelled: ffmpeg is killed, nothing more is uploaded and the attempt
 *      folder is removed (HlsLifecycle.convert's failure path).
 *  P2  Renewal and the result carry the claim token; the database ignores
 *      either for a claim that is no longer current, so a late worker cannot
 *      finish or extend a newer attempt.
 *
 *  - Runs only while the revocation queue is healthy and never overlaps itself.
 *  - Missing functions (the SQL not applied yet) only log; nothing else changes.
 *  - HLS_AUTOCONVERT_INTERVAL_MS=0 (the default) turns it off. Turning it off
 *    stops new claims; a conversion already running finishes or is cancelled
 *    by its timeout.
 */
import { logger } from '../utils/logger.js';
import { PostRow, sourceOf } from './hls-policy.js';
import type { Outcome } from './hls-lifecycle.js';

export interface AutoConvertClaim {
  post_id: string;
  attempts: number;
  claim_token: string;
}

export interface AutoConvertStore {
  getPostForHls(postId: string): Promise<PostRow | null>;
  /** One post to convert now under a lease of [leaseMs], or null. */
  claimAutoconvert(leaseMs: number): Promise<AutoConvertClaim | null>;
  /** False: the claim is no longer this worker's. */
  renewAutoconvert(postId: string, token: string, leaseMs: number): Promise<boolean>;
  /** Records the outcome and releases the claim. False: not this worker's claim. */
  autoconvertResult(postId: string, token: string, error: string | null, final: boolean): Promise<boolean>;
}

/** Converts one post's own video; the route's conversion path. */
export type ConvertPost = (postId: string, bucket: string, objectPath: string, signal?: AbortSignal) => Promise<Outcome>;

export interface AutoConvertOptions {
  /** Interval between scans; 0 disables. */
  intervalMs: number;
  /** Posts converted per scan, one after another. */
  batch: number;
  /** Lease per claim; renewed every third of it. */
  leaseMs: number;
  /** Longest one conversion may run before it is cancelled. */
  timeoutMs: number;
}

export interface AutoConvertRun {
  claimed: number;
  converted: number;
  refused: number;
  failed: number;
  /** Cancelled because the claim stopped being ours; no result recorded. */
  lost: number;
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
    const run: AutoConvertRun = { claimed: 0, converted: 0, refused: 0, failed: 0, lost: 0 };
    if (this.running) return run;
    this.running = true;
    try {
      const batch = Math.max(1, Math.min(this.opts.batch, 20));
      for (let i = 0; i < batch && this.healthy(); i++) {
        // Claim only now, when this post's work starts (P1).
        let claim: AutoConvertClaim | null;
        try {
          claim = await this.store.claimAutoconvert(this.opts.leaseMs);
        } catch (error) {
          logger.warn(`Auto-convert unavailable: ${errorText(error)}`);
          break;
        }
        if (!claim) break;
        run.claimed++;
        const r = await this.work(claim);
        run[r]++;
      }
      if (run.claimed > 0) logger.info(`Auto-convert: ${JSON.stringify(run)}`);
      return run;
    } finally {
      this.running = false;
    }
  }

  /** Convert one claimed post under its lease. */
  private async work(claim: AutoConvertClaim): Promise<'converted' | 'refused' | 'failed' | 'lost'> {
    const { post_id: postId, claim_token: token } = claim;
    const controller = new AbortController();
    let lost = false;
    let lastRenewed = Date.now();
    const timeout = setTimeout(
      () => controller.abort(new Error(`timed out after ${this.opts.timeoutMs} ms`)),
      this.opts.timeoutMs,
    );
    const renewal = setInterval(() => {
      this.store.renewAutoconvert(postId, token, this.opts.leaseMs).then(
        ok => {
          if (ok) {
            lastRenewed = Date.now();
          } else if (!lost) {
            lost = true;
            controller.abort(new Error('the claim is no longer ours'));
          }
        },
        error => {
          logger.warn(`Auto-convert lease renewal failed: ${errorText(error)}`);
          // Stop before the lease can run out under us and another task claims it.
          if (!lost && Date.now() - lastRenewed >= this.opts.leaseMs * 0.8) {
            lost = true;
            controller.abort(new Error('could not renew the claim'));
          }
        },
      );
    }, Math.max(100, Math.floor(this.opts.leaseMs / 3)));

    let result: { error: string | null; final: boolean };
    try {
      result = await this.convertOne(postId, controller.signal);
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
    }

    if (lost) {
      logger.warn(`Auto-convert attempt ${claim.attempts} stopped: ${result.error ?? 'claim lost'}`);
      return 'lost';
    }
    if (result.error !== null) {
      logger.warn(`Auto-convert attempt ${claim.attempts} ${result.final ? 'refused' : 'failed'}: ${result.error}`);
    }
    try {
      const recorded = await this.store.autoconvertResult(postId, token, result.error, result.final);
      if (!recorded) logger.warn('Auto-convert result ignored: the claim is no longer ours');
    } catch (e) {
      logger.error(`Auto-convert result not recorded (the lease will run out): ${errorText(e)}`);
    }
    return result.error === null ? 'converted' : result.final ? 'refused' : 'failed';
  }

  private async convertOne(postId: string, signal: AbortSignal): Promise<{ error: string | null; final: boolean }> {
    try {
      const post = await this.store.getPostForHls(postId);
      if (!post) return { error: 'post not found', final: true };
      if (post.hls_url) return { error: null, final: false };
      const source = sourceOf(post);
      if (!source) return { error: 'post has no video source', final: true };
      const outcome = await this.convertPost(postId, source.bucket, source.path, signal);
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
