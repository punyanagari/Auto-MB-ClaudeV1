import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { DataTable } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';

interface ApprovalsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly currentUserId: string;
  readonly canApprove: boolean;
  /** Called after any decision so the caller can refresh the nav badge. */
  readonly onChanged: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  quantity: 'Quantity',
  rate: 'Rate (₹)',
  description: 'Description',
  unit: 'Unit',
  item: 'Item number',
  challanDate: 'Challan date',
  prefix: 'Number prefix',
  consignee: 'Consignee',
  items: 'Lines',
  lines: 'Lines',
  movementType: 'Movement type',
  issuedToName: 'Issued to',
  issuedToRole: 'Issued-to role',
  location: 'Location',
  remarks: 'Remarks',
  statement: 'Correction statement',
};

const TYPE_LABELS: Record<ApprovalRequest['entityType'], string> = {
  work_item_amendment: 'Item amendment',
  challan_cancel_replace: 'Challan cancel & replace',
  issue_challan_cancel_replace: 'Issue Challan cancel & replace',
  challan_correction_notice: 'Correction notice',
};

/** One pending request: diff rendering plus the decision controls. */
function ApprovalCard({
  approval,
  currentUserId,
  canApprove,
  pending,
  onApprove,
  onReject,
  onWithdraw,
}: {
  readonly approval: ApprovalRequest;
  readonly currentUserId: string;
  readonly canApprove: boolean;
  readonly pending: boolean;
  readonly onApprove: (note: string) => void;
  readonly onReject: (note: string) => void;
  readonly onWithdraw: () => void;
}) {
  const [note, setNote] = useState('');
  const isRequester = approval.requestedByUserId === currentUserId;
  return (
    <article
      className="rounded-xl border border-border bg-card p-5 shadow-sm print:border-0 print:p-0 print:shadow-none"
      aria-label={`${TYPE_LABELS[approval.entityType]} for ${approval.workCode}`}
    >
      <h2>
        {approval.workCode}
        {approval.itemNumber !== null && (
          <span className="text-muted-foreground"> · item {approval.itemNumber}</span>
        )}
        {approval.documentNumber != null && approval.documentNumber.length > 0 && (
          <span className="text-muted-foreground"> · {approval.documentNumber}</span>
        )}
      </h2>
      <p className="text-muted-foreground">{TYPE_LABELS[approval.entityType]}</p>
      <p>{approval.reason}</p>
      <p className="text-muted-foreground">
        Requested by {isRequester ? 'you' : approval.requestedByUserId}
      </p>
      <DataTable>
        <caption className="sr-only">
          Proposed changes for {approval.workCode}
          {approval.itemNumber !== null ? ` item ${approval.itemNumber}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Current</th>
            <th scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {approval.diff.map((entry) => (
            <tr key={entry.field}>
              <th scope="row">{FIELD_LABELS[entry.field] ?? entry.field}</th>
              <td>{entry.before ?? '—'}</td>
              <td>
                <strong>{entry.after ?? '—'}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {canApprove && (
        <Field>
          <label htmlFor={`decision-note-${approval.id}`}>
            Decision note (required to reject)
          </label>
          <input
            id={`decision-note-${approval.id}`}
            value={note}
            maxLength={1000}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
      )}
      <Actions>
        {canApprove && (
          <>
            <Button
              disabled={pending}
              onClick={() => {
                onApprove(note.trim());
              }}
            >
              Approve and apply
            </Button>
            <Button
              variant="outline"
              disabled={pending || note.trim().length < 3}
              onClick={() => {
                onReject(note.trim());
              }}
            >
              Reject
            </Button>
          </>
        )}
        {isRequester && (
          <Button variant="outline" disabled={pending} onClick={onWithdraw}>
            Withdraw
          </Button>
        )}
      </Actions>
    </article>
  );
}

/** The approvals queue: pending amendment requests awaiting a decision.
 * Approving applies the change atomically; a failed apply (e.g. the
 * delivered quantity moved) leaves the request pending with the server's
 * explanation shown. */
export function Approvals({
  api,
  organisationId,
  currentUserId,
  canApprove,
  onChanged,
}: ApprovalsProps) {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    const loaded = await api.listApprovals(organisationId, 'pending');
    setApprovals(loaded);
  }, [api, organisationId]);

  useEffect(() => {
    let cancelled = false;
    setApprovals(null);
    setLoadError(null);
    api
      .listApprovals(organisationId, 'pending')
      .then((loaded) => {
        if (!cancelled) setApprovals(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The approvals queue could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  async function act(work: () => Promise<void>, done: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      await reload();
      setNotice(done);
      onChanged();
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The decision failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full" aria-labelledby="approvals-title">
      <h1 id="approvals-title" tabIndex={-1}>
        Approvals
      </h1>
      <p className="text-muted-foreground">
        Pending amendment and correction requests. Approving applies the change
        immediately; original awarded values and issued snapshots are never overwritten.
      </p>

      {loadError !== null && <FormError>{loadError}</FormError>}
      {approvals === null && loadError === null && (
        <p className="text-muted-foreground" role="status">
          Loading approvals…
        </p>
      )}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      {approvals !== null && approvals.length === 0 && (
        <p className="text-muted-foreground">Nothing is waiting for a decision.</p>
      )}
      {approvals !== null &&
        approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            currentUserId={currentUserId}
            canApprove={canApprove}
            pending={pending}
            onApprove={(note) => {
              void act(async () => {
                await api.approveAmendment(
                  organisationId,
                  approval.id,
                  note.length >= 3 ? note : undefined,
                );
              }, `Amendment for ${approval.workCode} approved and applied.`);
            }}
            onReject={(note) => {
              void act(async () => {
                await api.rejectAmendment(organisationId, approval.id, note);
              }, `Amendment for ${approval.workCode} rejected.`);
            }}
            onWithdraw={() => {
              void act(async () => {
                await api.withdrawAmendment(organisationId, approval.id);
              }, `Your request for ${approval.workCode} was withdrawn.`);
            }}
          />
        ))}
    </Card>
  );
}
