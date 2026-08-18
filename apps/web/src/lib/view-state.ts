import { useCallback, useState } from 'react';
import { errorMessage } from './load-failure.js';

/**
 * The reload counter every register carries.
 *
 * A view's load effect is keyed on a number rather than on a boolean or a
 * function identity, so that asking for the same read twice is still two
 * reads: bumping the counter is the only way to re-run an effect whose
 * other dependencies have not changed. The returned bump is stable, so it
 * can be passed to `ErrorState`'s `onRetry` or held in a dependency array
 * without re-running anything by itself.
 */
export function useReload(): readonly [number, () => void] {
  const [loadVersion, setLoadVersion] = useState(0);
  const reload = useCallback(() => {
    setLoadVersion((current) => current + 1);
  }, []);
  return [loadVersion, reload];
}

export interface ViewAction {
  /** True while `act` is in flight; disables the controls that started it. */
  readonly pending: boolean;
  /** The success sentence of the last completed action, for the toast. */
  readonly notice: string | null;
  /** The failure sentence of the last action, rendered inline and left on
   * screen until the operator fixes the input (`docs/UX.md`). */
  readonly actionError: string | null;
  /** Runs one mutation with the pending/notice/error bookkeeping around
   * it, announcing `done` when it resolves. Never rejects.
   *
   * `done` may be null for an action whose SUCCESS is already visible —
   * opening a record, loading another page — where a toast would be
   * narrating what the reader is looking at. Passing `''` for that is
   * what a caller reaches for first and it renders an empty notice box,
   * which is worse than either. */
  readonly act: (work: () => Promise<void>, done: string | null) => Promise<void>;
  readonly setPending: (pending: boolean) => void;
  readonly setNotice: (notice: string | null) => void;
  readonly setActionError: (actionError: string | null) => void;
}

/**
 * The pending/notice/error trio a view keeps around its mutations, and the
 * one wrapper that drives them.
 *
 * Every action handler wants the same four things — block the controls,
 * clear the last outcome, announce this one, and put the pending flag back
 * whichever way it goes — and the `finally` is the part that matters: an
 * action that throws without it leaves the screen disabled with nothing
 * said. `fallback` is the sentence for a failure that carries none of its
 * own; see `errorMessage`.
 *
 * Views whose action does more than this — refreshing a list, keeping a
 * loaded record in step, carrying wayfinding alongside the message — keep
 * their own handler rather than bending this one.
 */
export function useAction(fallback?: string): ViewAction {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    async (work: () => Promise<void>, done: string | null) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
      } catch (cause) {
        setActionError(errorMessage(cause, fallback));
      } finally {
        setPending(false);
      }
    },
    [fallback],
  );

  return { pending, notice, actionError, act, setPending, setNotice, setActionError };
}
