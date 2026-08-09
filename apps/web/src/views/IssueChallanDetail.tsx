import { useCallback, useEffect, useState } from 'react';
import type { IssueChallanDetailResponse } from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';

/** True when the Work's approval list carries a pending cancel-and-replace
 * request for THIS Issue Challan — surfaced instead of the correction form
 * so a second filing is not invited only to bounce off PENDING_EXISTS. */
async function findPendingCorrection(
  api: ApiClient,
  organisationId: string,
  workId: string,
  challanId: string,
): Promise<boolean> {
  const approvals = await api.listWorkAmendments(organisationId, workId);
  return approvals.some(
    (approval) =>
      approval.status === 'pending' &&
      approval.entityType === 'issue_challan_cancel_replace' &&
      approval.entityId === challanId,
  );
}

interface IssueChallanDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly challanId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly onEdit: (challanId: string) => void;
  readonly onDeleted: () => void;
  readonly onBack: () => void;
}

const MOVEMENT_LABELS = {
  issue: 'Issue',
  loan: 'Loan (returnable)',
  return: 'Return',
} as const;

function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Give the new tab time to load the blob before the URL is revoked.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

export function IssueChallanDetail({
  api,
  organisationId,
  challanId,
  canModify,
  canIssue,
  canCancel,
  onEdit,
  onDeleted,
  onBack,
}: IssueChallanDetailProps) {
  const [detail, setDetail] = useState<IssueChallanDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [hasPendingCorrection, setHasPendingCorrection] = useState(false);

  const reload = useCallback(() => {
    setLoadError(null);
    api
      .getIssueChallan(organisationId, challanId)
      .then(async (loaded) => {
        setDetail(loaded);
        setHasPendingCorrection(
          loaded.issueChallan.status === 'issued' &&
            (await findPendingCorrection(
              api,
              organisationId,
              loaded.issueChallan.workId,
              loaded.issueChallan.id,
            )),
        );
      })
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Issue Challan could not be loaded.',
        );
      });
  }, [api, organisationId, challanId]);

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  async function act(
    work: () => Promise<IssueChallanDetailResponse | null>,
    done: string,
  ) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await work();
      if (updated !== null) setDetail(updated);
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <section className="card" aria-labelledby="issue-challan-title">
        <h1 id="issue-challan-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (detail === null) {
    return (
      <section className="card" aria-labelledby="issue-challan-title">
        <h1 id="issue-challan-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="muted" role="status">
          Loading Issue Challan…
        </p>
      </section>
    );
  }

  const { issueChallan, lines } = detail;

  return (
    <section className="card card--wide" aria-labelledby="issue-challan-title">
      <h1 id="issue-challan-title" tabIndex={-1}>
        {issueChallan.status === 'draft'
          ? 'Draft Issue Challan'
          : `Issue Challan ${issueChallan.challanNumber ?? ''}`}
      </h1>
      <dl className="fact-list">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`chip chip--${issueChallan.status}`}>
              {issueChallan.status}
            </span>
          </dd>
        </div>
        <div>
          <dt>Movement</dt>
          <dd>{MOVEMENT_LABELS[issueChallan.movementType]}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{issueChallan.challanDate}</dd>
        </div>
        <div>
          <dt>Issued to</dt>
          <dd>
            {issueChallan.issuedToName}
            {issueChallan.issuedToRole !== null && (
              <>
                <br />
                <span className="muted">{issueChallan.issuedToRole}</span>
              </>
            )}
            {issueChallan.location !== null && (
              <>
                <br />
                <span className="muted">{issueChallan.location}</span>
              </>
            )}
          </dd>
        </div>
        {issueChallan.remarks !== null && (
          <div>
            <dt>Remarks</dt>
            <dd>{issueChallan.remarks}</dd>
          </div>
        )}
        {issueChallan.issuedAt !== null && (
          <div>
            <dt>Issued</dt>
            <dd>{issueChallan.issuedAt.slice(0, 10)}</dd>
          </div>
        )}
      </dl>

      {issueChallan.movementType !== 'issue' && (
        <p className="form-notice" role="note">
          {issueChallan.movementType === 'loan'
            ? 'Loan movement: the material is returnable.'
            : 'Return movement: the material goes back to its origin.'}
        </p>
      )}

      {issueChallan.status === 'cancelled' &&
        issueChallan.cancellationNote !== null && (
          <p className="form-error" role="note">
            Cancelled: {issueChallan.cancellationNote}
          </p>
        )}

      <table className="data-table">
        <caption className="visually-hidden">Issue Challan lines</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th scope="col">Unit</th>
            <th scope="col" className="cell--numeric">
              Quantity
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <th scope="row">{line.position}</th>
              <td>{line.itemNumber ?? 'Manual'}</td>
              <td className="cell--wrap">{line.description}</td>
              <td>{line.unit}</td>
              <td className="cell--numeric">{line.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>

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

      <div className="actions">
        {issueChallan.status === 'draft' && canModify && (
          <>
            <button
              type="button"
              className="button--ghost"
              onClick={() => {
                onEdit(issueChallan.id);
              }}
            >
              Edit draft
            </button>
            <button
              type="button"
              className="button--ghost"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  await api.deleteIssueChallan(organisationId, issueChallan.id);
                  onDeleted();
                  return null;
                }, 'Draft deleted.')
              }
            >
              Delete draft
            </button>
          </>
        )}
        {issueChallan.status === 'draft' && canIssue && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void act(
                () => api.issueIssueChallan(organisationId, issueChallan.id),
                'Issue Challan issued.',
              )
            }
          >
            {pending ? 'Working…' : 'Issue challan'}
          </button>
        )}
        {issueChallan.status === 'issued' && canModify && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void act(
                () => api.renderIssueChallan(organisationId, issueChallan.id),
                'PDF generated.',
              )
            }
          >
            {issueChallan.renderedAvailable ? 'Re-generate PDF' : 'Generate PDF'}
          </button>
        )}
        {issueChallan.renderedAvailable && (
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                openPdf(
                  await api.downloadIssueChallanPdf(
                    organisationId,
                    issueChallan.id,
                    'rendered',
                  ),
                );
                return null;
              }, 'PDF opened in a new tab.')
            }
          >
            Open PDF
          </button>
        )}
        {issueChallan.signedCopyAvailable && (
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                openPdf(
                  await api.downloadIssueChallanPdf(
                    organisationId,
                    issueChallan.id,
                    'signed',
                  ),
                );
                return null;
              }, 'Signed copy opened in a new tab.')
            }
          >
            Open signed copy
          </button>
        )}
        <button type="button" className="button--ghost" onClick={onBack}>
          Back to Work
        </button>
      </div>

      {issueChallan.status === 'issued' && canModify && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem('issue-signed-file');
            const file =
              input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
            if (file === null) {
              setActionError('Choose the scanned signed copy first.');
              return;
            }
            void act(
              () =>
                api.uploadIssueChallanSignedCopy(organisationId, issueChallan.id, file),
              'Signed copy uploaded.',
            );
          }}
        >
          <h2>Signed copy</h2>
          <div className="field">
            <label htmlFor="issue-signed-file">Scanned signed copy (PDF)</label>
            <input
              id="issue-signed-file"
              name="issue-signed-file"
              type="file"
              accept="application/pdf"
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Upload signed copy
            </button>
          </div>
        </form>
      )}

      {issueChallan.status === 'issued' && canModify && hasPendingCorrection && (
        <>
          <h2>Request correction</h2>
          <p className="muted" role="note">
            A correction request for this Issue Challan is already awaiting a decision
            in the approvals queue.
          </p>
        </>
      )}

      {issueChallan.status === 'issued' && canModify && !hasPendingCorrection && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const role = formValue(data, 'ic-correction-role').trim();
            const location = formValue(data, 'ic-correction-location').trim();
            const remarks = formValue(data, 'ic-correction-remarks').trim();
            void act(async () => {
              await api.proposeIssueChallanCancelReplace(
                organisationId,
                issueChallan.id,
                {
                  reason: formValue(data, 'ic-correction-reason'),
                  replacement: {
                    challanDate: formValue(data, 'ic-correction-date'),
                    movementType: issueChallan.movementType,
                    issuedToName: formValue(data, 'ic-correction-name'),
                    ...(role.length > 0 ? { issuedToRole: role } : {}),
                    ...(location.length > 0 ? { location } : {}),
                    ...(remarks.length > 0 ? { remarks } : {}),
                    lines: lines.map((line) =>
                      line.workItemId !== null
                        ? {
                            workItemId: line.workItemId,
                            quantity: formValue(data, `ic-correction-qty-${line.id}`),
                          }
                        : {
                            description: line.description,
                            unit: line.unit,
                            quantity: formValue(data, `ic-correction-qty-${line.id}`),
                          },
                    ),
                  },
                },
              );
              reload();
              return null;
            }, 'Correction requested: on approval this Issue Challan is cancelled and a corrected draft is created.');
          }}
        >
          <h2>Request correction</h2>
          <p className="muted">
            Issue Challans carry no downstream evidence, so the lawful correction path
            is <strong>cancel and replace</strong>: on approval the issued challan is
            cancelled (its number stays in the series) and a corrected draft is created
            for re-issue.
          </p>
          <div className="field">
            <label htmlFor="ic-correction-date">Corrected challan date</label>
            <input
              id="ic-correction-date"
              name="ic-correction-date"
              type="date"
              defaultValue={issueChallan.challanDate}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ic-correction-name">Issued to</label>
            <input
              id="ic-correction-name"
              name="ic-correction-name"
              defaultValue={issueChallan.issuedToName}
              required
              minLength={2}
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="ic-correction-role">Issued-to role (optional)</label>
            <input
              id="ic-correction-role"
              name="ic-correction-role"
              defaultValue={issueChallan.issuedToRole ?? ''}
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="ic-correction-location">Location (optional)</label>
            <input
              id="ic-correction-location"
              name="ic-correction-location"
              defaultValue={issueChallan.location ?? ''}
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="ic-correction-remarks">Remarks (optional)</label>
            <input
              id="ic-correction-remarks"
              name="ic-correction-remarks"
              defaultValue={issueChallan.remarks ?? ''}
              maxLength={1000}
            />
          </div>
          {lines.map((line) => (
            <div className="field" key={line.id}>
              <label htmlFor={`ic-correction-qty-${line.id}`}>
                Quantity — {line.description}
              </label>
              <input
                id={`ic-correction-qty-${line.id}`}
                name={`ic-correction-qty-${line.id}`}
                defaultValue={line.quantity}
                required
                inputMode="decimal"
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="ic-correction-reason">Reason for correction</label>
            <input
              id="ic-correction-reason"
              name="ic-correction-reason"
              required
              minLength={3}
              maxLength={2000}
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Request cancel &amp; replace
            </button>
          </div>
        </form>
      )}

      {issueChallan.status === 'issued' && canCancel && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                api.cancelIssueChallan(organisationId, issueChallan.id, {
                  note: cancelNote,
                }),
              'Issue Challan cancelled.',
            );
          }}
        >
          <h2>Cancel this challan</h2>
          <div className="field">
            <label htmlFor="issue-cancel-note">Cancellation note</label>
            <input
              id="issue-cancel-note"
              value={cancelNote}
              onChange={(event) => {
                setCancelNote(event.target.value);
              }}
              required
              minLength={3}
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Cancel challan
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
