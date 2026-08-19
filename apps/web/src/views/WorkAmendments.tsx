import type {
  ApprovalRequest,
  SupersedeEligibilityResponse,
  WorkDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Field, Actions } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { NumericInput } from '../ui/numeric-input.js';

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
  /** Whether this Work may still be withdrawn and its letter read again
   * (migration 0071), and what stands in the way if not. Null when the
   * question could not be asked, in which case nothing is offered. */
  readonly supersede: SupersedeEligibilityResponse | null;
  /** Re-reads eligibility after a request is filed, so the form that filed
   * it disappears instead of inviting a 409. */
  readonly reloadSupersede: () => Promise<void>;
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
  supersede,
  reloadSupersede,
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
      // Eligibility moves with the queue: a filed supersede request, and
      // an approved amendment, both change what this Work may still do.
      reloadSupersede(),
    ]);
    setDetail(freshDetail);
    setAmendments(freshAmendments);
  };

  return (
    <>
      <h2>Amendments</h2>
      <p className="text-muted-foreground">
        Sanctioned changes to quantities, rates, descriptions, and items. The awarded
        LOA values are never overwritten; approved amendments apply as effective values
        shown beside the originals above.
      </p>
      {amendments.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Amendment requests for this Work</caption>
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
                <td className={wrapCell}>
                  {amendment.diff
                    .map(
                      (entry) =>
                        `${entry.field}: ${entry.before ?? '—'} → ${entry.after ?? '—'}`,
                    )
                    .join('; ')}
                </td>
                <td className={wrapCell}>{amendment.reason}</td>
                <td>
                  <StatusChip status={amendment.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No amendments proposed yet.</p>
      )}
      {canCreateDocuments && (
        <Disclosure label="New amendment" startOpen={amendments.length === 0}>
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
              }, 'Omission recorded. Cite the railway variation order against it on the Approvals screen; it cannot be approved until that order has been uploaded and verified.');
            }}
          />
        </Disclosure>
      )}
      {canCreateDocuments && supersede !== null && (
        <Disclosure label="Supersede this Work">
          <WorkSupersedePanel
            eligibility={supersede}
            pending={pending}
            onPropose={(reason) => {
              void act(async () => {
                await api.proposeWorkSupersede(organisationId, workId, { reason });
                await refresh();
              }, 'Supersede request recorded. It waits on the Approvals screen; approving it withdraws this Work and returns its letter to review.');
            }}
          />
        </Disclosure>
      )}
    </>
  );
}

/** The exit for a Work confirmed from a letter that was read wrongly.
 *
 * It is deliberately not an amendment: an amendment records that the
 * contract changed, and nothing changed here — the letter was always what
 * it says, and the Work is what got it wrong. So the panel states what
 * superseding does in full, and refuses to hide the fact that the Work
 * disappears from the register. Everything it says about eligibility comes
 * from the server, which re-checks it at proposal and again at approval. */
function WorkSupersedePanel({
  eligibility,
  pending,
  onPropose,
}: {
  readonly eligibility: SupersedeEligibilityResponse;
  readonly pending: boolean;
  readonly onPropose: (reason: string) => void;
}) {
  return (
    <>
      <p className="text-muted-foreground">
        Withdraws this Work and returns its LOA document to review, so the letter can be
        read again and confirmed in its place. Use it when the extracted values are
        wrong — the rates, the quantities — rather than when the railway has changed the
        contract. Nothing is withdrawn until an approver with the cancel authority
        approves the request.
      </p>
      <p className="text-muted-foreground">
        The Work confirmed in its place keeps this work code and letter number; it is
        the same contract. If the letter itself is unreadable, discard it and upload a
        clearer copy instead — the Work confirmed from that new upload starts a fresh
        record and is <strong>not</strong> linked back to this one, because the document
        the link is kept on was thrown away.
      </p>
      {eligibility.pendingRequestId !== null && (
        <p>A supersede request for this Work is already awaiting a decision.</p>
      )}
      {eligibility.loaDocumentId === null && (
        <p>
          This Work was not confirmed from an LOA document in this product, so there is
          no letter to read again. Correct it through an amendment instead.
        </p>
      )}
      {eligibility.blockers.length > 0 && (
        <>
          <p>
            This Work cannot be superseded — it already carries documents that depend on
            it. Correct it through an amendment or a correction notice.
          </p>
          <ul>
            {eligibility.blockers.map((blocker) => (
              <li key={blocker.register}>{blocker.label}</li>
            ))}
          </ul>
        </>
      )}
      {eligibility.eligible && eligibility.pendingRequestId === null && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            onPropose(formValue(data, 'supersede-reason').trim());
          }}
        >
          <Field>
            <label htmlFor="supersede-reason">Reason for superseding</label>
            <input
              id="supersede-reason"
              name="supersede-reason"
              required
              minLength={3}
              maxLength={2000}
            />
          </Field>
          <Actions>
            <Button type="submit" variant="destructive" disabled={pending}>
              Request supersede
            </Button>
          </Actions>
        </form>
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
 * would leave the item live, and R12 refuses zero quantities anyway.
 *
 * An omission is also the one amendment that never applies on filing,
 * however much authority the filer holds: it is a contractual variation,
 * and the railway's variation order must be uploaded and verified against
 * it first. The form therefore asks for nothing extra here — every fact
 * about the order is read from the order itself, on the Approvals
 * screen. */
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
      <Field>
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
      </Field>
      {kind !== 'add' && (
        <Field>
          <label htmlFor="amendment-item">Item to amend</label>
          <select id="amendment-item" name="amendment-item" required>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.itemNumber} — {item.description}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === 'add' && (
        <>
          <Field>
            <label htmlFor="amendment-schedule">Schedule</label>
            <select id="amendment-schedule" name="amendment-schedule" required>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.scheduleCode} — {schedule.title}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <label htmlFor="amendment-item-number">Item number</label>
            <input
              id="amendment-item-number"
              name="amendment-item-number"
              required
              maxLength={100}
            />
          </Field>
        </>
      )}
      {kind !== 'omit' && (
        <>
          <Field>
            <label htmlFor="amendment-quantity">
              {kind === 'add' ? 'Quantity' : 'New quantity (optional)'}
            </label>
            <NumericInput
              id="amendment-quantity"
              name="amendment-quantity"
              required={kind === 'add'}
            />
          </Field>
          <Field>
            <label htmlFor="amendment-rate">
              {kind === 'add' ? 'Rate (₹)' : 'New rate (₹, optional)'}
            </label>
            <NumericInput
              id="amendment-rate"
              name="amendment-rate"
              required={kind === 'add'}
            />
          </Field>
          <Field>
            <label htmlFor="amendment-description">
              {kind === 'add' ? 'Description' : 'New description (optional)'}
            </label>
            <input
              id="amendment-description"
              name="amendment-description"
              required={kind === 'add'}
              maxLength={4000}
            />
          </Field>
          <Field>
            <label htmlFor="amendment-unit">
              {kind === 'add' ? 'Unit' : 'New unit (optional)'}
            </label>
            <input
              id="amendment-unit"
              name="amendment-unit"
              required={kind === 'add'}
              maxLength={20}
            />
          </Field>
        </>
      )}
      <Field>
        <label htmlFor="amendment-reason">Reason</label>
        <input
          id="amendment-reason"
          name="amendment-reason"
          required
          minLength={3}
          maxLength={2000}
        />
      </Field>
      <Actions>
        <Button type="submit" disabled={pending}>
          Submit amendment
        </Button>
      </Actions>
    </form>
  );
}
