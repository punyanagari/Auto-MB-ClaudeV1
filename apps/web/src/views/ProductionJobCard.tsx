import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  PackageCheck,
  Plus,
  ScanLine,
  Trash2,
  Truck,
} from 'lucide-react';
import type { FinishedSerial, JobCardDetail } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, todayISO } from '../format.js';
import { cn } from '../lib/cn.js';
import { productionHash } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FormError } from '../ui/form.js';
import { ProgressBar } from '../ui/progress.js';
import { Stat } from '../ui/stat.js';
import { TabRail } from '../ui/tab-rail.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell } from '../ui/table.js';

/**
 * One production job card, in the mock's four tabs.
 *
 * Replicates `components/production-job-card-page.tsx` at fdfe5ef: a back
 * link over the plan number and the item name, a readiness badge on the
 * right, then Overview / Materials / Serials / Dispatch — three stat
 * cards and a progress bar, a four-column material grid, a two-card
 * serial panel, and a checkbox list over a dispatch action.
 *
 * Three things the mock cannot express, each built with its own
 * components and each recorded in `docs/UX.md` § 11:
 *
 *   * **Serials are captured PER UNIT.** The mock's component serials are
 *     a bag of strings per plan, so it can say a batch consumed twelve
 *     power supplies and not which board each went into — which is the
 *     question a field failure asks. Selecting a unit here opens its own
 *     component slots.
 *   * **"Complete one unit" mints a serial.** In the mock the counter and
 *     the serial list are separate controls that can disagree; here the
 *     unit IS its serial, claimed from the item's counter.
 *   * **"Create delivery challan" is "Release to stock".** Production
 *     hands finished units to stock; the Delivery Challan is a statutory
 *     document raised against a Work, with a consignee, an e-way bill and
 *     a number series behind it. A button on the factory floor that
 *     appeared to issue one would be claiming an act it does not perform.
 */

type Tab = 'overview' | 'materials' | 'serials' | 'dispatch';

interface ProductionJobCardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly jobCardId: string;
  /** Recording is shop-floor work: owner, office and site. */
  readonly canRecord: boolean;
  /** Cancelling the card and withdrawing a release carry the cancel
   * authority, as every other cancel of a numbered record does. */
  readonly canCancel: boolean;
  readonly onBack: () => void;
}

export function ProductionJobCard({
  api,
  organisationId,
  jobCardId,
  canRecord,
  canCancel,
  onBack,
}: ProductionJobCardProps) {
  const [card, setCard] = useState<JobCardDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [pending, setPending] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCard(null);
    setLoadError(null);
    api
      .getJobCard(organisationId, jobCardId)
      .then((loaded) => {
        if (cancelled) return;
        setCard(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The job card could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, jobCardId, loadVersion]);

  /** Every mutation answers with the whole card, so one helper drives all
   * of them: the screen never patches a fragment of state that the server
   * might disagree with. */
  const run = useCallback((action: () => Promise<JobCardDetail>, failure: string) => {
    setActionError(null);
    setPending(true);
    action()
      .then((updated) => {
        setCard(updated);
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof RequestFailedError ? cause.message : failure);
      })
      .finally(() => {
        setPending(false);
      });
  }, []);

  if (loadError !== null) {
    return (
      <ErrorState
        onRetry={() => {
          setLoadVersion((current) => current + 1);
        }}
        retryLabel="Retry the job card"
      >
        {loadError}
      </ErrorState>
    );
  }

  if (card === null) return <LoadingState label="the job card" rows={4} columns={3} />;

  const open = card.status === 'planned' || card.status === 'in_production';

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Production
          </Button>
          <p className="m-0 mt-3 font-mono text-xs tabular-nums text-muted-foreground">
            {card.number} · {card.sourceType === 'work' ? 'Railway LOA' : 'Private PO'}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-balance" id="job-card-title">
            {card.itemName}
          </h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {/* The mock prints `plan.customer` here on every plan. A
                Work-sourced card has no party name in this product, so it
                prints the Work code, which is the identifier an operator
                uses (see the contract's note on `customer`). */}
            {card.customer ?? card.workCode ?? 'No customer recorded'} ·{' '}
            {card.sourceReference}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={statusKeyOf(card)}>{statusLabelOf(card)}</StatusChip>
          {open && (
            <Badge variant={card.dispatchReady ? 'success' : 'neutral'}>
              {card.dispatchReady ? 'Dispatch ready' : 'Units outstanding'}
            </Badge>
          )}
        </div>
      </div>

      {card.status === 'cancelled' && card.cancellationReason !== null && (
        <Card className="mb-4">
          <p className="m-0 text-sm">
            <span className="font-medium">Cancelled.</span> {card.cancellationReason}
          </p>
        </Card>
      )}

      <TabRail
        label="Job card sections"
        tabs={
          [
            ['overview', 'Overview'],
            ['materials', 'Materials'],
            ['serials', 'Serials'],
            ['dispatch', 'Dispatch'],
          ] as const
        }
        active={tab}
        onSelect={setTab}
      />

      {actionError !== null && <FormError>{actionError}</FormError>}

      <div className="mt-4">
        {tab === 'overview' && (
          <OverviewTab
            api={api}
            organisationId={organisationId}
            card={card}
            canRecord={canRecord}
            canCancel={canCancel}
            pending={pending}
            run={run}
          />
        )}
        {tab === 'materials' && <MaterialsTab card={card} />}
        {tab === 'serials' && (
          <SerialsTab
            api={api}
            organisationId={organisationId}
            card={card}
            canRecord={canRecord}
            pending={pending}
            run={run}
          />
        )}
        {tab === 'dispatch' && (
          <DispatchTab
            api={api}
            organisationId={organisationId}
            card={card}
            canRecord={canRecord}
            canCancel={canCancel}
            pending={pending}
            run={run}
          />
        )}
      </div>
    </>
  );
}

type Run = (action: () => Promise<JobCardDetail>, failure: string) => void;

function OverviewTab({
  api,
  organisationId,
  card,
  canRecord,
  canCancel,
  pending,
  run,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly card: JobCardDetail;
  readonly canRecord: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  readonly run: Run;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const open = card.status === 'planned' || card.status === 'in_production';
  const percent = card.quantity === 0 ? 0 : (card.manufactured / card.quantity) * 100;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <Stat
            label="Planned"
            value={`${String(card.quantity)} Nos`}
            hint={`Due ${formatDate(card.dueDate)}`}
          />
        </Card>
        <Card>
          <Stat
            label="Manufactured"
            value={`${String(card.manufactured)} Nos`}
            hint={`${String(Math.round(percent))}% complete`}
          />
        </Card>
        <Card>
          <Stat
            label="Dispatched"
            value={`${String(card.dispatched)} Nos`}
            hint={
              card.dispatches.length === 0
                ? 'Nothing released yet'
                : `${String(card.dispatches.length)} releases`
            }
          />
        </Card>
      </div>

      <Card className="mt-4">
        <div className="flex justify-between text-sm">
          <span>Manufacturing progress</span>
          <span className="font-mono tabular-nums">
            {card.manufactured}/{card.quantity}
          </span>
        </div>
        <ProgressBar
          className="mt-3"
          value={percent}
          label={`Units built on job card ${card.number}`}
        />
        {canRecord && open && (
          <Actions>
            <Button
              variant="outline"
              disabled={pending || card.manufactured >= card.quantity}
              onClick={() => {
                run(
                  () => api.recordProductionSerial(organisationId, card.id),
                  'The unit could not be recorded.',
                );
              }}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Complete one unit
            </Button>
            <Button
              disabled={pending || card.manufactured < card.quantity}
              onClick={() => {
                run(
                  () => api.completeJobCard(organisationId, card.id),
                  'The job card could not be completed.',
                );
              }}
            >
              <CheckCircle2 data-icon="inline-start" aria-hidden="true" />
              Mark complete
            </Button>
            {canCancel && (
              <Button
                variant="outline"
                onClick={() => {
                  setCancelling((value) => !value);
                }}
              >
                Cancel job card
              </Button>
            )}
          </Actions>
        )}
        {card.manufactured < card.quantity && open && (
          <p className="m-0 mt-2 text-xs text-muted-foreground">
            {card.quantity - card.manufactured} of {card.quantity} units are still to be
            built. Completing the card is blocked until every planned unit exists as a
            serial, or the planned quantity is reduced to what was built.
          </p>
        )}
        {cancelling && canCancel && (
          <form
            className="mt-3 rounded-lg border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () => api.cancelJobCard(organisationId, card.id, { reason }),
                'The job card could not be cancelled.',
              );
              setCancelling(false);
            }}
          >
            <Field>
              <label htmlFor="job-card-cancel-reason">
                Why is this job card being cancelled?
              </label>
              <input
                id="job-card-cancel-reason"
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
              <p className="m-0 text-xs text-muted-foreground">
                The card keeps its number and its units keep their serials. Nothing
                reopens.
              </p>
            </Field>
            <Actions>
              <Button type="submit" size="sm" disabled={pending}>
                Cancel the job card
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setCancelling(false);
                }}
              >
                Keep it open
              </Button>
            </Actions>
          </form>
        )}
      </Card>
    </>
  );
}

function MaterialsTab({ card }: { readonly card: JobCardDetail }) {
  if (card.materials.length === 0) {
    return (
      <EmptyState>
        This product has no bill of material. Add the parts one unit is built from in
        the item master, and the requirement for this job card follows from them.
      </EmptyState>
    );
  }
  return (
    <>
      <DataTable>
        <caption className="sr-only">
          Material for this job card, by part: what it requires, what is on the shelf
          for it, and what is still short
        </caption>
        <thead>
          <tr>
            <th scope="col">Material</th>
            <th scope="col" className={numericCell}>
              Required
            </th>
            <th scope="col" className={numericCell}>
              Available
            </th>
            <th scope="col" className={numericCell}>
              Shortage
            </th>
            <th scope="col">Unit</th>
            <th scope="col">Serials</th>
          </tr>
        </thead>
        <tbody>
          {card.materials.map((material) => (
            <tr key={material.itemId}>
              <th scope="row">
                <p className="m-0 text-sm font-medium">{material.name}</p>
                <p className="m-0 font-mono text-xs font-normal tabular-nums text-muted-foreground">
                  {material.itemCode}
                </p>
              </th>
              <td className={numericCell}>{material.required}</td>
              <td className={numericCell}>{material.available}</td>
              {/* Untinted, exactly as the stock register leaves its own
                  negative Available untinted: the figure has to be
                  legible on its own in both themes, and the word that
                  says a card is short is the badge on the register. */}
              <td className={numericCell}>{material.shortage}</td>
              <td>{material.unit}</td>
              <td>
                {material.serialControlled ? (
                  <Badge variant="outline">Serial required</Badge>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p className="mt-3 text-xs text-muted-foreground">
        Required is the whole card's bill. Available is what the shelf holds for this
        card, after every other open job card's claim on the same part. Shortage is what
        is left to buy for the units still to build: material already issued to this
        card and material already on order are both counted, so it is not Required less
        Available.
      </p>
    </>
  );
}

function SerialsTab({
  api,
  organisationId,
  card,
  canRecord,
  pending,
  run,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly card: JobCardDetail;
  readonly canRecord: boolean;
  readonly pending: boolean;
  readonly run: Run;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    card.serials[0]?.id ?? null,
  );
  const selected =
    card.serials.find((unit) => unit.id === selectedId) ?? card.serials[0] ?? null;
  const open = card.status === 'planned' || card.status === 'in_production';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Finished item serials</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Choose a unit to record what went inside it.
          </p>
        </CardHeader>
        {card.serials.length === 0 ? (
          <EmptyState>
            No unit has been built yet. Each one is named from the product&apos;s own
            serial series when it is recorded.
          </EmptyState>
        ) : (
          <div className="flex flex-wrap gap-2">
            {card.serials.map((unit) => (
              <button
                key={unit.id}
                type="button"
                aria-pressed={unit.id === selected?.id}
                onClick={() => {
                  setSelectedId(unit.id);
                }}
                className={cn(
                  'rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition-colors',
                  unit.id === selected?.id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted',
                )}
              >
                {unit.serialNumber}
                {unit.dispatchedOn !== null && ' ·'}
                {unit.dispatchedOn !== null && (
                  <span className="ml-1 text-[10px] uppercase">released</span>
                )}
              </button>
            ))}
          </div>
        )}
        {canRecord && open && (
          <Actions>
            <Button
              variant="outline"
              disabled={pending || card.manufactured >= card.quantity}
              onClick={() => {
                run(
                  () => api.recordProductionSerial(organisationId, card.id),
                  'The unit could not be recorded.',
                );
              }}
            >
              <ScanLine data-icon="inline-start" aria-hidden="true" />
              Generate next serial
            </Button>
            {selected !== null && selected.dispatchedOn === null && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove unit ${selected.serialNumber}`}
                disabled={pending}
                onClick={() => {
                  run(
                    () => api.removeProductionSerial(organisationId, selected.id),
                    'The unit could not be removed.',
                  );
                }}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            )}
          </Actions>
        )}
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Serialized components</h2>
          <p className="m-0 text-sm text-muted-foreground">
            {selected === null
              ? 'What one unit is built from.'
              : `Inside ${selected.serialNumber}.`}
          </p>
        </CardHeader>
        {card.componentSlots.length === 0 ? (
          <EmptyState>
            No part of this product is serial controlled, so there is nothing to capture
            per unit.
          </EmptyState>
        ) : selected === null ? (
          <EmptyState>Build a unit first, then record what went inside it.</EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {card.componentSlots.map((slot) => (
              <ComponentSlotRow
                key={slot.componentItemId}
                api={api}
                organisationId={organisationId}
                unit={selected}
                slot={slot}
                canRecord={canRecord && selected.dispatchedOn === null}
                pending={pending}
                run={run}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ComponentSlotRow({
  api,
  organisationId,
  unit,
  slot,
  canRecord,
  pending,
  run,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly unit: FinishedSerial;
  readonly slot: JobCardDetail['componentSlots'][number];
  readonly canRecord: boolean;
  readonly pending: boolean;
  readonly run: Run;
}) {
  const [value, setValue] = useState('');
  const captured = unit.components.filter(
    (component) => component.componentItemId === slot.componentItemId,
  );
  const complete = captured.length >= slot.required;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex justify-between gap-2">
        <span className="text-sm font-medium">{slot.name}</span>
        <span
          className={cn(
            'font-mono text-sm tabular-nums',
            complete ? 'text-success' : 'text-destructive',
          )}
        >
          {captured.length}/{slot.required}
        </span>
      </div>
      {captured.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
          {captured.map((component) => (
            <li key={component.id} className="flex items-center gap-1">
              <Badge variant="neutral" className="font-mono tabular-nums">
                {component.serialNumber}
              </Badge>
              {canRecord && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove component serial ${component.serialNumber}`}
                  disabled={pending}
                  onClick={() => {
                    run(
                      () => api.removeComponentSerial(organisationId, component.id),
                      'The component serial could not be removed.',
                    );
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canRecord && !complete && (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                api.recordComponentSerial(organisationId, unit.id, {
                  componentItemId: slot.componentItemId,
                  serialNumber: value,
                }),
              'The component serial could not be recorded.',
            );
            setValue('');
          }}
        >
          <label className="sr-only" htmlFor={`component-${slot.componentItemId}`}>
            {slot.name} serial for unit {unit.serialNumber}
          </label>
          <input
            id={`component-${slot.componentItemId}`}
            placeholder="Scan or enter component serial"
            required
            maxLength={100}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
            }}
          />
        </form>
      )}
    </div>
  );
}

function DispatchTab({
  api,
  organisationId,
  card,
  canRecord,
  canCancel,
  pending,
  run,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly card: JobCardDetail;
  readonly canRecord: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  readonly run: Run;
}) {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [dispatchedOn, setDispatchedOn] = useState(todayISO());
  const available = card.serials.filter((unit) => unit.dispatchedOn === null);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Truck aria-hidden="true" />
          </div>
          <div>
            <p className="m-0 font-medium">Release to stock</p>
            <p className="m-0 text-sm text-muted-foreground">
              {/* The mock's line says "linked to a challan". This says what
                  the act really is; the Delivery Challan is raised later,
                  against a Work, from the Challans register. */}
              Only finished units whose component serials are complete may leave
              production. A released unit becomes despatchable stock; its Delivery
              Challan is raised separately.
            </p>
          </div>
        </div>

        {available.length === 0 ? (
          <EmptyState className="mt-4">
            {card.serials.length === 0
              ? 'Nothing to release yet — no unit has been built.'
              : 'Every unit built on this job card has already left production.'}
          </EmptyState>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {available.map((unit) => (
                <label
                  key={unit.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    disabled={!canRecord}
                    checked={chosen.includes(unit.id)}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setChosen((current) =>
                        on
                          ? [...current, unit.id]
                          : current.filter((id) => id !== unit.id),
                      );
                    }}
                  />
                  <span className="font-mono tabular-nums">{unit.serialNumber}</span>
                </label>
              ))}
            </div>
            {canRecord && (
              <>
                <Field className="mt-3">
                  <label htmlFor="dispatch-date">Released on</label>
                  <input
                    id="dispatch-date"
                    type="date"
                    value={dispatchedOn}
                    max={todayISO()}
                    onChange={(event) => {
                      setDispatchedOn(event.currentTarget.value);
                    }}
                  />
                </Field>
                <Actions>
                  <Button
                    disabled={pending || chosen.length === 0}
                    onClick={() => {
                      run(
                        () =>
                          api.createProductionDispatch(organisationId, card.id, {
                            serialIds: [...chosen],
                            dispatchedOn,
                          }),
                        'The units could not be released.',
                      );
                      setChosen([]);
                    }}
                  >
                    <PackageCheck data-icon="inline-start" aria-hidden="true" />
                    Release {chosen.length > 0 ? chosen.length : ''} to stock
                  </Button>
                </Actions>
              </>
            )}
          </>
        )}
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Releases</h2>
        </CardHeader>
        {card.dispatches.length === 0 ? (
          <EmptyState>Nothing has left production on this job card yet.</EmptyState>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {card.dispatches.map((dispatch) => (
              <li
                key={dispatch.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="m-0 font-mono text-sm tabular-nums text-primary">
                    {dispatch.number}
                  </p>
                  <p className="m-0 mt-1 text-xs text-muted-foreground">
                    {dispatch.serialNumbers.length} units ·{' '}
                    <span className="font-mono tabular-nums">
                      {formatDate(dispatch.dispatchedOn)}
                    </span>
                  </p>
                  <p className="m-0 mt-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {dispatch.serialNumbers.join(', ')}
                  </p>
                </div>
                {canCancel && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Withdraw release ${dispatch.number}`}
                    disabled={pending}
                    onClick={() => {
                      run(
                        () =>
                          api.withdrawProductionDispatch(organisationId, dispatch.id),
                        'The release could not be withdrawn.',
                      );
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        <a href={productionHash(null)} className="text-muted-foreground">
          Back to the production register
        </a>
      </p>
    </div>
  );
}

function statusKeyOf(card: JobCardDetail): string {
  return card.status === 'in_production' ? 'in-production' : card.status;
}

function statusLabelOf(card: JobCardDetail): string {
  switch (card.status) {
    case 'in_production':
      return 'In production';
    case 'planned':
      return 'Planned';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
  }
}
