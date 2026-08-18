import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import type {
  MaintenanceDetailResponse,
  MaintenanceLine,
  MaintenanceStatus,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, todayISO } from '../format.js';
import { cn } from '../lib/cn.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FieldRow, FormError } from '../ui/form.js';
import { ProgressBar } from '../ui/progress.js';
import { Stat } from '../ui/stat.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell } from '../ui/table.js';
import { maintenanceChipKey } from './Maintenance.js';

/**
 * One maintenance job card, in the mock's four tabs.
 *
 * Replicates `app/maintenance/[id]/page.tsx` and
 * `components/maintenance-job-card.tsx` of the frozen mock at `fdfd610`:
 * the back link over the request number, the approve action on the
 * right, three metric cards with progress bars, the Materials / Dispatch
 * / Defective returns / History tab rail, and the closure-gate card
 * under all of it.
 *
 * What the mock cannot express, each recorded in `docs/UX.md` § 14:
 *
 *   * **Reserved, dispatched and received-back are DERIVED.** The mock
 *     stores all three and writes only the first, once, at approval —
 *     so a fully dispatched line still reads as holding stock. Here they
 *     come off the challans and the receipts that are their evidence.
 *   * **Available is the real shelf.** The mock's fixture computes it as
 *     `max(quantity, 2)`; this reads `stock_on_hand` (migration 0087) at
 *     the moment the screen asks, and shows nothing for a custom line
 *     that names no part.
 *   * **A line can be written off.** The mock's closure gate reads
 *     `dispatched + cancelled >= quantity` and nothing in it ever writes
 *     `cancelled`, so a request whose stock never arrives can never
 *     close. The Materials tab carries the write-off the gate needs.
 */

type Tab = 'materials' | 'dispatch' | 'returns' | 'history';

const STATUS_LABELS: Readonly<Record<MaintenanceStatus, string>> = {
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  partially_dispatched: 'Dispatching',
  closed: 'Closed',
};

function sum(lines: readonly MaintenanceLine[], of: (line: MaintenanceLine) => string) {
  return lines.reduce((total, line) => total + Number(of(line)), 0);
}

function percent(value: number, total: number): number {
  return total === 0 ? 100 : (value / total) * 100;
}

interface MaintenanceJobCardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly requestId: string;
  /** Dispatching, receiving defects, writing a line off and closing are
   * store work, exactly as the server gates them. */
  readonly canModify: boolean;
  /** The mock's "whole-request admin approval" — owner only. */
  readonly canApprove: boolean;
  /** Recording a dispatch mints a numbered challan, so it carries the
   * same issue authority every other numbered document does. */
  readonly canIssue: boolean;
  readonly onBack: () => void;
}

export function MaintenanceJobCard({
  api,
  organisationId,
  requestId,
  canModify,
  canApprove,
  canIssue,
  onBack,
}: MaintenanceJobCardProps) {
  const [detail, setDetail] = useState<MaintenanceDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('materials');
  const [pending, setPending] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    api
      .getMaintenanceRequest(organisationId, requestId)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The maintenance request could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, requestId, loadVersion]);

  /** Every mutation answers with the whole request, so one helper drives
   * all of them: the screen never patches a fragment of state the server
   * might disagree with — and every quantity on it is derived. */
  const run = useCallback(
    (action: () => Promise<MaintenanceDetailResponse>, failure: string) => {
      setActionError(null);
      setPending(true);
      action()
        .then((updated) => {
          setDetail(updated);
        })
        .catch((cause: unknown) => {
          setActionError(cause instanceof RequestFailedError ? cause.message : failure);
        })
        .finally(() => {
          setPending(false);
        });
    },
    [],
  );

  if (loadError !== null) {
    return (
      <ErrorState
        onRetry={() => {
          setLoadVersion((current) => current + 1);
        }}
        retryLabel="Retry the maintenance request"
      >
        {loadError}
      </ErrorState>
    );
  }

  if (detail === null) {
    return <LoadingState label="the maintenance request" rows={4} columns={3} />;
  }

  const { request, lines, dispatches, returns } = detail;
  const resolved = lines.filter((line) => line.resolved).length;
  const dispatched = sum(lines, (line) => line.dispatchedQuantity);
  const ordered = sum(lines, (line) => line.quantity);
  const received = sum(lines, (line) => line.receivedReturnQuantity);
  const expected = sum(lines, (line) => line.expectedReturnQuantity);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Maintenance
          </Button>
          <p className="m-0 mt-3 font-mono text-xs tabular-nums text-muted-foreground">
            {request.requestNumber} · {request.workCode} · {request.station}
          </p>
          <h1
            className="mt-1 text-2xl font-semibold text-balance"
            id="maintenance-request-title"
            tabIndex={-1}
          >
            {request.faultSummary}
          </h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            Requested by {request.requesterName}
            {request.requesterPhone === null ? '' : ` · ${request.requesterPhone}`}
            {request.requiredBy === null
              ? ''
              : ` · required by ${formatDate(request.requiredBy)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm capitalize text-muted-foreground">
            {request.priority}
          </span>
          <StatusChip status={maintenanceChipKey(request.status)}>
            {STATUS_LABELS[request.status]}
          </StatusChip>
        </div>
      </div>

      {request.status === 'awaiting_approval' && canApprove && (
        <ApprovalCard
          pending={pending}
          onApprove={(comment) => {
            run(
              () =>
                api.approveMaintenanceRequest(organisationId, requestId, { comment }),
              'The request could not be approved.',
            );
          }}
        />
      )}

      {request.operationalImpact !== null && (
        <Card className="mb-4">
          <p className="m-0 text-sm">
            <span className="font-medium">Operational impact.</span>{' '}
            {request.operationalImpact}
          </p>
        </Card>
      )}

      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <Card>
          <Stat
            label="Material lines resolved"
            value={`${String(resolved)} / ${String(lines.length)}`}
          />
          <ProgressBar
            className="mt-3"
            value={percent(resolved, lines.length)}
            label="Material lines resolved"
          />
        </Card>
        <Card>
          <Stat
            label="Quantity dispatched"
            value={`${String(dispatched)} / ${String(ordered)}`}
          />
          <ProgressBar
            className="mt-3"
            value={percent(dispatched, ordered)}
            label="Quantity dispatched"
          />
        </Card>
        <Card>
          <Stat
            label="Defects received"
            value={`${String(received)} / ${String(expected)}`}
          />
          <ProgressBar
            className="mt-3"
            value={percent(received, expected)}
            label="Defects received"
          />
        </Card>
      </div>

      {/* The mock's boxed tab list. Four panels swapped in place, so it is
          a `role="group"` of `aria-pressed` toggles rather than a
          `role="tablist"` this build would then owe the roving-tabindex
          pattern (`test/a11y-invariants`). */}
      <div
        className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
        role="group"
        aria-label="Maintenance request sections"
      >
        {(
          [
            ['materials', 'Materials'],
            ['dispatch', 'Dispatch'],
            ['returns', 'Defective returns'],
            ['history', 'History'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            className={cn(
              'h-8 rounded-md px-3 text-sm font-medium transition-colors',
              tab === key
                ? 'bg-card text-foreground shadow-[0_1px_2px_0_rgb(15_23_42/0.05)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => {
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {actionError !== null && <FormError>{actionError}</FormError>}

      <div className="mt-4">
        {tab === 'materials' && (
          <MaterialsTab
            lines={lines}
            editable={canModify && request.status !== 'closed'}
            pending={pending}
            onWriteOff={(lineId, quantity, reason) => {
              run(
                () =>
                  api.cancelMaintenanceLine(organisationId, requestId, lineId, {
                    quantity,
                    reason,
                  }),
                'The line could not be written off.',
              );
            }}
          />
        )}
        {tab === 'dispatch' && (
          <DispatchTab
            lines={lines}
            enabled={
              canIssue &&
              (request.status === 'approved' ||
                request.status === 'partially_dispatched')
            }
            status={request.status}
            deliveryInstructions={request.deliveryInstructions}
            pending={pending}
            onDispatch={(body) => {
              run(
                () => api.recordMaintenanceDispatch(organisationId, requestId, body),
                'The dispatch could not be recorded.',
              );
            }}
          />
        )}
        {tab === 'returns' && (
          <ReturnsTab
            lines={lines}
            enabled={
              canModify &&
              request.status !== 'awaiting_approval' &&
              request.status !== 'closed'
            }
            pending={pending}
            onReceive={(body) => {
              run(
                () => api.receiveMaintenanceReturn(organisationId, requestId, body),
                'The defective return could not be recorded.',
              );
            }}
          />
        )}
        {tab === 'history' && (
          <HistoryTab
            requesterName={request.requesterName}
            approvalComment={request.approvalComment}
            dispatches={dispatches}
            returns={returns}
          />
        )}
      </div>

      <Card className="mt-5">
        <CardHeader>
          <h2 className="text-base font-semibold">Closure gate</h2>
          <p className="m-0 text-sm text-muted-foreground">
            {detail.canClose
              ? 'Every material line and defective return is resolved.'
              : 'Closure remains blocked until approved quantities are dispatched or written off and all expected defects are received.'}
          </p>
        </CardHeader>
        <Actions>
          <Button
            disabled={
              !detail.canClose || request.status === 'closed' || pending || !canModify
            }
            onClick={() => {
              run(
                () => api.closeMaintenanceRequest(organisationId, requestId),
                'The request could not be closed.',
              );
            }}
          >
            <CheckCircle2 data-icon="inline-start" aria-hidden="true" />
            {request.status === 'closed' ? 'Job closed' : 'Close maintenance job'}
          </Button>
        </Actions>
      </Card>
    </>
  );
}

function ApprovalCard({
  pending,
  onApprove,
}: {
  readonly pending: boolean;
  readonly onApprove: (comment: string) => void;
}) {
  const [comment, setComment] = useState(
    'Approved for issue against available maintenance stock',
  );
  return (
    <Card className="mb-4">
      <CardHeader>
        <h2 className="text-base font-semibold">Admin approval</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Approving commits the store to this request. The comment is written once and
          stays on the record.
        </p>
      </CardHeader>
      <Field>
        <label htmlFor="maintenance-approval-comment">Approval comment</label>
        <input
          id="maintenance-approval-comment"
          maxLength={1000}
          value={comment}
          onChange={(event) => {
            setComment(event.currentTarget.value);
          }}
        />
      </Field>
      <Actions>
        <Button
          disabled={pending || comment.trim().length < 3}
          onClick={() => {
            onApprove(comment.trim());
          }}
        >
          <ShieldCheck data-icon="inline-start" aria-hidden="true" />
          Approve request
        </Button>
      </Actions>
    </Card>
  );
}

function MaterialsTab({
  lines,
  editable,
  pending,
  onWriteOff,
}: {
  readonly lines: readonly MaintenanceLine[];
  readonly editable: boolean;
  readonly pending: boolean;
  readonly onWriteOff: (lineId: string, quantity: string, reason: string) => void;
}) {
  const [writingOff, setWritingOff] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Request and stock reservation</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Reserved is what the line still owes the site; available is what is on the
          shelf right now. Shortages stay visible rather than blocking approval.
        </p>
      </CardHeader>
      <DataTable>
        <caption className="sr-only">Requested materials</caption>
        <thead>
          <tr>
            <th scope="col">Material</th>
            <th className={numericCell} scope="col">
              Asked
            </th>
            <th className={cn(numericCell, 'hidden sm:table-cell')} scope="col">
              Reserved
            </th>
            <th className={numericCell} scope="col">
              Dispatched
            </th>
            <th className={cn(numericCell, 'hidden md:table-cell')} scope="col">
              Returns
            </th>
            <th className={cn(numericCell, 'hidden lg:table-cell')} scope="col">
              Available
            </th>
            {editable && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <td>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{line.description}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {line.itemCode ?? 'Custom item'} · {line.unit}
                    {line.purpose === null ? '' : ` · ${line.purpose}`}
                  </span>
                  {Number(line.cancelledQuantity) > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Written off {line.cancelledQuantity} — {line.cancellationReason}
                    </span>
                  )}
                </div>
              </td>
              <td className={numericCell}>{line.quantity}</td>
              <td className={cn(numericCell, 'hidden sm:table-cell')}>
                {line.outstandingQuantity}
              </td>
              <td className={numericCell}>{line.dispatchedQuantity}</td>
              <td className={cn(numericCell, 'hidden md:table-cell')}>
                {line.receivedReturnQuantity}/{line.expectedReturnQuantity}
              </td>
              <td className={cn(numericCell, 'hidden lg:table-cell')}>
                {line.onHand ?? '—'}
              </td>
              {editable && (
                <td>
                  {line.resolved || Number(line.cancelledQuantity) > 0 ? (
                    <span className="text-xs text-muted-foreground">Settled</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReason('');
                        setWritingOff(writingOff === line.id ? null : line.id);
                      }}
                    >
                      Write off
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>

      {writingOff !== null && (
        <div className="mt-4 rounded-lg bg-muted/40 p-3">
          <FieldRow>
            <Field>
              <label htmlFor="maintenance-writeoff-reason">
                Why is the balance not being sent?
              </label>
              <input
                id="maintenance-writeoff-reason"
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            </Field>
          </FieldRow>
          <Actions>
            <Button
              variant="ghost"
              onClick={() => {
                setWritingOff(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || reason.trim().length < 3}
              onClick={() => {
                const line = lines.find((candidate) => candidate.id === writingOff);
                if (line === undefined) return;
                onWriteOff(line.id, line.outstandingQuantity, reason.trim());
                setWritingOff(null);
              }}
            >
              Write off the balance
            </Button>
          </Actions>
        </div>
      )}
    </Card>
  );
}

function DispatchTab({
  lines,
  enabled,
  status,
  deliveryInstructions,
  pending,
  onDispatch,
}: {
  readonly lines: readonly MaintenanceLine[];
  readonly enabled: boolean;
  readonly status: MaintenanceStatus;
  readonly deliveryInstructions: string | null;
  readonly pending: boolean;
  readonly onDispatch: (body: {
    dispatchDate: string;
    stockLocation: string;
    receiverName: string;
    transporter?: string;
    notes?: string;
    lines: { lineId: string; quantity: string }[];
  }) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [dispatchDate, setDispatchDate] = useState(todayISO());
  const [stockLocation, setStockLocation] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [transporter, setTransporter] = useState('');
  const [notes, setNotes] = useState('');

  const chosen = lines
    .filter((line) => Number(quantities[line.id] ?? '0') > 0)
    .map((line) => ({ lineId: line.id, quantity: quantities[line.id] ?? '0' }));
  const ready =
    enabled &&
    chosen.length > 0 &&
    stockLocation.trim().length >= 2 &&
    receiverName.trim().length >= 2;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Record partial or full dispatch</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Each dispatch creates a numbered maintenance challan and issues the material
          from the stock ledger. Lines with no catalogue part move no stock.
        </p>
      </CardHeader>

      {!enabled && (
        <p className="alert error" role="alert">
          {status === 'awaiting_approval'
            ? 'This request must be approved before material leaves the store.'
            : status === 'closed'
              ? 'This request is closed.'
              : 'You do not hold the authority to issue documents.'}
        </p>
      )}

      {deliveryInstructions !== null && (
        <p className="m-0 mb-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Delivery instructions.</span>{' '}
          {deliveryInstructions}
        </p>
      )}

      <DataTable>
        <caption className="sr-only">Quantities to dispatch</caption>
        <thead>
          <tr>
            <th scope="col">Material</th>
            <th className={numericCell} scope="col">
              Left to dispatch
            </th>
            <th className={numericCell} scope="col">
              This challan
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <td>
                <span className="text-sm">{line.description}</span>
                <span className="block font-mono text-xs tabular-nums text-muted-foreground">
                  {line.itemCode ?? 'Custom item'}
                </span>
              </td>
              <td className={numericCell}>
                {line.outstandingQuantity} {line.unit}
              </td>
              <td className={numericCell}>
                <label className="sr-only" htmlFor={`dispatch-${line.id}`}>
                  Quantity of {line.description} on this challan
                </label>
                <input
                  id={`dispatch-${line.id}`}
                  className="w-24 text-right"
                  type="number"
                  min="0"
                  step="0.001"
                  max={line.outstandingQuantity}
                  disabled={!enabled || Number(line.outstandingQuantity) <= 0}
                  value={quantities[line.id] ?? ''}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setQuantities((current) => ({ ...current, [line.id]: next }));
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <FieldRow className="mt-4">
        <Field>
          <label htmlFor="dispatch-date">Dispatch date</label>
          <input
            id="dispatch-date"
            type="date"
            max={todayISO()}
            value={dispatchDate}
            disabled={!enabled}
            onChange={(event) => {
              setDispatchDate(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="dispatch-location">Stock location</label>
          <input
            id="dispatch-location"
            maxLength={200}
            placeholder="Central store"
            value={stockLocation}
            disabled={!enabled}
            onChange={(event) => {
              setStockLocation(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="dispatch-receiver">Site receiver</label>
          <input
            id="dispatch-receiver"
            maxLength={200}
            value={receiverName}
            disabled={!enabled}
            onChange={(event) => {
              setReceiverName(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="dispatch-transporter">Vehicle / transporter</label>
          <input
            id="dispatch-transporter"
            maxLength={200}
            value={transporter}
            disabled={!enabled}
            onChange={(event) => {
              setTransporter(event.currentTarget.value);
            }}
          />
        </Field>
      </FieldRow>
      <Field>
        <label htmlFor="dispatch-notes">Dispatch and handover notes</label>
        <textarea
          id="dispatch-notes"
          rows={2}
          maxLength={2000}
          value={notes}
          disabled={!enabled}
          onChange={(event) => {
            setNotes(event.currentTarget.value);
          }}
        />
      </Field>
      <Actions>
        <Button
          disabled={!ready || pending}
          onClick={() => {
            onDispatch({
              dispatchDate,
              stockLocation: stockLocation.trim(),
              receiverName: receiverName.trim(),
              ...(transporter.trim() === '' ? {} : { transporter: transporter.trim() }),
              ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
              lines: chosen,
            });
            setQuantities({});
          }}
        >
          <Truck data-icon="inline-start" aria-hidden="true" />
          Create dispatch &amp; challan
        </Button>
      </Actions>
    </Card>
  );
}

function ReturnsTab({
  lines,
  enabled,
  pending,
  onReceive,
}: {
  readonly lines: readonly MaintenanceLine[];
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly onReceive: (body: {
    lineId: string;
    quantity: string;
    receivedOn: string;
    serials?: string[];
    conditionNote: string;
    repairDisposition: string;
    receivedBy: string;
    notes?: string;
  }) => void;
}) {
  const due = lines.filter((line) => Number(line.returnDueQuantity) > 0);
  const [lineId, setLineId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [receivedOn, setReceivedOn] = useState(todayISO());
  const [serials, setSerials] = useState('');
  const [conditionNote, setConditionNote] = useState('');
  const [repairDisposition, setRepairDisposition] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [notes, setNotes] = useState('');

  const ready =
    enabled &&
    lineId !== '' &&
    Number(quantity) > 0 &&
    conditionNote.trim().length >= 2 &&
    repairDisposition.trim().length >= 2 &&
    receivedBy.trim().length >= 2;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Receive defective items</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Record office receipt, serials, condition and repair disposition against the
          material line. A unit received for repair is not returned to stock.
        </p>
      </CardHeader>

      {due.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No material line on this request still owes a defective unit back.
        </p>
      ) : (
        <>
          <FieldRow>
            <Field>
              <label htmlFor="return-line">Material line</label>
              <select
                id="return-line"
                value={lineId}
                disabled={!enabled}
                onChange={(event) => {
                  setLineId(event.currentTarget.value);
                }}
              >
                <option value="">Select a line</option>
                {due.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.description} · {line.returnDueQuantity} {line.unit} due
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <label htmlFor="return-quantity">Quantity received</label>
              <input
                id="return-quantity"
                type="number"
                min="0"
                step="0.001"
                value={quantity}
                disabled={!enabled}
                onChange={(event) => {
                  setQuantity(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <label htmlFor="return-date">Received on</label>
              <input
                id="return-date"
                type="date"
                max={todayISO()}
                value={receivedOn}
                disabled={!enabled}
                onChange={(event) => {
                  setReceivedOn(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <label htmlFor="return-serials">Serial / asset numbers</label>
              <input
                id="return-serials"
                placeholder="Comma separated"
                value={serials}
                disabled={!enabled}
                onChange={(event) => {
                  setSerials(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <label htmlFor="return-condition">Condition on receipt</label>
              <input
                id="return-condition"
                maxLength={500}
                value={conditionNote}
                disabled={!enabled}
                onChange={(event) => {
                  setConditionNote(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <label htmlFor="return-disposition">Repair disposition</label>
              <input
                id="return-disposition"
                maxLength={200}
                value={repairDisposition}
                disabled={!enabled}
                onChange={(event) => {
                  setRepairDisposition(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <label htmlFor="return-received-by">Received by</label>
              <input
                id="return-received-by"
                maxLength={200}
                value={receivedBy}
                disabled={!enabled}
                onChange={(event) => {
                  setReceivedBy(event.currentTarget.value);
                }}
              />
            </Field>
          </FieldRow>
          <Field>
            <label htmlFor="return-notes">Repair intake notes</label>
            <textarea
              id="return-notes"
              rows={2}
              maxLength={2000}
              value={notes}
              disabled={!enabled}
              onChange={(event) => {
                setNotes(event.currentTarget.value);
              }}
            />
          </Field>
          <Actions>
            <Button
              disabled={!ready || pending}
              onClick={() => {
                const parsed = serials
                  .split(',')
                  .map((value) => value.trim())
                  .filter((value) => value !== '');
                onReceive({
                  lineId,
                  quantity,
                  receivedOn,
                  ...(parsed.length === 0 ? {} : { serials: parsed }),
                  conditionNote: conditionNote.trim(),
                  repairDisposition: repairDisposition.trim(),
                  receivedBy: receivedBy.trim(),
                  ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
                });
                setQuantity('');
                setSerials('');
              }}
            >
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              Receive for repair
            </Button>
          </Actions>
        </>
      )}
    </Card>
  );
}

function HistoryTab({
  requesterName,
  approvalComment,
  dispatches,
  returns,
}: {
  readonly requesterName: string;
  readonly approvalComment: string | null;
  readonly dispatches: MaintenanceDetailResponse['dispatches'];
  readonly returns: MaintenanceDetailResponse['returns'];
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Audit history</h2>
        <p className="m-0 text-sm text-muted-foreground">
          What this request has produced. The full actor-by-actor trail is on the
          Work&apos;s timeline.
        </p>
      </CardHeader>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        <li className="rounded-lg p-3 text-sm ring-1 ring-foreground/10">
          Request raised by {requesterName}
        </li>
        {approvalComment !== null && (
          <li className="rounded-lg p-3 text-sm ring-1 ring-foreground/10">
            Admin approval · {approvalComment}
          </li>
        )}
        {dispatches.map((dispatch) => (
          <li
            key={dispatch.id}
            className="rounded-lg p-3 text-sm ring-1 ring-foreground/10"
          >
            <PackageCheck
              className="mr-2 inline size-4 align-text-bottom"
              aria-hidden="true"
            />
            Challan{' '}
            <span className="font-mono tabular-nums">{dispatch.challanNumber}</span> ·{' '}
            <span className="font-mono tabular-nums">
              {formatDate(dispatch.dispatchDate)}
            </span>{' '}
            · received by {dispatch.receiverName}
            <span className="block text-xs text-muted-foreground">
              {dispatch.lines
                .map((line) => `${line.quantity} ${line.unit} ${line.description}`)
                .join(', ')}
            </span>
          </li>
        ))}
        {returns.map((entry) => (
          <li key={entry.id} className="rounded-lg p-3 text-sm ring-1 ring-foreground/10">
            <RotateCcw
              className="mr-2 inline size-4 align-text-bottom"
              aria-hidden="true"
            />
            <span className="font-mono tabular-nums">{entry.quantity}</span>{' '}
            {entry.lineDescription} received for {entry.repairDisposition} by{' '}
            {entry.receivedBy} on{' '}
            <span className="font-mono tabular-nums">
              {formatDate(entry.receivedOn)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
