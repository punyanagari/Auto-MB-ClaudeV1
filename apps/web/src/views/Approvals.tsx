import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

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
      className="card"
      aria-label={`${TYPE_LABELS[approval.entityType]} for ${approval.workCode}`}
    >
      <h2>
        {approval.workCode}
        {approval.itemNumber !== null && (
          <span className="muted"> · item {approval.itemNumber}</span>
        )}
        {approval.documentNumber != null && approval.documentNumber.length > 0 && (
          <span className="muted"> · {approval.documentNumber}</span>
        )}
      </h2>
      <p className="muted">{TYPE_LABELS[approval.entityType]}</p>
      <p>{approval.reason}</p>
      <p className="muted">
        Requested by {isRequester ? 'you' : approval.requestedByUserId}
      </p>
      <table className="data-table">
        <caption className="visually-hidden">
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
      </table>
      {canApprove && (
        <div className="field">
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
        </div>
      )}
      <div className="actions">
        {canApprove && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                onApprove(note.trim());
              }}
            >
              Approve and apply
            </button>
            <button
              type="button"
              className="button--ghost"
              disabled={pending || note.trim().length < 3}
              onClick={() => {
                onReject(note.trim());
              }}
            >
              Reject
            </button>
          </>
        )}
        {isRequester && (
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={onWithdraw}
          >
            Withdraw
          </button>
        )}
      </div>
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
    <section className="card card--wide" aria-labelledby="approvals-title">
      <h1 id="approvals-title" tabIndex={-1}>
        Approvals
      </h1>
      <p className="muted">
        Pending amendment and correction requests. Approving applies the change
        immediately; original awarded values and issued snapshots are never overwritten.
      </p>

      {loadError !== null && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {approvals === null && loadError === null && (
        <p className="muted" role="status">
          Loading approvals…
        </p>
      )}
      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {approvals !== null && approvals.length === 0 && (
        <p className="muted">Nothing is waiting for a decision.</p>
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
    </section>
  );
}
