import { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { formatTimestamp } from '../format-instant.js';
import { clearCachedReadNotice, useCachedReadAt, useOnline } from '../lib/offline.js';

/**
 * What the workspace says while there is no connection.
 *
 * The mock has no offline state to replicate (`docs/UX.md` § 23), so this
 * is built from what the mock already draws: the warning-tinted panel its
 * own alerts use — `rounded-lg border border-warning/30 bg-warning/15`,
 * 14px ink, the icon nudged to the first line's baseline — which is the
 * same anatomy `ui/state.tsx`'s `ErrorState` uses in the destructive ink.
 *
 * Warning rather than destructive, deliberately. `docs/DESIGN.md`
 * § Status badge semantics keeps the destructive family for
 * cancelled/rejected/declined; a lost signal is a thing to do something
 * about, not a record that failed.
 *
 * `role="status"` rather than `role="alert"` for the same reason: this is
 * a condition the operator lives with for a while, announced politely
 * once, not an interruption. The refusal of an individual write IS an
 * alert, and it is rendered by whichever screen the operator pressed
 * Save on, through the inline error that screen already had.
 */
export function OfflineBanner() {
  const online = useOnline();
  const cachedAt = useCachedReadAt();

  useEffect(() => {
    // Once the connection is back every screen reads live again, so the
    // "saved at" sentence would be describing data that has been
    // replaced. Forgotten here rather than on navigation, because a read
    // that is still in flight when the operator moves would otherwise
    // clear a notice it is about to set again.
    if (online) clearCachedReadNotice();
  }, [online]);

  if (online) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/15 p-3 text-sm text-warning-foreground"
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="m-0">
        <span className="font-medium">This device is offline.</span>{' '}
        {cachedAt === null ? (
          'Records already open stay readable. Nothing can be created, changed or issued until the connection returns.'
        ) : (
          <>
            Records on this screen were read at{' '}
            <span className="font-mono tabular-nums">{formatTimestamp(cachedAt)}</span>{' '}
            and may have changed since. Nothing can be created, changed or issued until
            the connection returns.
          </>
        )}
      </p>
    </div>
  );
}
