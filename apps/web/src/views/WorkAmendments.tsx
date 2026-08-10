import type { ApprovalRequest, WorkDetailResponse, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { formValue, type ApiClient } from '../api.js';

interface WorkAmendmentsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly amendments: readonly ApprovalRequest[];
  readonly setAmendments: Dispatch<SetStateAction<readonly ApprovalRequest[]>>;
  readonly setDetail: Dispatch<SetStateAction<WorkDetailResponse | null>>;
  readonly schedules: WorkDetailResponse['schedules'];
  readonly workItems: readonly WorkItem[];
  readonly canCreateDocuments: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** Sanctioned changes to the awarded schedule — the proposals filed against
 * this Work and the form that files another. Split out of WorkDetail, which
 * was rendering eleven areas from one file. */
export function WorkAmendments({
  api,
  organisationId,
  workId,
  amendments,
  setAmendments,
  setDetail,
  schedules,
  workItems,
  canCreateDocuments,
  pending,
  act,
}: WorkAmendmentsProps) {
  /** Every proposal path ends the same way: re-read the Work so the
   * effective values beside the originals reflect an amendment that
   * approved immediately, and re-read the queue so the new row appears. */
  const refresh = async () => {
    const [freshDetail, freshAmendments] = await Promise.all([
      api.getWork(organisationId, workId),
      api.listWorkAmendments(organisationId, workId),
    ]);
    setDetail(freshDetail);
    setAmendments(freshAmendments);
  };

  return (
    <>
      <h2>Amendments</h2>
      <p className="muted">
        Sanctioned changes to quantities, rates, descriptions, and items. The awarded
        LOA values are never overwritten; approved amendments apply as effective values
        shown beside the originals above.
      </p>
      {amendments.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Amendment requests for this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Change</th>
              <th scope="col">Reason</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {amendments.map((amendment) => (
              <tr key={amendment.id}>
                <th scope="row">{amendment.itemNumber ?? '—'}</th>
                <td className="cell--wrap">
                  {amendment.diff
                    .map(
                      (entry) =>
                        `${entry.field}: ${entry.before ?? '—'} → ${entry.after ?? '—'}`,
                    )
                    .join('; ')}
                </td>
                <td className="cell--wrap">{amendment.reason}</td>
                <td>
                  <span className={`chip chip--${amendment.status}`}>
                    {amendment.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No amendments proposed yet.</p>
      )}
      {canCreateDocuments && (
        <AmendmentForm
          items={workItems}
          schedules={schedules}
          pending={pending}
          onProposeChange={(body) => {
            void act(async () => {
              await api.proposeAmendment(organisationId, workId, body);
              await refresh();
            }, 'Amendment recorded — it applies once approved (immediately if you hold the approval authority).');
          }}
          onProposeAdd={(body) => {
            void act(async () => {
              await api.proposeAddItem(organisationId, workId, body);
              await refresh();
            }, 'Amendment recorded — it applies once approved (immediately if you hold the approval authority).');
          }}
          onProposeRemove={(body) => {
            void act(async () => {
              await api.proposeItemRemoval(organisationId, workId, body);
              await refresh();
            }, 'Omission recorded — it applies once approved (immediately if you hold the approval authority).');
          }}
        />
      )}
    </>
  );
}

interface AmendmentFormProps {
  readonly items: readonly WorkItem[];
  readonly schedules: WorkDetailResponse['schedules'];
  readonly pending: boolean;
  readonly onProposeChange: (body: {
    workItemId: string;
    reason: string;
    changes: {
      quantity?: string;
      rate?: string;
      description?: string;
      unit?: string;
    };
  }) => void;
  readonly onProposeAdd: (body: {
    reason: string;
    scheduleId: string;
    itemNumber: string;
    description: string;
    unitCode: string;
    quantity: string;
    rate: string;
  }) => void;
  readonly onProposeRemove: (body: { workItemId: string; reason: string }) => void;
}

/** Proposes an amendment: change an item's values, omit it, or add a new
 * item to a schedule. Every proposal needs a reason; approval authority
 * decides whether it applies immediately or waits in the queue.
 *
 * Omission files through the R7 removal path, not through a change to
 * quantity 0: the removal soft-deletes the item, keeps its number
 * reserved for the life of the Work, and refuses while any delivery,
 * installation, PAC or billing evidence names it. A quantity-0 change
 * would leave the item live, and R12 refuses zero quantities anyway. */
function AmendmentForm({
  items,
  schedules,
  pending,
  onProposeChange,
  onProposeAdd,
  onProposeRemove,
}: AmendmentFormProps) {
  const [kind, setKind] = useState<'change' | 'omit' | 'add'>('change');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const reason = formValue(data, 'amendment-reason').trim();
        if (kind === 'add') {
          onProposeAdd({
            reason,
            scheduleId: formValue(data, 'amendment-schedule'),
            itemNumber: formValue(data, 'amendment-item-number').trim(),
            description: formValue(data, 'amendment-description').trim(),
            unitCode: formValue(data, 'amendment-unit').trim(),
            quantity: formValue(data, 'amendment-quantity').trim(),
            rate: formValue(data, 'amendment-rate').trim(),
          });
          return;
        }
        const workItemId = formValue(data, 'amendment-item');
        if (kind === 'omit') {
          onProposeRemove({ workItemId, reason });
          return;
        }
        const quantity = formValue(data, 'amendment-quantity').trim();
        const rate = formValue(data, 'amendment-rate').trim();
        const description = formValue(data, 'amendment-description').trim();
        const unit = formValue(data, 'amendment-unit').trim();
        onProposeChange({
          workItemId,
          reason,
          changes: {
            ...(quantity.length > 0 ? { quantity } : {}),
            ...(rate.length > 0 ? { rate } : {}),
            ...(description.length > 0 ? { description } : {}),
            ...(unit.length > 0 ? { unit } : {}),
          },
        });
      }}
    >
      <h3>Propose an amendment</h3>
      <div className="field">
        <label htmlFor="amendment-kind">Amendment</label>
        <select
          id="amendment-kind"
          name="amendment-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as 'change' | 'omit' | 'add');
          }}
        >
          <option value="change">Change an item</option>
          <option value="omit">Omit an item</option>
          <option value="add">Add a new item</option>
        </select>
      </div>
      {kind !== 'add' && (
        <div className="field">
          <label htmlFor="amendment-item">Item to amend</label>
          <select id="amendment-item" name="amendment-item" required>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.itemNumber} — {item.description}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === 'add' && (
        <>
          <div className="field">
            <label htmlFor="amendment-schedule">Schedule</label>
            <select id="amendment-schedule" name="amendment-schedule" required>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.scheduleCode} — {schedule.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="amendment-item-number">Item number</label>
            <input
              id="amendment-item-number"
              name="amendment-item-number"
              required
              maxLength={100}
            />
          </div>
        </>
      )}
      {kind !== 'omit' && (
        <>
          <div className="field">
            <label htmlFor="amendment-quantity">
              {kind === 'add' ? 'Quantity' : 'New quantity (optional)'}
            </label>
            <input
              id="amendment-quantity"
              name="amendment-quantity"
              inputMode="decimal"
              required={kind === 'add'}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-rate">
              {kind === 'add' ? 'Rate (₹)' : 'New rate (₹, optional)'}
            </label>
            <input
              id="amendment-rate"
              name="amendment-rate"
              inputMode="decimal"
              required={kind === 'add'}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-description">
              {kind === 'add' ? 'Description' : 'New description (optional)'}
            </label>
            <input
              id="amendment-description"
              name="amendment-description"
              required={kind === 'add'}
              maxLength={4000}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-unit">
              {kind === 'add' ? 'Unit' : 'New unit (optional)'}
            </label>
            <input
              id="amendment-unit"
              name="amendment-unit"
              required={kind === 'add'}
              maxLength={20}
            />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="amendment-reason">Reason</label>
        <input
          id="amendment-reason"
          name="amendment-reason"
          required
          minLength={3}
          maxLength={2000}
        />
      </div>
      <div className="actions">
        <button type="submit" disabled={pending}>
          Submit amendment
        </button>
      </div>
    </form>
  );
}
