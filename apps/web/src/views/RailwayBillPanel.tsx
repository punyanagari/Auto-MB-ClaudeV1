import { useCallback, useEffect, useState } from 'react';
import type { MeasurementBook, ReceivedRailwayBill } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Field, Hint } from '../ui/form.js';
import { SignaturePanel } from '../ui/signature-panel.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { formatDate, formatInr, formatTimestampDate } from '../format.js';

/**
 * The railway's answer to a measurement.
 *
 * Everything else on this screen is the agency's own paperwork. This
 * panel is the one place the other side of the contract speaks: the
 * On-Account Bill IWRCMS raises from a finalized Measurement Book, signed
 * by the contractor, the engineer's representative and the Sr. DSTE.
 *
 * The operator supplies a file and nothing else. The bill number, its
 * date, its amount and the measurement it settles are read from the PDF
 * on the server, so there is no field here for anyone to type them into —
 * a bill number somebody typed is a claim, and one found in the bill's
 * own text is a fact.
 */

interface RailwayBillPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly book: MeasurementBook;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** Re-reads the book after a closure, so the rest of the screen agrees. */
  readonly onClosed: () => Promise<void>;
}

export function RailwayBillPanel({
  api,
  organisationId,
  workId,
  book,
  canIssue,
  canCancel,
  onClosed,
}: RailwayBillPanelProps) {
  const [bills, setBills] = useState<readonly ReceivedRailwayBill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBills(null);
    setLoadError(null);
    api
      .listReceivedRailwayBills(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setBills(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'The railway bills for this Work could not be read.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const refresh = useCallback(() => {
    setLoadVersion((version) => version + 1);
  }, []);

  async function act(work: () => Promise<void>, success: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      refresh();
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
      <ErrorState onRetry={refresh} retryLabel="Retry railway bills">
        {loadError}
      </ErrorState>
    );
  }
  if (bills === null) {
    return <LoadingState label="the railway bill for this measurement" rows={2} />;
  }

  const live = bills.find(
    (candidate) =>
      candidate.measurementBookId === book.id && candidate.discardedAt === null,
  );

  return (
    /* The mock's panel wrapper, not a second hand-rolled copy of it:
       `.data-surface` is the card treatment every register and detail
       surface shares (docs/DESIGN.md § Component-layer conventions, ported
       from the mock at a8e1fde), which is what stops this panel reading as
       a plain outlined box beside the Measurement Book it belongs to. */
    <section className="data-surface mt-4 flex flex-col gap-3 p-4">
      <h4 className="m-0 text-sm font-medium">Railway bill</h4>

      {book.closedAt !== null && (
        <p className="m-0 text-sm text-muted-foreground">
          The railway settled this measurement on{' '}
          <span className="tabular-nums">{formatTimestampDate(book.closedAt)}</span>.
        </p>
      )}

      {live === undefined ? (
        <EmptyState>
          No railway bill is recorded against this measurement, so it is still
          outstanding with the railway.
        </EmptyState>
      ) : (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Bill</dt>
            <dd className="m-0 tabular-nums">{live.billNumber}</dd>
            <dt className="text-muted-foreground">Dated</dt>
            <dd className="m-0 tabular-nums">{formatDate(live.billDate)}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="m-0 tabular-nums">
              {formatInr(live.billAmount)}
              {live.rateInclusiveOfGst ? ' (including GST)' : ' (excluding GST)'}
            </dd>
            <dt className="text-muted-foreground">Measurement</dt>
            <dd className="m-0 tabular-nums">{live.measurementNumber}</dd>
          </dl>
          <SignaturePanel
            status={live.signatureStatus}
            verdict={live.signatureVerdict}
          />
          {!live.settleable && live.settlementRefusalDetail !== null && (
            <p className="m-0 text-sm text-muted-foreground">
              {live.settlementRefusalDetail} This measurement cannot be closed, and its
              bill cannot be recorded as paid, until the railway supplies a bill that
              verifies.
            </p>
          )}
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
        {live === undefined && canIssue && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const input = form.elements.namedItem('railwayBill');
              const file =
                input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
              if (file === null) return;
              void act(async () => {
                await api.uploadReceivedRailwayBill(
                  organisationId,
                  book.id,
                  file,
                  file.name,
                );
                form.reset();
              }, 'Railway bill recorded against this measurement.');
            }}
          >
            <Field className="max-w-none">
              <label htmlFor={`railway-bill-${book.id}`}>On-Account Bill PDF</label>
              <input
                id={`railway-bill-${book.id}`}
                name="railwayBill"
                type="file"
                accept="application/pdf,.pdf"
                required
                disabled={pending}
              />
              <Hint>
                The IWRCMS bill as downloaded. Its number, date, amount and measurement
                are read from the document itself.
              </Hint>
            </Field>
            <Button type="submit" disabled={pending}>
              Record railway bill
            </Button>
          </form>
        )}

        {live !== undefined && book.closedAt === null && canIssue && (
          <Button
            disabled={pending || !live.settleable}
            onClick={() => {
              void act(async () => {
                await api.closeMeasurementBook(organisationId, book.id);
                await onClosed();
              }, 'Measurement closed against the railway bill.');
            }}
          >
            Close measurement
          </Button>
        )}

        {live !== undefined && book.closedAt === null && canCancel && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              void act(async () => {
                await api.discardReceivedRailwayBill(organisationId, live.id);
              }, 'Railway bill discarded; another can be recorded against this measurement.');
            }}
          >
            Discard this bill
          </Button>
        )}
      </div>
    </section>
  );
}
