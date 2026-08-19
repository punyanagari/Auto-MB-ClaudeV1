import { useCallback, useMemo, useState } from 'react';
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

export interface Reveal {
  /** Name the record a just-finished mutation wrote. Safe to call before
   * the list holding it has reloaded. `null` cancels a pending reveal. */
  readonly reveal: (id: string | null) => void;
  /** Spread onto the element that IS that record — a `<tr>`, a panel, a
   * list item. Every other row gets an empty object, so a register pays
   * one allocation per row and carries no extra DOM. */
  readonly revealProps: (id: string) => {
    readonly ref?: (node: HTMLElement | null) => void;
  };
}

/**
 * Show the operator the row they just wrote.
 *
 * A create form sits above the register it adds to, so on any list longer
 * than a screen the new row lands below the fold: the toast says the save
 * worked and the page looks exactly as it did. This scrolls the record
 * into view and flashes it, which is the spatial half of the same
 * confirmation — the toast stays, it says what happened, and this says
 * where.
 *
 * The reveal is asked for at the moment the mutation resolves, which is
 * BEFORE the reload that renders the row. That is why the target is
 * reached through a ref rather than a query: the callback runs when the
 * row mounts, however long the reload takes. A row that never arrives —
 * filtered out, retired out of the current view, on another Work — simply
 * never calls it, and nothing has to detect that case.
 *
 * The ref identity is bound to a nonce rather than to the id, so revealing
 * the same row twice (two edits to one contact) is two reveals: React runs
 * a ref again only when the function it was given changes.
 *
 * Motion: `scrollIntoView` is asked for smoothly only when the viewer has
 * not asked for less of it. `prefers-reduced-motion: reduce` puts a global
 * `scroll-behavior: auto !important` on the document in `globals.css`, but
 * an explicit `behavior: 'smooth'` argument outranks that CSS property, so
 * the query has to be read here as well. The highlight is CSS
 * (`@keyframes reveal-flash`) and the same global block already cuts it to
 * nothing.
 *
 * The highlight attribute is set by this callback and removed when the
 * animation ends, rather than being React state: the flash has no state
 * worth keeping — it is over in 1.6s and nothing depends on whether it is
 * still running — and a CSS animation does not replay when an attribute
 * that is already present is set again, which would have silently dropped
 * the flash on the second edit of one row.
 */
export function useReveal(): Reveal {
  const [nonce, setNonce] = useState(0);
  const [id, setId] = useState<string | null>(null);

  /* `useMemo` rather than `useCallback`, because the dependency is not a
   * value this body reads: `nonce` exists to change the function's
   * identity, and a callback that closed over nothing would be the same
   * function forever and would run once per row for all time. */
  const attach = useMemo(
    () =>
      (node: HTMLElement | null): void => {
        if (node === null) return;
        const still =
          typeof matchMedia === 'function' &&
          matchMedia('(prefers-reduced-motion: reduce)').matches;
        /* Optional call because jsdom has no layout and therefore no
         * `scrollIntoView`; the component tests render these very rows. */
        node.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
        node.addEventListener(
          'animationend',
          () => {
            node.removeAttribute('data-revealed');
          },
          { once: true },
        );
        node.setAttribute('data-revealed', '');
      },
    [nonce],
  );

  return {
    reveal: (next) => {
      setId(next);
      setNonce((current) => current + 1);
    },
    revealProps: (row) => (id === row ? { ref: attach } : {}),
  };
}
