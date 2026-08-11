import {
  ExecutionFailure,
  FailureClassificationContext,
  FailureDecision,
  RandomSource,
  RetryPolicy,
} from './contracts';

/**
 * Stable default policy for transport, authentication, conflict, and validation failures.
 *
 * @alpha
 */
export function classifyDefaultFailure(
  failure: ExecutionFailure,
  context: FailureClassificationContext,
): FailureDecision {
  if (failure.category === 'network' || failure.category === 'timeout') {
    return { type: 'retry' };
  }
  if (failure.category === 'request') {
    return { type: 'block', code: 'invalid_request' };
  }
  if (failure.category === 'response') {
    return { type: 'block', code: 'invalid_response' };
  }
  if (!('status' in failure)) {
    return { type: 'retry' };
  }

  if (failure.status === 401) {
    return { type: 'pause-scope', code: 'authentication_required' };
  }
  if (failure.status === 403) {
    return { type: 'block', code: 'permission_denied' };
  }
  if (failure.status === 409 || failure.status === 412) {
    return { type: 'block', code: 'conflict' };
  }
  if ([408, 425, 429].includes(failure.status) || failure.status >= 500) {
    const retryAfter = retryAfterDelay(failure.headers, context.now);
    return retryAfter === undefined ? { type: 'retry' } : { type: 'retry', delayMs: retryAfter };
  }
  return { type: 'block', code: 'permanent_failure' };
}

/**
 * Calculates an exponential retry delay, including deterministic injected jitter.
 *
 * @alpha
 */
export function calculateRetryDelay(
  policy: RetryPolicy | undefined,
  attempt: number,
  random: RandomSource,
): number {
  const initial = nonNegative(policy?.initialDelayMs, 1_000);
  const maximum = nonNegative(policy?.maximumDelayMs, 300_000);
  const multiplier = positive(policy?.multiplier, 2);
  const exponential = initial * multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(maximum, Number.isFinite(exponential) ? exponential : maximum);
  if (policy?.jitter === 'none') {
    return Math.round(capped);
  }
  const sample = random.next();
  const boundedSample = Number.isFinite(sample)
    ? Math.max(0, Math.min(sample, 1 - Number.EPSILON))
    : 0;
  return Math.floor(capped * boundedSample);
}

function retryAfterDelay(
  headers: Readonly<Record<string, string>>,
  now: number,
): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after');
  if (entry === undefined) {
    return undefined;
  }
  const value = entry[1].trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
