import type { WorkDetailResponse, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { useMemo, useState } from 'react';
import type { ApiClient, SetWorkItemTaxFactsRequest } from '../api.js';
import { formatCompactInr } from '../format.js';
import { exactRowsTotal } from '../loa-payload.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { FormError } from '../ui/form.js';
import {
  ClampedText,
  ScheduleAccordionControls,
  ScheduleSection,
  useScheduleAccordion,
} from '../ui/schedule-section.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { PaymentMatrix } from './PaymentMatrix.js';
import { NumericInput } from '../ui/numeric-input.js';

/** Renders "original → effective" when an approved amendment changed the
 * value, and the original alone otherwise. */
function Amended({
  original,
  effective,
}: {
  readonly original: string;
  readonly effective: string | null | undefined;
}) {
  if (effective === null || effective === undefined || effective === original) {
    return <>{original}</>;
  }
  return (
    <>
      <s className="text-muted-foreground">{original}</s> → <strong>{effective}</strong>
    </>
  );
}

function itemFlags(item: WorkItem, pendingRemovals: ReadonlySet<string>) {
  return {
    removalPending: pendingRemovals.has(item.id),
    added: item.amendmentAdded === true,
    /* More installed than the contract sanctions, so the item owes a
     * railway variation order. `pendingVariation` is optional on the work
     * item — absent on responses built before migration 0077 — so the
     * test is explicit rather than truthy. Same words and same warning
     * tint as the recording flow's chip in `Installations.tsx`, which is
     * the mock's (`components/installation-capture-flow.tsx:50`). */
    variationPending: item.pendingVariation === true,
  };
}

/** The item's GST facts in one quiet line — HSN is optional metadata the
 * tax screens chase when an invoice needs it, so an empty set is a muted
 * dash, not a warning. */
function taxFactsSummary(item: WorkItem): string | null {
  const parts = [
    item.hsnCode ?? null,
    typeof item.gstRate === 'string' ? `${item.gstRate}%` : null,
    item.isService === true ? 'service' : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * One schedule's AMC billing cadence (owner ruling of 2026-08-19;
 * migration 0107): how many periods its maintenance is billed in, and the
 * word the agency calls one of them.
 *
 * On the schedule and not on the Work, because a real letter carries two
 * — PL-218 prices a quarterly maintenance schedule beside a visit
 * schedule billed per trip. Clearing both fields removes the cadence, and
 * a schedule that states none simply proposes nothing: nothing here
 * changes what a certificate may certify.
 */
function AmcCycleEditor({
  schedule,
  canModify,
  pending,
  onSave,
}: {
  readonly schedule: WorkDetailResponse['schedules'][number];
  readonly canModify: boolean;
  readonly pending: boolean;
  readonly onSave: (billingPeriods: number | null, cycleNoun: string | null) => void;
}) {
  const [periods, setPeriods] = useState(
    schedule.amcBillingPeriods === null ? '' : String(schedule.amcBillingPeriods),
  );
  const [noun, setNoun] = useState(schedule.amcCycleNoun ?? '');
  /** Refused here rather than sent. "abc" parses to NaN, which serialises
   * as null and would reach the server as "clear the cycle" — an answer
   * nobody asked for, and one that reads as success. */
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!canModify) {
    return (
      <p className="text-muted-foreground">
        {schedule.amcBillingPeriods === null
          ? 'No maintenance billing cycle set.'
          : `Maintenance billed in ${String(schedule.amcBillingPeriods)} ${schedule.amcCycleNoun ?? ''} periods.`}
      </p>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmedPeriods = periods.trim();
        const trimmedNoun = noun.trim();
        if (trimmedPeriods !== '' && !/^[1-9][0-9]{0,2}$/.test(trimmedPeriods)) {
          setRefusal('The number of billing periods is a whole number, 1 or more.');
          return;
        }
        if ((trimmedPeriods === '') !== (trimmedNoun === '')) {
          setRefusal(
            'Enter both the number of periods and the word this schedule calls one of them, or clear both.',
          );
          return;
        }
        setRefusal(null);
        onSave(
          trimmedPeriods === '' ? null : Number.parseInt(trimmedPeriods, 10),
          trimmedNoun === '' ? null : trimmedNoun,
        );
      }}
    >
      <label htmlFor={`amc-periods-${schedule.id}`}>
        Maintenance billing periods in schedule {schedule.scheduleCode}
      </label>
      <input
        id={`amc-periods-${schedule.id}`}
        className="w-20"
        inputMode="numeric"
        maxLength={3}
        placeholder="e.g. 12"
        value={periods}
        onChange={(event) => {
          setPeriods(event.currentTarget.value);
        }}
      />
      <label htmlFor={`amc-noun-${schedule.id}`}>each called a</label>
      <input
        id={`amc-noun-${schedule.id}`}
        className="w-32"
        maxLength={30}
        placeholder="quarter"
        value={noun}
        onChange={(event) => {
          setNoun(event.currentTarget.value);
        }}
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Save cycle
      </Button>
      {refusal !== null && <FormError>{refusal}</FormError>}
    </form>
  );
}

/** Compact in-cell editor for one item's tax facts. All three fields
 * travel on save: a blank code or rate is an explicit null (the PATCH
 * clears it), matching what the boxes show. */
function TaxFactsEditor({
  item,
  pending,
  onSave,
  onCancel,
}: {
  readonly item: WorkItem;
  readonly pending: boolean;
  readonly onSave: (facts: Required<SetWorkItemTaxFactsRequest>) => void;
  readonly onCancel: () => void;
}) {
  const [hsnCode, setHsnCode] = useState(item.hsnCode ?? '');
  const [gstRate, setGstRate] = useState(item.gstRate ?? '');
  const [isService, setIsService] = useState(item.isService === true);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`tax-hsn-${item.id}`}>
        HSN or SAC code for {item.itemNumber}
      </label>
      <input
        id={`tax-hsn-${item.id}`}
        className="w-28"
        inputMode="numeric"
        pattern="[0-9]{6,8}"
        maxLength={8}
        placeholder="HSN/SAC"
        value={hsnCode}
        onChange={(event) => {
          setHsnCode(event.currentTarget.value);
        }}
      />
      <label className="sr-only" htmlFor={`tax-rate-${item.id}`}>
        GST rate percentage for {item.itemNumber}
      </label>
      <NumericInput
        id={`tax-rate-${item.id}`}
        className="w-20"
        maxLength={6}
        placeholder="GST %"
        value={gstRate}
        onChange={(event) => {
          setGstRate(event.currentTarget.value);
        }}
      />
      <label className="whitespace-nowrap" htmlFor={`tax-service-${item.id}`}>
        <input
          id={`tax-service-${item.id}`}
          type="checkbox"
          checked={isService}
          onChange={(event) => {
            setIsService(event.currentTarget.checked);
          }}
        />{' '}
        Service
      </label>
      <Button
        disabled={pending}
        aria-label={`Save tax facts for ${item.itemNumber}`}
        onClick={() => {
          onSave({
            hsnCode: hsnCode.trim() === '' ? null : hsnCode.trim(),
            gstRate: gstRate.trim() === '' ? null : gstRate.trim(),
            isService,
          });
        }}
      >
        Save
      </Button>
      <Button
        variant="outline"
        aria-label={`Cancel tax facts for ${item.itemNumber}`}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </span>
  );
}

interface WorkSchedulesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly schedules: WorkDetailResponse['schedules'];
  readonly workItems: readonly WorkItem[];
  /** Item ids carrying an undecided omission proposal (R7). */
  readonly pendingRemovals: ReadonlySet<string>;
  readonly setDetail: Dispatch<SetStateAction<WorkDetailResponse | null>>;
  readonly canModify: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** The awarded schedule: every item as the letter sanctioned it, with any
 * approved amendment shown beside the original, and the per-Work payment
 * matrix. Split out of WorkDetail, which was rendering eleven areas from
 * one file. */
export function WorkSchedules({
  api,
  organisationId,
  workId,
  schedules,
  workItems,
  pendingRemovals,
  setDetail,
  canModify,
  pending,
  act,
}: WorkSchedulesProps) {
  /** The one row whose GST facts are being edited; the summary elsewhere. */
  const [taxEditingItemId, setTaxEditingItemId] = useState<string | null>(null);
  const accordion = useScheduleAccordion(schedules.map((schedule) => schedule.id));

  /** Each schedule's sanctioned value, in exact BigInt minor units over
   * the EFFECTIVE quantity and rate — what an approved amendment left,
   * not what the letter first awarded. Display only; the server stays
   * authoritative for every stored amount. */
  const scheduleTotals = useMemo(() => {
    const totals = new Map<string, string | null>();
    for (const schedule of schedules) {
      totals.set(
        schedule.id,
        exactRowsTotal(
          schedule.items.map((item) => ({
            awardedQuantity: item.effectiveQuantity ?? item.awardedQuantity,
            effectiveRate: item.effectiveUnitRate ?? item.effectiveRate,
          })),
        ),
      );
    }
    return totals;
  }, [schedules]);

  /** The cadence route answers 204 — two columns moved and nothing else
   * did — so the loaded detail is patched in place rather than refetched
   * for a pair of values the browser already has. */
  const patchSchedule = (
    scheduleId: string,
    patch: Partial<WorkDetailResponse['schedules'][number]>,
  ) => {
    setDetail((current) =>
      current === null
        ? current
        : {
            ...current,
            schedules: current.schedules.map((candidate) =>
              candidate.id === scheduleId ? { ...candidate, ...patch } : candidate,
            ),
          },
    );
  };

  /** The edits here change fields of one item in place; the loaded
   * detail is otherwise left exactly as the server sent it. */
  const patchItem = (workItemId: string, patch: Partial<WorkItem>) => {
    setDetail((current) =>
      current === null
        ? current
        : {
            ...current,
            schedules: current.schedules.map((candidate) => ({
              ...candidate,
              items: candidate.items.map((candidateItem) =>
                candidateItem.id === workItemId
                  ? { ...candidateItem, ...patch }
                  : candidateItem,
              ),
            })),
          },
    );
  };

  return (
    <>
      <ScheduleAccordionControls
        accordion={accordion}
        scheduleCount={schedules.length}
        itemCount={workItems.length}
      />
      {schedules.map((schedule) => (
        <ScheduleSection
          key={schedule.id}
          code={schedule.scheduleCode}
          title={schedule.title}
          itemCount={schedule.items.length}
          total={((total) => (total === null ? null : formatCompactInr(total)))(
            scheduleTotals.get(schedule.id) ?? null,
          )}
          expanded={accordion.isExpanded(schedule.id)}
          onToggle={() => {
            accordion.toggle(schedule.id);
          }}
        >
          <AmcCycleEditor
            schedule={schedule}
            canModify={canModify}
            pending={pending}
            onSave={(billingPeriods, cycleNoun) => {
              void act(async () => {
                await api.setScheduleAmcCycle(organisationId, workId, schedule.id, {
                  billingPeriods,
                  cycleNoun,
                });
                patchSchedule(schedule.id, {
                  amcBillingPeriods: billingPeriods,
                  amcCycleNoun: cycleNoun,
                });
              }, `Maintenance billing cycle saved for schedule ${schedule.scheduleCode}.`);
            }}
          />
          <DataTable>
            <caption className="sr-only">
              Awarded items in schedule {schedule.scheduleCode}; amended values show the
              original beside the sanctioned change, and each item carries its GST facts
            </caption>
            <thead>
              <tr>
                <th scope="col">Item number</th>
                <th scope="col">Description</th>
                <th scope="col">Unit</th>
                <th scope="col">Awarded quantity</th>
                <th scope="col">Rate (₹)</th>
                <th scope="col">GST</th>
                <th scope="col">Serial tracking</th>
              </tr>
            </thead>
            <tbody>
              {schedule.items.map((item) => {
                const flags = itemFlags(item, pendingRemovals);
                return (
                  <tr key={item.id}>
                    <th scope="row">
                      {item.itemNumber}
                      {flags.added && <StatusChip status="issued">added</StatusChip>}
                      {flags.removalPending && (
                        <StatusChip status="pending">omission pending</StatusChip>
                      )}
                      {flags.variationPending && (
                        <Badge variant="warning">Above LOA — variation pending</Badge>
                      )}
                    </th>
                    <td className={wrapCell}>
                      {item.effectiveDescription === null ||
                      item.effectiveDescription === undefined ||
                      item.effectiveDescription === item.description ? (
                        <ClampedText text={item.description} label={item.itemNumber} />
                      ) : (
                        <Amended
                          original={item.description}
                          effective={item.effectiveDescription}
                        />
                      )}
                    </td>
                    <td>
                      <Amended
                        original={item.unitCode}
                        effective={item.effectiveUnit}
                      />
                    </td>
                    <td className={numericCell}>
                      <Amended
                        original={item.awardedQuantity}
                        effective={item.effectiveQuantity}
                      />
                    </td>
                    <td className={numericCell}>
                      <Amended
                        original={item.effectiveRate}
                        effective={item.effectiveUnitRate}
                      />
                    </td>
                    <td>
                      {canModify && taxEditingItemId === item.id ? (
                        <TaxFactsEditor
                          item={item}
                          pending={pending}
                          onCancel={() => {
                            setTaxEditingItemId(null);
                          }}
                          onSave={(facts) =>
                            void act(async () => {
                              const updated = await api.setWorkItemTaxFacts(
                                organisationId,
                                item.id,
                                facts,
                              );
                              patchItem(item.id, {
                                hsnCode: updated.hsnCode,
                                gstRate: updated.gstRate,
                                isService: updated.isService,
                              });
                              setTaxEditingItemId(null);
                            }, `Tax facts saved for ${item.itemNumber}.`)
                          }
                        />
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={
                              taxFactsSummary(item) === null
                                ? 'text-muted-foreground'
                                : ''
                            }
                          >
                            {taxFactsSummary(item) ?? '—'}
                          </span>
                          {canModify && (
                            <Button
                              variant="outline"
                              aria-label={`Tax facts for ${item.itemNumber}`}
                              disabled={pending}
                              onClick={() => {
                                setTaxEditingItemId(item.id);
                              }}
                            >
                              Edit
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      {canModify ? (
                        <Button
                          variant="outline"
                          role="switch"
                          aria-checked={item.requiresSerials === true}
                          aria-label={`Serial tracking for ${item.itemNumber}`}
                          disabled={pending}
                          onClick={() =>
                            void act(
                              async () => {
                                const updated = await api.updateWorkItemSerials(
                                  organisationId,
                                  item.id,
                                  !item.requiresSerials,
                                );
                                patchItem(item.id, {
                                  requiresSerials: updated.requiresSerials,
                                });
                              },
                              item.requiresSerials
                                ? `Serial tracking switched off for ${item.itemNumber}.`
                                : `Serial tracking required for ${item.itemNumber}; challans for it now need one serial per unit before issue.`,
                            )
                          }
                        >
                          {item.requiresSerials ? 'Required' : 'Off'}
                        </Button>
                      ) : (
                        <span
                          className={
                            item.requiresSerials ? '' : 'text-muted-foreground'
                          }
                        >
                          {item.requiresSerials ? 'Required' : 'Off'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </ScheduleSection>
      ))}

      <PaymentMatrix
        api={api}
        organisationId={organisationId}
        workId={workId}
        schedules={schedules}
        canModify={canModify}
        onItemCategoryChanged={(workItemId, paymentCategory) => {
          patchItem(workItemId, { paymentCategory });
        }}
      />
    </>
  );
}
