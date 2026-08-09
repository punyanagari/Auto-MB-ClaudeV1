import { useCallback, useEffect, useState } from 'react';
import type {
  ConsigneeMaster,
  PacCertificateListResponse,
  RecordPacCertificateRequest,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';

interface PacCertificatesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** PACs are railway-issued certificates recorded by office staff:
   * record and cancel run under owner/office. */
  readonly canModify: boolean;
  readonly workItems: readonly WorkItem[];
}

function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Give the new tab time to load the blob before the URL is revoked.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/**
 * PAC certificates (Milestone 8 phase 1, legacy §5.5 and rule R18): the
 * railway's provisional acceptance of installed quantities, recorded in
 * parts — reference, issue date, issuing consignee (designation
 * snapshotted from the picked master), per-item certified quantities
 * capped at installed minus already certified, optional scanned PDF.
 * Recorded certificates cancel with a note, releasing their quantities.
 */
export function PacCertificates({
  api,
  organisationId,
  workId,
  canModify,
  workItems,
}: PacCertificatesProps) {
  const [data, setData] = useState<PacCertificateListResponse | null>(null);
  const [consignees, setConsignees] = useState<readonly ConsigneeMaster[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    Promise.all([
      api.listWorkPacCertificates(organisationId, workId),
      api.listConsigneeMasters(organisationId).catch(() => []),
    ])
      .then(([loaded, loadedConsignees]) => {
        if (cancelled) return;
        setData(loaded);
        setConsignees(loadedConsignees);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The PAC certificates could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId]);

  const act = useCallback(async (work: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
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
  }, []);

  const refresh = useCallback(async () => {
    setData(await api.listWorkPacCertificates(organisationId, workId));
  }, [api, organisationId, workId]);

  if (loadError !== null) {
    return (
      <>
        <h2>PAC certificates</h2>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <h2>PAC certificates</h2>
        <p className="muted" role="status">
          Loading PAC certificates…
        </p>
      </>
    );
  }

  const summaryByItem = new Map(
    data.itemSummaries.map((summary) => [summary.workItemId, summary]),
  );

  return (
    <>
      <h2>PAC certificates</h2>
      <p className="muted">
        Railway certification of installed quantities, issued in parts. Per item the
        certified total can never exceed what installation records support; cancelling a
        certificate releases its quantities.
      </p>
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {notice !== null && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}

      <table className="data-table">
        <caption className="visually-hidden">
          PAC-certified quantity per item for this Work
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="cell--numeric">
              Installed
            </th>
            <th scope="col" className="cell--numeric">
              PAC certified
            </th>
            <th scope="col" className="cell--numeric">
              Available
            </th>
          </tr>
        </thead>
        <tbody>
          {data.itemSummaries.map((summary) => (
            <tr key={summary.workItemId}>
              <th scope="row">{summary.itemNumber}</th>
              <td className="cell--numeric">{summary.installedQuantity}</td>
              <td className="cell--numeric">{summary.pacCertifiedQuantity}</td>
              <td className="cell--numeric">{summary.availableQuantity}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.certificates.length > 0 ? (
        data.certificates.map((certificate) => (
          <div key={certificate.id} className="detail-block">
            <h3>
              PAC {certificate.reference} · {certificate.issueDate}
            </h3>
            <p className="muted">
              Issued by {certificate.consigneeDesignation} ·{' '}
              {certificate.status === 'cancelled' ? (
                <span className="chip chip--cancelled">cancelled</span>
              ) : (
                <span className="chip chip--installed">recorded</span>
              )}
              {certificate.cancellationNote !== null && (
                <span className="muted"> {certificate.cancellationNote}</span>
              )}
            </p>
            <table className="data-table">
              <caption className="visually-hidden">
                Certified quantities on PAC {certificate.reference}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="cell--numeric">
                    Certified quantity
                  </th>
                  <th scope="col" className="cell--numeric">
                    Released value
                  </th>
                </tr>
              </thead>
              <tbody>
                {certificate.items.map((line) => (
                  <tr key={line.workItemId}>
                    <th scope="row">{line.itemNumber}</th>
                    <td className="cell--numeric">{line.certifiedQuantity}</td>
                    <td className="cell--numeric">{line.releasedValue ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="actions">
              {certificate.documentAvailable && (
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      openPdf(
                        await api.downloadPacCertificateDocument(
                          organisationId,
                          certificate.id,
                        ),
                      );
                    }, 'Scanned certificate opened in a new tab.')
                  }
                >
                  Open scanned certificate
                </button>
              )}
            </div>
            {canModify && certificate.status === 'recorded' && (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const input =
                      event.currentTarget.elements.namedItem('pac-document');
                    const file =
                      input instanceof HTMLInputElement
                        ? (input.files?.[0] ?? null)
                        : null;
                    if (file === null) {
                      setActionError('Choose the scanned certificate first.');
                      return;
                    }
                    void act(async () => {
                      await api.uploadPacCertificateDocument(
                        organisationId,
                        certificate.id,
                        file,
                      );
                      await refresh();
                    }, 'Scanned certificate uploaded.');
                  }}
                >
                  <div className="field">
                    <label htmlFor={`pac-document-${certificate.id}`}>
                      Scanned certificate (PDF) for {certificate.reference}
                    </label>
                    <input
                      id={`pac-document-${certificate.id}`}
                      name="pac-document"
                      type="file"
                      accept="application/pdf"
                    />
                  </div>
                  <div className="actions">
                    <button type="submit" className="button--ghost" disabled={pending}>
                      Upload scanned certificate
                    </button>
                  </div>
                </form>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const note = formValue(
                      new FormData(event.currentTarget),
                      `pac-cancel-note-${certificate.id}`,
                    ).trim();
                    void act(async () => {
                      await api.cancelPacCertificate(
                        organisationId,
                        certificate.id,
                        note,
                      );
                      await refresh();
                    }, 'PAC certificate cancelled; its certified quantities are released.');
                  }}
                >
                  <div className="field">
                    <label htmlFor={`pac-cancel-note-${certificate.id}`}>
                      Cancellation note for PAC {certificate.reference}
                    </label>
                    <input
                      id={`pac-cancel-note-${certificate.id}`}
                      name={`pac-cancel-note-${certificate.id}`}
                      required
                      minLength={3}
                      maxLength={1000}
                    />
                  </div>
                  <button type="submit" className="button--ghost" disabled={pending}>
                    Cancel certificate
                  </button>
                </form>
              </>
            )}
          </div>
        ))
      ) : (
        <p className="muted">No PAC certificates recorded yet.</p>
      )}

      {canModify && workItems.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const formData = new FormData(form);
            const items = workItems
              .map((item) => ({
                workItemId: item.id,
                certifiedQuantity: formValue(formData, `pac-qty-${item.id}`).trim(),
              }))
              .filter((line) => line.certifiedQuantity.length > 0);
            if (items.length === 0) {
              setActionError('Enter a certified quantity for at least one item.');
              return;
            }
            const body: RecordPacCertificateRequest = {
              reference: formValue(formData, 'pac-reference').trim(),
              issueDate: formValue(formData, 'pac-date'),
              consigneeMasterId: formValue(formData, 'pac-consignee'),
              items,
            };
            void act(async () => {
              await api.recordWorkPacCertificate(organisationId, workId, body);
              await refresh();
              form.reset();
            }, 'PAC certificate recorded.');
          }}
        >
          <h3>Record PAC certificate</h3>
          <div className="field">
            <label htmlFor="pac-reference">Certificate reference</label>
            <input
              id="pac-reference"
              name="pac-reference"
              required
              minLength={1}
              maxLength={100}
            />
          </div>
          <div className="field">
            <label htmlFor="pac-date">Issue date</label>
            <input id="pac-date" name="pac-date" type="date" required />
          </div>
          <div className="field">
            <label htmlFor="pac-consignee">Issuing consignee</label>
            <select id="pac-consignee" name="pac-consignee" required>
              {consignees.map((consignee) => (
                <option key={consignee.id} value={consignee.id}>
                  {consignee.designation}
                  {consignee.address !== null ? ` — ${consignee.address}` : ''}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend>
              Certified quantities — leave an item blank to omit it; each entry is
              capped at installed minus already certified
            </legend>
            {workItems.map((item) => {
              const summary = summaryByItem.get(item.id);
              return (
                <div className="field" key={item.id}>
                  <label htmlFor={`pac-qty-${item.id}`}>
                    {item.itemNumber} — {item.effectiveDescription ?? item.description}
                    {summary !== undefined
                      ? ` (installed ${summary.installedQuantity}, certified ${summary.pacCertifiedQuantity}, available ${summary.availableQuantity})`
                      : ''}
                  </label>
                  <input
                    id={`pac-qty-${item.id}`}
                    name={`pac-qty-${item.id}`}
                    inputMode="decimal"
                  />
                </div>
              );
            })}
          </fieldset>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Record PAC certificate
            </button>
          </div>
        </form>
      )}
    </>
  );
}
