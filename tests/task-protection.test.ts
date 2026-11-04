/**
 * ECS task scale-in protection while conversions run (CTO, 2026-11-04):
 * protected before the work starts, renewed while it runs, cleared when the
 * last one ends, bounded by an expiry and a maximum hold, and never in the
 * way of the conversion itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL ||= 'error';
const { TaskProtection, MAX_EXPIRES_MINUTES } = await import('../src/services/task-protection.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const URI = 'http://agent.invalid/v3/abc';

type Call = { body: any; url: string; method: string };

/** A stand-in for the ECS agent endpoint. */
function agent(opts: { fail?: 'http' | 'error-json' | 'failure-json' | 'throw' | 'hang'; delayMs?: number } = {}) {
  const calls: Call[] = [];
  let state = false;
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ body, url, method: init.method });
    if (opts.delayMs) await sleep(opts.delayMs);
    if (opts.fail === 'hang') {
      // A real hung request keeps a socket open; keep the event loop alive the same way.
      const keep = setTimeout(() => {}, 10_000);
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason); }));
    }
    if (opts.fail === 'throw') throw new TypeError('fetch failed');
    if (opts.fail === 'http') return new Response('boom', { status: 500 });
    if (opts.fail === 'error-json') {
      return new Response(JSON.stringify({ error: { Code: 'AccessDeniedException', Message: 'no' } }), { status: 400 });
    }
    if (opts.fail === 'failure-json') {
      return new Response(JSON.stringify({ failure: { Reason: 'TASK_NOT_VALID' } }), { status: 200 });
    }
    state = body.ProtectionEnabled;
    return new Response(JSON.stringify({
      protection: { ProtectionEnabled: state, ExpirationDate: state ? '2026-11-04T01:00:00Z' : null, TaskArn: 'arn:task' },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, get state() { return state; } };
}
const enables = (calls: Call[]) => calls.filter(c => c.body.ProtectionEnabled === true).length;
const clears = (calls: Call[]) => calls.filter(c => c.body.ProtectionEnabled === false).length;

test('off unless enabled and the agent URI is set: the work just runs, nothing is sent', async () => {
  for (const o of [{ enabled: false, agentUri: URI }, { enabled: true, agentUri: undefined }, { enabled: true, agentUri: '' }]) {
    const a = agent();
    const p = new TaskProtection({ ...o, fetchImpl: a.fetchImpl });
    assert.equal(await p.hold(async () => 42), 42);
    await p.settled();
    assert.equal(a.calls.length, 0);
    assert.equal(p.status().state, 'off');
    assert.equal(p.configured, false);
  }
});

test('protected before the work starts, with the expiry; cleared after it ends', async () => {
  const a = agent();
  const p = new TaskProtection({ enabled: true, agentUri: URI + '/', expiresInMinutes: 45, fetchImpl: a.fetchImpl });
  let during: any = null;
  const r = await p.hold(async () => {
    during = { state: a.state, status: p.status() };
    return 'converted';
  });
  assert.equal(r, 'converted');
  assert.equal(during.state, true, 'the agent had confirmed protection before the work began');
  assert.equal(during.status.state, 'protected');
  assert.equal(during.status.active, 1);
  assert.equal(during.status.expiresAt, '2026-11-04T01:00:00Z');
  await p.settled();
  assert.deepEqual(a.calls.map(c => c.body), [{ ProtectionEnabled: true, ExpiresInMinutes: 45 }, { ProtectionEnabled: false }]);
  assert.equal(a.calls[0].url, `${URI}/task-protection/v1/state`);
  assert.equal(a.calls[0].method, 'PUT');
  assert.equal(a.state, false);
  assert.deepEqual(p.status(), { state: 'idle', active: 0, expiresAt: null, lastError: null });
});

test('overlapping conversions: one enable, and the clear only after the last one ends', async () => {
  const a = agent();
  const p = new TaskProtection({ enabled: true, agentUri: URI, fetchImpl: a.fetchImpl });
  let releaseA!: () => void;
  const A = p.hold(() => new Promise<void>(r => { releaseA = r; }));
  await sleep(5);
  let releaseB!: () => void;
  const B = p.hold(() => new Promise<void>(r => { releaseB = r; }));
  await sleep(5);
  assert.equal(p.status().active, 2);
  releaseA();
  await A;
  await p.settled();
  assert.equal(a.state, true, 'still protected while B runs');
  assert.equal(clears(a.calls), 0);
  releaseB();
  await B;
  await p.settled();
  assert.equal(enables(a.calls), 1);
  assert.equal(clears(a.calls), 1);
  assert.equal(a.state, false);
});

test('a conversion that starts while the clear is queued ends up protected', async () => {
  const a = agent({ delayMs: 20 });
  const p = new TaskProtection({ enabled: true, agentUri: URI, fetchImpl: a.fetchImpl });
  await p.hold(async () => {});
  // The clear is queued (not awaited by hold). Start another at once.
  let during: boolean | null = null;
  await p.hold(async () => { during = a.state; });
  assert.equal(during, true, 'protected while the second conversion ran');
  await p.settled();
  assert.equal(a.state, false);
  // Requests never overlap and the last word is a clear.
  assert.equal(a.calls.at(-1)!.body.ProtectionEnabled, false);
});

test('renewed while work runs, and the renewals stop when it ends', async () => {
  const a = agent();
  const p = new TaskProtection({ enabled: true, agentUri: URI, expiresInMinutes: 1, renewMs: 40, fetchImpl: a.fetchImpl });
  await p.hold(() => sleep(230));
  await p.settled();
  const n = enables(a.calls);
  assert.ok(n >= 4, `renewed: ${n} enables in 230 ms at 40 ms`);
  assert.equal(a.calls.at(-1)!.body.ProtectionEnabled, false);
  await sleep(150);
  assert.equal(enables(a.calls), n, 'no renewal after the work ended');
});

test('bounded: a conversion past maxHoldMs is no longer renewed, and the task is cleared when it ends', async () => {
  const a = agent();
  let clock = 1_000_000;
  const p = new TaskProtection({
    enabled: true, agentUri: URI, expiresInMinutes: 1, renewMs: 30, maxHoldMs: 60_000, fetchImpl: a.fetchImpl, now: () => clock,
  });
  let finish!: () => void;
  const stuck = p.hold(() => new Promise<void>(r => { finish = r; }));
  await sleep(100);
  const before = enables(a.calls);
  assert.ok(before >= 2, 'renewed while young');
  clock += 60_001;
  await sleep(120);
  const after = enables(a.calls);
  await sleep(120);
  assert.equal(enables(a.calls), after, 'no renewals once every conversion is past maxHoldMs');
  assert.ok(after - before <= 1, 'at most one renewal raced the clock change');

  // A new conversion protects the task again.
  let during: boolean | null = null;
  await p.hold(async () => { during = a.state; });
  assert.equal(during, true);
  finish();
  await stuck;
  await p.settled();
  assert.equal(a.state, false);
});

test('expiry and renewal are clamped to safe bounds', () => {
  const s = (o: any) => new TaskProtection({ enabled: true, agentUri: URI, ...o }).settings();
  assert.equal(s({}).expiresInMinutes, 45);
  assert.equal(s({}).renewMs, 600_000);
  assert.equal(s({}).maxHoldMs, 3_600_000);
  assert.equal(s({ expiresInMinutes: 100000 }).expiresInMinutes, MAX_EXPIRES_MINUTES);
  assert.equal(s({ expiresInMinutes: 0 }).expiresInMinutes, 1);
  assert.equal(s({ expiresInMinutes: NaN }).expiresInMinutes, 45);
  assert.equal(s({ expiresInMinutes: 30, renewMs: 3_600_000 }).renewMs, 600_000, 'renewal at most a third of the expiry');
  assert.equal(s({ maxHoldMs: -5 }).maxHoldMs, 3_600_000);
});

for (const fail of ['http', 'error-json', 'failure-json', 'throw', 'hang'] as const) {
  test(`an agent that fails (${fail}) never stops the conversion; the error is reported`, async () => {
    const a = agent({ fail });
    const p = new TaskProtection({ enabled: true, agentUri: URI, requestTimeoutMs: 50, fetchImpl: a.fetchImpl });
    const t0 = Date.now();
    let status: any = null;
    const r = await p.hold(async () => { status = p.status(); return 'ok'; });
    assert.equal(r, 'ok');
    assert.ok(Date.now() - t0 < 1000, 'the work was not held up');
    assert.equal(status.state, 'unprotected');
    if (fail === 'hang') {
      // The work is released at the timeout itself, so the error may only be
      // recorded just after it started.
      await p.settled();
      assert.match(p.status().lastError!, /: timeout$/);
    } else {
      assert.match(status.lastError, fail === 'error-json' ? /AccessDeniedException/ : fail === 'failure-json' ? /TASK_NOT_VALID/ : /^enable: /);
    }
    await p.settled();
    assert.equal(p.status().state, 'idle');
  });
}

test('the work\'s own error is passed through unchanged, and the task is still cleared', async () => {
  const a = agent();
  const p = new TaskProtection({ enabled: true, agentUri: URI, fetchImpl: a.fetchImpl });
  const err = new Error('ffmpeg exploded');
  await assert.rejects(p.hold(async () => { throw err; }), e => e === err);
  await p.settled();
  assert.equal(a.state, false);
  assert.equal(p.status().active, 0);
});

// CTO review 2026-11-04 (6c NO-GO), defect 1: after the protection has
// expired, fresh work must acquire it again instead of trusting the old
// "protected" state.
test('regression: after the protection expires, new work acquires it again before starting', async () => {
  let clock = 1_000_000;
  let expiresAt = 0; // the agent's own expiry, on the same clock
  let state = false;
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    state = body.ProtectionEnabled;
    expiresAt = state ? clock + body.ExpiresInMinutes * 60_000 : 0;
    return new Response(JSON.stringify({ protection: { ProtectionEnabled: state, ExpirationDate: new Date(expiresAt).toISOString() } }), { status: 200 });
  }) as unknown as typeof fetch;
  const protectedNow = () => state && clock < expiresAt;
  const p = new TaskProtection({
    enabled: true, agentUri: URI, expiresInMinutes: 1, renewMs: 20, maxHoldMs: 30_000, fetchImpl, now: () => clock,
  });

  // A stuck conversion: past maxHoldMs it is no longer renewed, and the
  // agent's protection then lapses.
  let finish!: () => void;
  const stuck = p.hold(() => new Promise<void>(r => { finish = r; }));
  await sleep(30);
  assert.equal(protectedNow(), true);
  clock += 120_000; // past maxHoldMs and past the 1-minute expiry
  await sleep(60);
  assert.equal(protectedNow(), false, 'the agent protection has expired');
  assert.equal(p.status().state, 'unprotected', 'status does not claim protection that has expired');

  const before = calls.length;
  let during: boolean | null = null;
  await p.hold(async () => { during = protectedNow(); });
  assert.ok(calls.length > before, 'an enable was sent for the new work');
  assert.equal(during, true, 'the new work ran protected');

  // Also: protection close to expiry is renewed before new work starts.
  clock = expiresAt - 1_000; // 1 s left, less than a renewal period away
  const before2 = calls.length;
  await p.hold(async () => { during = protectedNow(); });
  assert.ok(calls.length > before2, 'nearly expired protection is renewed for new work');
  finish();
  await stuck;
  await p.settled();
});

// Defect 2: concurrent conversions must not queue up behind each other's
// hung agent requests; each waits at most requestTimeoutMs from its own start.
test('regression: concurrent conversions with a hung agent each wait at most one request timeout', async () => {
  const a = agent({ fail: 'hang' });
  const p = new TaskProtection({ enabled: true, agentUri: URI, requestTimeoutMs: 120, fetchImpl: a.fetchImpl });
  const waits: number[] = [];
  const run = () => {
    const t0 = Date.now();
    return p.hold(async () => { waits.push(Date.now() - t0); await sleep(50); });
  };
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(waits.length, 4);
  for (const w of waits) assert.ok(w < 250, `each conversion started within one timeout: ${waits.join(', ')} ms`);
  assert.ok(enables(a.calls) <= 2, `concurrent starts share one enable request: ${enables(a.calls)}`);

  // Later arrivals while a request is hanging are bounded the same way.
  const late: Promise<void>[] = [];
  const first = run();
  await sleep(60);
  late.push(run());
  await Promise.all([first, ...late]);
  for (const w of waits.slice(4)) assert.ok(w < 250, `late arrival bounded: ${waits.join(', ')} ms`);
  await p.settled();
});
