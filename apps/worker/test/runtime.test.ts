import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Db from '@auto-mb/db';
import type { ClaimedJob } from '@auto-mb/db';
import { TenantBindRefusedError } from '@auto-mb/db';

/**
 * The worker's decision logic, without a database.
 *
 * What an outcome does to the queue is proved end-to-end against real
 * PostgreSQL in `packages/db/test/worker-queue.integration.test.ts` — that
 * is where ADR-0011's guards live, because they are claims about SQL. What
 * is proved HERE is the branch the worker chooses before it gets there:
 * which of complete/fail/refuse it calls, and with what. Those branches
 * decide whether a revoked user's job is retried for ever or parked once,
 * and they should be readable without a cluster.
 */

type TenantFn = (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;

// Declared with an `unknown[]` parameter so `mock.calls` stays indexable:
// what these assertions care about is WHICH argument the worker passed
// (an outcome, a retry instant, or nothing), not its static type.
const completeJob = vi.fn((..._args: unknown[]): Promise<boolean> =>
  Promise.resolve(true),
);
const failJob = vi.fn((..._args: unknown[]): Promise<boolean> => Promise.resolve(true));
const refuseJobBind = vi.fn((..._args: unknown[]): Promise<boolean> =>
  Promise.resolve(true),
);
const claimNextJob = vi.fn((): Promise<ClaimedJob | undefined> =>
  Promise.resolve(undefined),
);
const withJobAuthority = vi.fn(
  (_sql: unknown, _job: ClaimedJob, work: (tx: unknown) => Promise<unknown>) =>
    work({}),
);

vi.mock('@auto-mb/db', async () => {
  const actual = await vi.importActual<typeof Db>('@auto-mb/db');
  return {
    ...actual,
    completeJob: (...args: unknown[]) => completeJob(...args),
    failJob: (...args: unknown[]) => failJob(...args),
    refuseJobBind: (...args: unknown[]) => refuseJobBind(...args),
    claimNextJob: (...args: unknown[]) => claimNextJob(...(args as [])),
    withJobAuthority: (...args: unknown[]) =>
      withJobAuthority(...(args as Parameters<typeof withJobAuthority>)),
  };
});

const { PermanentJobError, retryDelayMs, runJob, runWorkerLoop } =
  await import('../src/runtime.js');

const silent = { info: () => {}, error: () => {} };
const sql = {} as never;

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    organisationId: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    kind: 'loa_document_intake',
    payloadRef: { documentId: 'doc-1' },
    attempts: 1,
    maxAttempts: 5,
    claimToken: '22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

/** A handler that neither reads nor writes: enough for the branches that
 * are about what `runJob` does with what it is handed. */
function handlerReturning(outcome: Record<string, unknown> | null) {
  return { loa_document_intake: () => Promise.resolve(outcome) } as never;
}

function handlerThrowing(error: Error) {
  return { loa_document_intake: () => Promise.reject(error) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimNextJob.mockResolvedValue(undefined);
  withJobAuthority.mockImplementation(
    (_sql: unknown, _job: ClaimedJob, work: (tx: unknown) => Promise<unknown>) =>
      work({}),
  );
});

describe('runJob', () => {
  it('completes a handler that returns, and records its outcome', async () => {
    expect(
      await runJob(sql, job(), handlerReturning({ documentId: 'doc-1' }), silent),
    ).toBe('done');
    expect(completeJob).toHaveBeenCalledOnce();
    expect(completeJob.mock.calls[0]?.[2]).toEqual({ documentId: 'doc-1' });
    expect(failJob).not.toHaveBeenCalled();
    expect(refuseJobBind).not.toHaveBeenCalled();
  });

  it('parks a refused bind terminally, and never as an ordinary failure', async () => {
    // The distinction ADR-0011 turns on. A retried bind refusal would
    // re-refuse on every attempt and settle in `failed`, where a revoked
    // user reads as a broken job rather than a revoked user.
    withJobAuthority.mockRejectedValue(
      new TenantBindRefusedError(
        '11111111-1111-4111-8111-111111111111',
        'user-1',
        null,
      ),
    );

    // The handler asks for its bound transaction, which is where the
    // refusal happens — before any statement of its body runs.
    // `readPayload` stands for the first thing every handler does with
    // tenant data, and must stay false.
    let readPayload = false;
    const handlers = {
      loa_document_intake: ({ tenant }: { tenant: TenantFn }) =>
        tenant(() => {
          readPayload = true;
          return Promise.resolve(null);
        }),
    } as never;

    expect(await runJob(sql, job(), handlers, silent)).toBe('refused_bind');
    expect(readPayload).toBe(false);
    expect(refuseJobBind).toHaveBeenCalledOnce();
    expect(failJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('fails a permanent error immediately, with no retry instant', async () => {
    const handlers = handlerThrowing(
      new PermanentJobError('the document no longer exists'),
    );
    expect(await runJob(sql, job(), handlers, silent)).toBe('failed');
    // A fourth argument would carry a retry time; its absence is what
    // makes the failure terminal on the first attempt.
    expect(failJob).toHaveBeenCalledWith(
      sql,
      expect.anything(),
      'the document no longer exists',
    );
  });

  it('retries an ordinary error with a backoff instant in the future', async () => {
    const handlers = handlerThrowing(new Error('extraction fell over'));
    expect(await runJob(sql, job({ attempts: 1 }), handlers, silent)).toBe('retry');
    const retryAt = failJob.mock.calls[0]?.[3] as Date | undefined;
    expect(retryAt).toBeInstanceOf(Date);
    expect(retryAt === undefined ? 0 : retryAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('reports failure once the attempts are spent', async () => {
    const handlers = handlerThrowing(new Error('still broken'));
    expect(
      await runJob(sql, job({ attempts: 5, maxAttempts: 5 }), handlers, silent),
    ).toBe('failed');
  });

  it('retries rather than fails a kind it has no handler for', async () => {
    // Deployment skew: an older worker against a newer schema. The job is
    // probably fine and this process is not, so the retry budget must not
    // be spent silently on it.
    expect(await runJob(sql, job(), {} as never, silent)).toBe('retry');
    expect(failJob).toHaveBeenCalledOnce();
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and then stops growing', () => {
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(4)).toBe(80_000);
    // Capped, so a long-broken dependency does not push the next attempt
    // beyond any window an operator would sit and watch.
    expect(retryDelayMs(20)).toBe(300_000);
  });
});

describe('runWorkerLoop', () => {
  it('waits the idle interval when the queue is empty, and stops on abort', async () => {
    const controller = new AbortController();
    let waits = 0;
    const sleep = (ms: number): Promise<void> => {
      waits += 1;
      expect(ms).toBe(25);
      if (waits === 3) controller.abort();
      return Promise.resolve();
    };
    await runWorkerLoop(sql, {
      claimedBy: 'test',
      leaseSeconds: 60,
      idlePollMs: 25,
      signal: controller.signal,
      handlers: {} as never,
      log: silent,
      sleep,
    });
    expect(waits).toBe(3);
  });

  it('backs off instead of spinning when the claim itself fails', async () => {
    // A database that has gone away must not become a hot loop against it.
    const controller = new AbortController();
    claimNextJob.mockRejectedValue(new Error('connection refused'));
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      if (delays.length === 3) controller.abort();
      return Promise.resolve();
    };
    await runWorkerLoop(sql, {
      claimedBy: 'test',
      leaseSeconds: 60,
      idlePollMs: 25,
      signal: controller.signal,
      handlers: {} as never,
      log: silent,
      sleep,
    });
    expect(delays).toEqual([10_000, 20_000, 40_000]);
  });
});
