import { useEffect, useState } from 'react';
import type { MeasurementBook, RailwayMeasurement } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Field, Hint } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable } from '../ui/table.js';
import { formatTimestampDate } from '../format.js';

/**
 * The railway's own measurement, and whether it agrees with ours.
 *
 * `RailwayBillPanel` beside this one is the END of the settlement chain —
 * the document that says the railway agreed and how much it owes. This is
 * the step before it: IWRCMS raises that bill from a MEASUREMENT its own
 * system holds, and until that measurement is on record here and agrees
 * with this finalized Measurement Book, the bill has nothing to settle.
 *
 * The operator supplies a file and nothing else. The quantities, the
 * remarks and the verdict are read on the server, so there is no field
 * here for anyone to type them into.
 *
 * ## The three shapes this panel takes
 *
 * MATCHED — one line of prose and the per-line table folded away behind
 * nothing, because a document that agrees needs no reading.
 *
 * MISMATCHED — the per-line table with the differing lines named. This is
 * a conversation with the railway, not a button: nothing here confirms
 * past a mismatch, and the server refuses it twice if anything tries.
 *
 * UNREADABLE — the Measurement Book's own lines with a Confirm control on
 * each. Every line has to be confirmed by a named member against the
 * document in front of them before a bill may be recorded. It is more
 * work than reading a verdict, deliberately: it is the exit for a scanned
 * measurement, not a way past one that disagrees.
 *
 * THE MOCK DRAWS NO SETTLEMENT SCREEN, so this is application-first under
 * `AGENTS.md` § Design contract 2 and 4, built in the grammar the sibling
 * `RailwayBillPanel` already established — the same `.data-surface`
 * wrapper, the same `DataTable`, the same dot-plus-label status chip, the
 * same file `Field` and `Hint`. No new visual language. `docs/UX.md` § 24
 * records the stance.
 */

interface RailwayMeasurementPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly book: MeasurementBook;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** Lets the bill panel beside this one re-read once the gate opens. */
  readonly onChanged: () => void;
}

/* Local tones, named here rather than added to `ui/chip.tsx`'s shared map,
   for the reason that map states: `matched` and `unreadable` are words of
   this panel's own vocabulary and mean nothing on the other registers. */
const STATUS_TONE = {
  matched: 'success',
  mismatched: 'destructive',
  unreadable: 'warning',
} as const;

const STATUS_LABEL = {
  matched: 'Matched',
  mismatched: 'Does not match',
  unreadable: 'Could not be read',
} as const;

export function RailwayMeasurementPanel({
  api,
  organisationId,
  book,
  canIssue,
  canCancel,
  onChanged,
}: RailwayMeasurementPanelProps) {
  const [measurement, setMeasurement] = useState<RailwayMeasurement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, refresh] = useReload();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    api
      .getRailwayMeasurement(organisationId, book.id)
      .then((loadedMeasurement) => {
        if (cancelled) return;
        setMeasurement(loadedMeasurement);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'The railway measurement for this Measurement Book could not be read.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, book.id, loadVersion]);

  async function act(work: () => Promise<void>, success: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      refresh();
      onChanged();
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error ? cause.message : 'The action could not be completed.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <ErrorState onRetry={refresh} retryLabel="Retry railway measurement">
        {loadError}
      </ErrorState>
    );
  }
  if (!loaded) {
    return <LoadingState label="the railway measurement for this book" rows={2} />;
  }

  const outstanding =
    measurement === null
      ? []
      : measurement.lines.filter((line) => line.confirmedAt === null);

  return (
    <section className="data-surface mt-4 flex flex-col gap-3 p-4">
      <h4 className="m-0 text-sm font-medium">Railway measurement</h4>

      {measurement === null ? (
        <EmptyState>
          The railway&apos;s measurement for this book is not on record. Its On-Account
          Bill is raised from that measurement and cannot be recorded before it.
        </EmptyState>
      ) : (
        <>
          <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
            <StatusChip
              status={measurement.matchStatus}
              tone={STATUS_TONE[measurement.matchStatus]}
            >
              {STATUS_LABEL[measurement.matchStatus]}
            </StatusChip>
            <span className="text-muted-foreground">
              {measurement.originalFilename}, recorded{' '}
              <span className="tabular-nums">
                {formatTimestampDate(measurement.createdAt)}
              </span>
            </span>
          </p>

          {measurement.matchStatus === 'matched' && (
            <p className="m-0 text-sm text-muted-foreground">
              Every line of this Measurement Book reads the same on the railway&apos;s
              measurement. Its On-Account Bill can be recorded.
            </p>
          )}

          {measurement.matchStatus === 'mismatched' && (
            <p className="m-0 text-sm text-muted-foreground">
              The railway&apos;s measurement disagrees with this Measurement Book on the
              lines below. Settle the difference with the railway and upload the
              corrected measurement; a difference is not something this screen can
              confirm past.
            </p>
          )}

          {measurement.matchStatus === 'unreadable' && (
            <p className="m-0 text-sm text-muted-foreground">
              The measurement&apos;s text could not be read, so nothing was compared.
              Confirm each line against the document itself; the confirmation is
              recorded against your name.{' '}
              {outstanding.length > 0
                ? `${String(outstanding.length)} of ${String(measurement.lines.length)} still to confirm.`
                : 'All lines are confirmed; its On-Account Bill can be recorded.'}
            </p>
          )}

          <DataTable>
            <caption className="sr-only">
              Each line of this Measurement Book against the railway&apos;s measurement
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Reading</th>
                {measurement.matchStatus === 'unreadable' && (
                  <th scope="col">Confirmed</th>
                )}
              </tr>
            </thead>
            <tbody>
              {measurement.lines.map((line) => (
                <tr key={line.itemNumber}>
                  <td className="tabular-nums">{line.itemNumber}</td>
                  <td>
                    {measurement.matchStatus === 'unreadable'
                      ? 'Not read'
                      : (line.detail ?? 'Matches this Measurement Book.')}
                  </td>
                  {measurement.matchStatus === 'unreadable' && (
                    <td>
                      {line.confirmedAt !== null ? (
                        <span className="text-muted-foreground tabular-nums">
                          {formatTimestampDate(line.confirmedAt)}
                        </span>
                      ) : canIssue ? (
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            void act(async () => {
                              setMeasurement(
                                await api.confirmRailwayMeasurementLine(
                                  organisationId,
                                  measurement.id,
                                  line.itemNumber,
                                ),
                              );
                            }, `Item ${line.itemNumber} confirmed against the railway's measurement.`);
                          }}
                        >
                          Confirm item {line.itemNumber}
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">Not confirmed</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      {actionError !== null && (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {actionError}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="m-0 text-sm text-success">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {measurement === null && canIssue && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const input = form.elements.namedItem('railwayMeasurement');
              const file =
                input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
              if (file === null) return;
              void act(async () => {
                setMeasurement(
                  await api.uploadRailwayMeasurement(
                    organisationId,
                    book.id,
                    file,
                    file.name,
                  ),
                );
                form.reset();
              }, 'Railway measurement recorded and read against this Measurement Book.');
            }}
          >
            <Field className="max-w-none">
              <label htmlFor={`railway-measurement-${book.id}`}>
                Railway measurement PDF
              </label>
              <input
                id={`railway-measurement-${book.id}`}
                name="railwayMeasurement"
                type="file"
                accept="application/pdf,.pdf"
                required
                disabled={pending}
              />
              <Hint>
                The IWRCMS measurement as downloaded. Its quantities and remarks are
                compared with this book&apos;s, line by line, on the server.
              </Hint>
            </Field>
            <Button type="submit" disabled={pending}>
              Record railway measurement
            </Button>
          </form>
        )}

        {measurement !== null && canCancel && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              void act(async () => {
                setMeasurement(
                  await api.discardRailwayMeasurement(organisationId, measurement.id),
                );
              }, 'Railway measurement discarded; another can be recorded against this book.');
            }}
          >
            Discard this measurement
          </Button>
        )}
      </div>
    </section>
  );
}
