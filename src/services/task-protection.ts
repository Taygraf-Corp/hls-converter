/**
 * ECS task scale-in protection while conversions run (CTO, 2026-11-04).
 *
 * The service autoscales between 1 and 5 tasks. Scale-in picks any task, so
 * a task stopped in the middle of a conversion loses that work, and for an
 * automatic conversion it uses up one of the post's attempts. While at least
 * one conversion is running in this task, this marks the task protected
 * through the ECS agent (PUT $ECS_AGENT_URI/task-protection/v1/state), and it
 * clears the protection as soon as the last conversion ends.
 * https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html
 *
 * Bounded:
 *   - every protection request carries ExpiresInMinutes (default 45, at most
 *     120), so a task that hangs or crashes is unprotected again by itself;
 *   - while work is running the protection is renewed every renewMs (default
 *     10 minutes, at most a third of the expiry);
 *   - a conversion older than maxHoldMs (default 60 minutes) no longer counts
 *     for renewal, so one stuck conversion protects the task for at most
 *     maxHoldMs plus one expiry.
 * Protection also holds back a service deployment from stopping the task (it
 * waits until the protection is cleared or expires), so a rollout while a
 * conversion runs finishes once that conversion ends.
 *
 * Fresh work never trusts an old protection (CTO review 2026-11-04, defect 1):
 * the expiry is tracked locally from when each enable was sent, and a new
 * conversion re-enables unless the protection still has more than one
 * renewal period (plus a request timeout) left. status() reports
 * 'unprotected' once the tracked expiry has passed.
 *
 * Best effort: a failed or slow agent request (no permission, no agent,
 * throttled) is logged and shown in status(); the conversion itself always
 * runs and its result or error is returned unchanged. Each request is
 * aborted after requestTimeoutMs. A conversion waits for protection at most
 * requestTimeoutMs from its own start, however many others are starting or
 * however many requests are queued (defect 2); conversions that start while
 * an enable is in flight share it, and a renewal is skipped while a request
 * is still running.
 *
 * Off unless HLS_TASK_PROTECTION=on and ECS_AGENT_URI is set (ECS sets it in
 * every task). The task role needs ecs:UpdateTaskProtection and
 * ecs:GetTaskProtection.
 */
import { logger } from '../utils/logger.js';

export interface TaskProtectionOptions {
  /** ECS_AGENT_URI; protection is off without it. */
  agentUri?: string;
  /** HLS_TASK_PROTECTION=on. */
  enabled: boolean;
  /** Expiry sent with every protection request; clamped to 1..120. */
  expiresInMinutes?: number;
  /** Renewal period while work runs; at most a third of the expiry. */
  renewMs?: number;
  /** A conversion running longer than this stops counting for renewal. */
  maxHoldMs?: number;
  /** Limit for each agent request. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
  /** For tests. */
  now?: () => number;
}

export interface TaskProtectionStatus {
  /** off: not configured. idle: nothing running. protected: work running and the agent confirmed. unprotected: work running but the last request failed. */
  state: 'off' | 'idle' | 'protected' | 'unprotected';
  active: number;
  expiresAt: string | null;
  lastError: string | null;
}

export const MAX_EXPIRES_MINUTES = 120;

export class TaskProtection {
  private readonly url: string | null;
  private readonly expiresInMinutes: number;
  private readonly renewMs: number;
  private readonly maxHoldMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private readonly holds = new Map<number, number>(); // id -> start time
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** What the agent last confirmed: true protected, false cleared, null unknown. */
  private applied: boolean | null = false;
  private expiresAt: string | null = null;
  /** Local deadline of the confirmed protection (from when the enable was sent); 0 when none. */
  private protectedUntil = 0;
  /** The enable that starting conversions share, while it is queued or running. */
  private enabling: Promise<void> | null = null;
  private inflight = false;
  private lastError: string | null = null;

  constructor(opts: TaskProtectionOptions) {
    const agent = (opts.agentUri ?? '').replace(/\/+$/, '');
    this.url = opts.enabled && agent ? `${agent}/task-protection/v1/state` : null;
    const exp = Math.floor(Number(opts.expiresInMinutes ?? 45));
    this.expiresInMinutes = Math.min(MAX_EXPIRES_MINUTES, Math.max(1, Number.isFinite(exp) ? exp : 45));
    const renew = Number(opts.renewMs ?? 600_000);
    this.renewMs = Math.max(10, Math.min(Number.isFinite(renew) ? renew : 600_000, (this.expiresInMinutes * 60_000) / 3));
    const hold = Number(opts.maxHoldMs ?? 3_600_000);
    this.maxHoldMs = Number.isFinite(hold) && hold > 0 ? hold : 3_600_000;
    this.requestTimeoutMs = Math.max(1, Number(opts.requestTimeoutMs ?? 5_000) || 5_000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return this.url !== null;
  }

  /** The effective settings, after clamping. */
  settings(): { expiresInMinutes: number; renewMs: number; maxHoldMs: number } {
    return { expiresInMinutes: this.expiresInMinutes, renewMs: this.renewMs, maxHoldMs: this.maxHoldMs };
  }

  status(): TaskProtectionStatus {
    if (!this.url) return { state: 'off', active: 0, expiresAt: null, lastError: null };
    const active = this.holds.size;
    const live = this.applied === true && this.now() < this.protectedUntil;
    const state = active === 0 ? 'idle' : live ? 'protected' : 'unprotected';
    return { state, active, expiresAt: live ? this.expiresAt : null, lastError: this.lastError };
  }

  /**
   * Runs [work] with the task protected. The enable request is awaited (at
   * most requestTimeoutMs) before [work] starts; the release is not awaited.
   */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    if (!this.url) return work();
    const id = this.nextId++;
    this.holds.set(id, this.now());
    if (!this.timer) {
      this.timer = setInterval(() => { if (!this.inflight) void this.sync(true); }, this.renewMs);
      this.timer.unref?.();
    }
    if (!this.enabling) {
      const e: Promise<void> = this.sync(false).finally(() => { if (this.enabling === e) this.enabling = null; });
      this.enabling = e;
    }
    await this.bounded(this.enabling);
    try {
      return await work();
    } finally {
      this.holds.delete(id);
      if (this.holds.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      void this.sync(false);
    }
  }

  /** Waits for every queued agent request (tests, shutdown). */
  async settled(): Promise<void> {
    let c: Promise<void>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  /** Waits for [p], at most requestTimeoutMs. */
  private bounded(p: Promise<void>): Promise<void> {
    let t: NodeJS.Timeout | undefined;
    const limit = new Promise<void>(resolve => { t = setTimeout(resolve, this.requestTimeoutMs); });
    return Promise.race([p, limit]).finally(() => clearTimeout(t));
  }

  /** The protection outlasts the next renewal, so new work may rely on it. */
  private fresh(): boolean {
    return this.applied === true && this.protectedUntil - this.now() > this.renewMs + this.requestTimeoutMs;
  }

  /** Brings the agent to the wanted state; [renew] re-sends an enable. Requests never overlap. */
  private sync(renew: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.apply(renew)).catch(() => {});
    return this.chain;
  }

  private wanted(): boolean {
    const t = this.now();
    for (const start of this.holds.values()) {
      if (t - start < this.maxHoldMs) return true;
    }
    return false;
  }

  private async apply(renew: boolean): Promise<void> {
    if (this.holds.size === 0) {
      if (this.applied !== false) await this.put(false);
      return;
    }
    if (this.wanted()) {
      if (renew || !this.fresh()) await this.put(true);
    } else if (renew) {
      // Every running conversion is past maxHoldMs: stop renewing and let the
      // protection lapse at its expiry. It is cleared when the work ends.
      logger.warn(`Task protection: not renewed, ${this.holds.size} conversion(s) running longer than ${this.maxHoldMs} ms`);
    }
  }

  private async put(enable: boolean): Promise<void> {
    const body = enable ? { ProtectionEnabled: true, ExpiresInMinutes: this.expiresInMinutes } : { ProtectionEnabled: false };
    const sentAt = this.now();
    this.inflight = true;
    try {
      const res = await this.fetchImpl(this.url as string, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      const p = json?.protection;
      if (res.ok && p && p.ProtectionEnabled === enable) {
        this.applied = enable;
        this.expiresAt = enable ? (p.ExpirationDate ?? null) : null;
        this.protectedUntil = enable ? sentAt + this.expiresInMinutes * 60_000 : 0;
        this.lastError = null;
        return;
      }
      const why = json?.error?.Code ?? json?.failure?.Reason ?? `HTTP ${res.status}`;
      throw new Error(String(why));
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : String(e);
      this.lastError = `${enable ? 'enable' : 'clear'}: ${msg}`;
      // Unknown now: an enable that failed is retried at the next renewal, a
      // clear at the next change; the expiry bounds either way.
      this.applied = enable ? (this.applied === true ? true : null) : null;
      logger.warn(`Task protection ${enable ? 'enable' : 'clear'} failed: ${msg}`);
    } finally {
      this.inflight = false;
    }
  }
}
