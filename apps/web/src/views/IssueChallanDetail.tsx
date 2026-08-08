import { useCallback, useEffect, useState } from 'react';
import type { IssueChallanDetailResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

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

  const reload = useCallback(() => {
    setLoadError(null);
    api
      .getIssueChallan(organisationId, challanId)
      .then((loaded) => {
        setDetail(loaded);
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
