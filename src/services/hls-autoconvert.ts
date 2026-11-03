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
 * Ownership (CTO reviews 2026-11-03). One post is claimed when its work
 * starts, under a lease the worker renews with its claim token. With lease L:
 *   - renewal is sent every L/4 and each request is aborted after L/8;
 *   - an independent watchdog cancels the work once L/2 has passed since the
 *     last renewal the database confirmed (measured from when that request
 *     was sent), whatever the renewal requests are doing;
 *   - a refused renewal (the claim is someone else's now) cancels at once;
 *   - HLS_AUTOCONVERT_TIMEOUT_MS cancels a conversion that runs too long.
 * Cancelling kills ffmpeg and waits for it to exit, aborts every storage and
 * database request of the attempt (each is also limited to
 * HLS_AUTOCONVERT_REQUEST_TIMEOUT_MS, at most L/4), stops uploading and removes
 * the attempt folder. The worker waits at most L/4 for that, so its work has
 * stopped within 3L/4 of the last confirmed renewal, before the lease can
 * lapse. Anything still settling is counted in status().background. A late
 * second removal of the attempt folder catches an upload whose request was
 * aborted but which storage still stored; the hourly reconcile scan is the
 * backstop for both.
 *
 * Renewal and the result carry the claim token; the database ignores either
 * for a claim that is no longer current. A worker that lost its claim records
 * nothing.
 *
 * Every call to the database outside an attempt (claim, renewal, result) is
 * aborted after L/8 (CTO review round 3), so a hung response can never hold
 * up later scans: a claim whose answer was lost, or an unrecorded result,
 * only lets that lease lapse.
 *
 *  - Runs only while the revocation queue is healthy and never overlaps itself.
 *  - Missing functions (the SQL not applied yet) only log; nothing else changes.
 *  - HLS_AUTOCONVERT_INTERVAL_MS=0 (the default) turns it off.
 */
import { logger } from '../utils/logger.js';
import { runWithRequestScope } from '../utils/request-scope.js';
import { PostRow, sourceOf } from './hls-policy.js';
import type { Outcome } from './hls-lifecycle.js';

export interface AutoConvertClaim {
  post_id: string;
  attempts: number;
  claim_token: string;
}

export interface AutoConvertStore {
  getPostForHls(postId: string): Promise<PostRow | null>;
  /** One post to convert now under a lease of [leaseMs], or null. The request ends after [timeoutMs]. */
  claimAutoconvert(leaseMs: number, timeoutMs: number): Promise<AutoConvertClaim | null>;
  /** False: the claim is no longer this worker's. The request ends after [timeoutMs]. */
  renewAutoconvert(postId: string, token: string, leaseMs: number, timeoutMs: number): Promise<boolean>;
  /** Records the outcome and releases the claim. False: not this worker's claim. The request ends after [timeoutMs]. */
  autoconvertResult(postId: string, token: string, error: string | null, final: boolean, timeoutMs: number): Promise<boolean>;
}

/** Converts one post's own video; the route's conversion path. */
export type ConvertPost = (
  postId: string,
  bucket: string,
  objectPath: string,
  signal?: AbortSignal,
  onLateWork?: (work: () => Promise<unknown>) => void,
) => Promise<Outcome>;

export interface AutoConvertOptions {
  /** Interval between scans; 0 disables. */
  intervalMs: number;
  /** Posts converted per scan, one after another. */
  batch: number;
  /** Lease per claim (L above). */
  leaseMs: number;
  /** Longest one conversion may run before it is cancelled. */
  timeoutMs: number;
  /** Limit for each storage/database request of an attempt; capped at L/4. */
  requestTimeoutMs: number;
  /** Delay before the second removal of a cancelled attempt's folder. */
  lateSweepMs?: number;
}

export interface AutoConvertRun {
  claimed: number;
  converted: number;
  refused: number;
  failed: number;
  /** Stopped because the claim was lost or could not be confirmed; no result recorded. */
  lost: number;
}

export interface AutoConvertStatus {
  state: 'off' | 'idle' | 'working';
  /** Cancelled work still settling, and pending late removals. */
  background: number;
}

/** 403 and 409 mean the converter will not convert this post: no retry. */
export function isFinal(status: number): boolean {
  return status === 403 || status === 409;
}

type Result = { error: string | null; final: boolean };

export class HlsAutoConvert {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private working = false;
  private background = 0;

  constructor(
    private store: AutoConvertStore,
    private convertPost: ConvertPost,
    private healthy: () => boolean,
    private opts: AutoConvertOptions,
  ) {}

  status(): AutoConvertStatus {
    return {
      state: this.opts.intervalMs <= 0 ? 'off' : this.working ? 'working' : 'idle',
      background: this.background,
    };
  }

  private get lease() {
    const L = Math.max(1, this.opts.leaseMs);
    return {
      renewEveryMs: Math.max(1, Math.floor(L / 4)),
      rpcTimeoutMs: Math.max(1, Math.floor(L / 8)),
      unconfirmedMs: Math.floor(L / 2),
      stopGraceMs: Math.max(1, Math.floor(L / 4)),
      watchEveryMs: Math.max(10, Math.min(1000, Math.floor(L / 20))),
      requestTimeoutMs: Math.max(1, Math.min(this.opts.requestTimeoutMs, Math.floor(L / 4))),
    };
  }

  async runOnce(): Promise<AutoConvertRun> {
    const run: AutoConvertRun = { claimed: 0, converted: 0, refused: 0, failed: 0, lost: 0 };
    if (this.running) return run;
    this.running = true;
    try {
      const batch = Math.max(1, Math.min(this.opts.batch, 20));
      for (let i = 0; i < batch && this.healthy(); i++) {
        // Claim only now, when this post's work starts.
        const sentAt = Date.now();
        let claim: AutoConvertClaim | null;
        try {
          claim = await this.store.claimAutoconvert(this.opts.leaseMs, this.lease.rpcTimeoutMs);
        } catch (error) {
          logger.warn(`Auto-convert unavailable: ${errorText(error)}`);
          break;
        }
        if (!claim) break;
        run.claimed++;
        this.working = true;
        try {
          run[await this.work(claim, sentAt)]++;
        } finally {
          this.working = false;
        }
      }
      if (run.claimed > 0) logger.info(`Auto-convert: ${JSON.stringify(run)}`);
      return run;
    } finally {
      this.running = false;
    }
  }

  /** Convert one claimed post under its lease. [claimSentAt]: when the claim request was sent. */
  private async work(claim: AutoConvertClaim, claimSentAt: number): Promise<'converted' | 'refused' | 'failed' | 'lost'> {
    const { post_id: postId, claim_token: token } = claim;
    const t = this.lease;
    const controller = new AbortController();
    let lost = false;
    let confirmedAt = claimSentAt;
    const cancel = (why: string, claimLost: boolean) => {
      if (claimLost) lost = true;
      if (!controller.signal.aborted) controller.abort(new Error(why));
    };

    const timeout = setTimeout(() => cancel(`timed out after ${this.opts.timeoutMs} ms`, false), this.opts.timeoutMs);
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      const sentAt = Date.now();
      this.store.renewAutoconvert(postId, token, this.opts.leaseMs, t.rpcTimeoutMs).then(
        ok => {
          if (ok) confirmedAt = Math.max(confirmedAt, sentAt);
          else cancel('the claim is no longer ours', true);
        },
        error => logger.warn(`Auto-convert lease renewal failed: ${errorText(error)}`),
      ).finally(() => { renewing = false; });
    }, t.renewEveryMs);
    // Independent of the renewal requests: a hung renewal cannot keep the work alive.
    const watchdog = setInterval(() => {
      if (Date.now() - confirmedAt >= t.unconfirmedMs) cancel('the lease could not be confirmed in time', true);
    }, t.watchEveryMs);

    const job = runWithRequestScope(controller.signal, t.requestTimeoutMs, () =>
      this.convertOne(postId, controller.signal, late => this.lateWork(late)),
    );
    let result: Result | null;
    try {
      result = await this.settle(job, controller.signal, t.stopGraceMs);
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      clearInterval(watchdog);
    }

    if (result === null) {
      logger.error('Auto-convert: cancelled work did not stop within the grace period; counted as background');
      this.track(job);
      if (!lost) {
        // Our claim is still current: give it up as a retryable failure.
        result = { error: String((controller.signal.reason as Error)?.message ?? 'cancelled'), final: false };
      }
    }
    if (lost || result === null) {
      logger.warn(`Auto-convert attempt ${claim.attempts} stopped: ${String((controller.signal.reason as Error)?.message ?? 'claim lost')}`);
      return 'lost';
    }
    if (result.error !== null) {
      logger.warn(`Auto-convert attempt ${claim.attempts} ${result.final ? 'refused' : 'failed'}: ${result.error}`);
    }
    try {
      const recorded = await this.store.autoconvertResult(postId, token, result.error, result.final, t.rpcTimeoutMs);
      if (!recorded) logger.warn('Auto-convert result ignored: the claim is no longer ours');
    } catch (e) {
      logger.error(`Auto-convert result not recorded (the lease will run out): ${errorText(e)}`);
    }
    return result.error === null ? 'converted' : result.final ? 'refused' : 'failed';
  }

  /** [job]'s result; null when it is still running [graceMs] after [signal] aborted. */
  private settle(job: Promise<Result>, signal: AbortSignal, graceMs: number): Promise<Result | null> {
    return new Promise(resolve => {
      let grace: NodeJS.Timeout | null = null;
      const onAbort = () => { grace = setTimeout(() => resolve(null), graceMs); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      job.then(r => {
        signal.removeEventListener('abort', onAbort);
        if (grace) clearTimeout(grace);
        resolve(r);
      });
    });
  }

  private track(p: Promise<unknown>): void {
    this.background++;
    p.catch(() => {}).finally(() => { this.background--; });
  }

  /** Run [work] after the late-sweep delay (an aborted upload may land meanwhile). */
  private lateWork(work: () => Promise<unknown>): void {
    const delay = this.opts.lateSweepMs ?? this.lease.requestTimeoutMs + 30_000;
    this.track(new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        work().catch(e => logger.warn(`Auto-convert late removal failed (the reconcile scan retries): ${errorText(e)}`))
          .finally(() => resolve());
      }, delay);
      timer.unref?.();
    }));
  }

  private async convertOne(
    postId: string,
    signal: AbortSignal,
    onLateWork: (work: () => Promise<unknown>) => void,
  ): Promise<Result> {
    try {
      const post = await this.store.getPostForHls(postId);
      if (!post) return { error: 'post not found', final: true };
      if (post.hls_url) return { error: null, final: false };
      const source = sourceOf(post);
      if (!source) return { error: 'post has no video source', final: true };
      const outcome = await this.convertPost(postId, source.bucket, source.path, signal, onLateWork);
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
