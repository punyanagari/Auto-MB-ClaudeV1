import { useCallback, useEffect, useState } from 'react';
import type { ChallanDetailResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';

interface ChallanDetailProps {
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

function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Give the new tab time to load the blob before the URL is revoked.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

export function ChallanDetail({
  api,
  organisationId,
  challanId,
  canModify,
  canIssue,
  canCancel,
  onEdit,
  onDeleted,
  onBack,
}: ChallanDetailProps) {
  const [detail, setDetail] = useState<ChallanDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelNote, setCancelNote] = useState('');

  const reload = useCallback(() => {
    setLoadError(null);
    api
      .getChallan(organisationId, challanId)
      .then(setDetail)
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The challan could not be loaded.',
        );
      });
  }, [api, organisationId, challanId]);

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  async function act(work: () => Promise<ChallanDetailResponse | null>, done: string) {
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
      <section className="card" aria-labelledby="challan-title">
        <h1 id="challan-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (detail === null) {
    return (
      <section className="card" aria-labelledby="challan-title">
        <h1 id="challan-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="muted" role="status">
          Loading challan…
        </p>
      </section>
    );
  }

  const { challan, items } = detail;
  const total = items
    .reduce((sum, item) => sum + Number(item.lineAmount), 0)
    .toFixed(2);

  return (
    <section className="card card--wide" aria-labelledby="challan-title">
      <h1 id="challan-title" tabIndex={-1}>
        {challan.status === 'draft'
          ? 'Draft Delivery Challan'
          : `Delivery Challan ${challan.challanNumber ?? ''}`}
      </h1>
      <dl className="fact-list">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`chip chip--${challan.status}`}>{challan.status}</span>
          </dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{challan.challanDate}</dd>
        </div>
        <div>
          <dt>Consignee</dt>
          <dd>
            {challan.consignee.name}
            <br />
            <span className="muted">{challan.consignee.address}</span>
          </dd>
        </div>
        {challan.issuedAt !== null && (
          <div>
            <dt>Issued</dt>
            <dd>{challan.issuedAt.slice(0, 10)}</dd>
          </div>
        )}
      </dl>

      {challan.status === 'cancelled' && challan.cancellationNote !== null && (
        <p className="form-error" role="note">
          Cancelled: {challan.cancellationNote}
        </p>
      )}

      <table className="data-table">
        <caption className="visually-hidden">Challan line items</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Description</th>
            <th scope="col">Unit</th>
            <th scope="col">Quantity</th>
            <th scope="col" className="cell--numeric">
              Rate
            </th>
            <th scope="col" className="cell--numeric">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.position}</th>
              <td className="cell--wrap">{item.description}</td>
              <td>{item.unit}</td>
              <td className="cell--numeric">{item.quantity}</td>
              <td className="cell--numeric">{formatInr(item.rate)}</td>
              <td className="cell--numeric">{formatInr(item.lineAmount)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={5}>
              Total
            </th>
            <td className="cell--numeric">
              <strong>{formatInr(total)}</strong>
            </td>
          </tr>
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
        {challan.status === 'draft' && canModify && (
          <>
            <button
              type="button"
              className="button--ghost"
              onClick={() => {
                onEdit(challan.id);
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
                  await api.deleteChallan(organisationId, challan.id);
                  onDeleted();
                  return null;
                }, 'Draft deleted.')
              }
            >
              Delete draft
            </button>
          </>
        )}
        {challan.status === 'draft' && canIssue && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void act(
                () => api.issueChallan(organisationId, challan.id),
                'Challan issued.',
              )
            }
          >
            {pending ? 'Working…' : 'Issue challan'}
          </button>
        )}
        {challan.status === 'issued' && canModify && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void act(
                () => api.renderChallan(organisationId, challan.id),
                'PDF generated.',
              )
            }
          >
            {challan.renderedAvailable ? 'Re-generate PDF' : 'Generate PDF'}
          </button>
        )}
        {challan.renderedAvailable && (
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                openPdf(
                  await api.downloadChallanPdf(organisationId, challan.id, 'rendered'),
                );
                return null;
              }, 'PDF opened in a new tab.')
            }
          >
            Open PDF
          </button>
        )}
        {challan.signedCopyAvailable && (
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                openPdf(
                  await api.downloadChallanPdf(organisationId, challan.id, 'signed'),
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

      {challan.status === 'issued' && canModify && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem('signed-file');
            const file =
              input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
            if (file === null) {
              setActionError('Choose the scanned signed copy first.');
              return;
            }
            void act(
              () => api.uploadSignedCopy(organisationId, challan.id, file),
              'Signed copy uploaded.',
            );
          }}
        >
          <h2>Signed copy</h2>
          <div className="field">
            <label htmlFor="signed-file">Scanned signed copy (PDF)</label>
            <input
              id="signed-file"
              name="signed-file"
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

      {challan.status === 'issued' && canCancel && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () => api.cancelChallan(organisationId, challan.id, { note: cancelNote }),
              'Challan cancelled.',
            );
          }}
        >
          <h2>Cancel this challan</h2>
          <div className="field">
            <label htmlFor="cancel-note">Cancellation note</label>
            <input
              id="cancel-note"
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
