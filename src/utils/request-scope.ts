/**
 * Time-limited, cancellable HTTP requests for one unit of work (CTO
 * re-review 2026-11-03, P1: an in-flight upload must not outlive a timeout).
 *
 * Inside runWithRequestScope(signal, timeoutMs, fn), every request the Supabase
 * client makes (storage downloads and uploads, PostgREST calls) goes through
 * scopedFetch and:
 *   - is aborted when [signal] aborts, if it started before that;
 *   - is always aborted after [timeoutMs].
 * A request started after [signal] aborted (the cleanup of a cancelled
 * attempt) gets only the time limit, so cleanup can still run.
 * Outside a scope (the app's own requests, the queue), requests are unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface Scope {
  signal: AbortSignal;
  timeoutMs: number;
}

const scopes = new AsyncLocalStorage<Scope>();

export function runWithRequestScope<T>(signal: AbortSignal, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return scopes.run({ signal, timeoutMs }, fn);
}

export const scopedFetch: typeof fetch = (input, init) => {
  const scope = scopes.getStore();
  if (!scope) {
    return fetch(input, init);
  }
  const signals: AbortSignal[] = [AbortSignal.timeout(scope.timeoutMs)];
  if (!scope.signal.aborted) signals.push(scope.signal);
  if (init?.signal) signals.push(init.signal);
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
};
