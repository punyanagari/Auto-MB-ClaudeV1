// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api.js';
import { SerialLookup } from '../../src/views/SerialLookup.js';
import { ORG_ID, stubApi } from './helpers.js';
import { outage, STATE_CASES, type StateCase } from './state-coverage-cases.js';

/*
 * Every view with a load path renders three states, and its failure
 * state carries a way out.
 *
 * The panel that commissioned pack P8 counted one skeleton in the whole
 * client, a retry beside three of about thirty load failures, and about
 * twenty-seven views whose failure branch printed a sentence and stopped.
 * A screen that says the register could not be read and offers nothing to
 * do about it leaves the browser's own reload button as the product's
 * error handling.
 *
 * So this file asserts, per view and per independent load:
 *
 *   1. while the load is in flight, something is announced as busy;
 *   2. when it fails, an alert appears AND a control re-runs that load;
 *   3. when it succeeds with nothing, the empty state says so — or the
 *      case records why the view has no empty state to show.
 *
 * Run against the tree before the pack, assertion 2 fails once per
 * dead-end view. That count is the measurement the pack was written to.
 */

/** The stub with this case's load replaced by a promise that never
 * settles: the wait, held open. */
function loadingApi(kase: StateCase): ApiClient {
  const overrides: Record<string, unknown> = {};
  for (const method of kase.loads) {
    overrides[method] = vi.fn().mockReturnValue(new Promise(() => undefined));
  }
  return stubApi({ ...kase.stub, ...overrides });
}

/** The stub with this case's load — and only this case's load — failing.
 * Failing everything at once would test one outage; failing exactly one
 * read is how a picker outage stays distinguishable from a register
 * outage, which is the distinction the retry labels encode. */
function failingApi(kase: StateCase): ApiClient {
  const overrides: Record<string, unknown> = {};
  for (const method of kase.loads) {
    overrides[method] = vi.fn().mockRejectedValue(outage());
  }
  return stubApi({ ...kase.stub, ...overrides });
}

function callsTo(api: ApiClient, method: keyof ApiClient): number {
  return vi.mocked(api[method] as unknown as (...args: never[]) => unknown).mock.calls
    .length;
}

describe.each(
  STATE_CASES.map((kase) => [`${kase.view} — ${kase.name}`, kase] as const),
)('%s', (_label, kase) => {
  it('announces the wait', () => {
    render(kase.render(loadingApi(kase)));

    // `role="status"` is what a skeleton block and a plain "Loading…"
    // line have in common; the assertion is that the wait is announced
    // at all, not which shape it took.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('offers a way out of the failure', async () => {
    const api = failingApi(kase);
    render(kase.render(api));

    const retry = await screen.findByRole('button', { name: kase.retry });
    // The failure is an alert, not a quiet line: it persists and it is
    // announced, unlike the success notice beside it which expires.
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    const [first] = kase.loads;
    if (first === undefined) throw new Error('a case must name its load');
    const before = callsTo(api, first);
    fireEvent.click(retry);
    expect(callsTo(api, first)).toBeGreaterThan(before);
  });

  const { empty } = kase;
  if ('notApplicable' in empty) {
    // skip-reason: this view has no legitimate empty state — a detail
    // screen shows one record, a fixed-row form shows its rows. The case
    // in state-coverage-cases.tsx says which, and the skipped test prints
    // it. Replacing that case's `notApplicable` with the sentence the
    // screen shows is what turns this back on.
    it.skip(`has no empty state: ${empty.notApplicable}`, () => undefined);
  } else {
    it('says so when there is nothing yet', async () => {
      render(kase.render(stubApi({ ...kase.stub, ...empty.stub })));

      expect(await screen.findAllByText(empty.text)).not.toHaveLength(0);
    });
  }
});

/* Serial Lookup loads on submit rather than on mount, so it sits outside
 * the table: there is nothing to hang or fail until a serial has been
 * asked for. The state contract is the same one. */
describe('SerialLookup.tsx — the serial search', () => {
  function renderLookup(api: ApiClient) {
    render(
      <SerialLookup
        api={api}
        organisationId={ORG_ID}
        onOpenWork={() => undefined}
        onOpenChallan={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'SB-2026-014' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Search' }).closest('form') ??
        (() => {
          throw new Error('form missing');
        })(),
    );
  }

  it('announces the wait', () => {
    renderLookup(
      stubApi({
        searchSerials: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );

    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('offers a way out of the failure', async () => {
    const searchSerials = vi.fn().mockRejectedValue(outage());
    renderLookup(stubApi({ searchSerials }));

    const retry = await screen.findByRole('button', { name: /Retry search/ });
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    const before = searchSerials.mock.calls.length;
    fireEvent.click(retry);
    // The retried search asks for the SAME serial, not whatever is in the
    // box by then.
    expect(searchSerials.mock.calls.length).toBeGreaterThan(before);
    expect(searchSerials.mock.calls.at(-1)).toEqual([ORG_ID, 'SB-2026-014']);
  });

  it('says so when nothing matches', async () => {
    renderLookup(stubApi());

    expect(await screen.findByText(/No serial matches/)).toBeTruthy();
  });
});
