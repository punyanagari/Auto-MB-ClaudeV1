import type { WorkDetailResponse, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { PaymentMatrix } from './PaymentMatrix.js';

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
  };
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
  /** Both edits here change one field of one item in place; the loaded
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
      {schedules.map((schedule) => (
        <div key={schedule.id}>
          <h2>
            Schedule {schedule.scheduleCode}
            <span className="text-muted-foreground">
              {' '}
              · {schedule.items.length} items
            </span>
          </h2>
          <DataTable>
            <caption className="sr-only">
              Awarded items in schedule {schedule.scheduleCode}; amended values show the
              original beside the sanctioned change
            </caption>
            <thead>
              <tr>
                <th scope="col">Item number</th>
                <th scope="col">Description</th>
                <th scope="col">Unit</th>
                <th scope="col">Awarded quantity</th>
                <th scope="col">Rate (₹)</th>
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
                    </th>
                    <td className={wrapCell}>
                      <Amended
                        original={item.description}
                        effective={item.effectiveDescription}
                      />
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
        </div>
      ))}

      <PaymentMatrix
        api={api}
        organisationId={organisationId}
        workId={workId}
        workItems={workItems}
        canModify={canModify}
        onItemCategoryChanged={(workItemId, paymentCategory) => {
          patchItem(workItemId, { paymentCategory });
        }}
      />
    </>
  );
}
