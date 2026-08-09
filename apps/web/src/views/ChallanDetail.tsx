import { useCallback, useEffect, useState } from 'react';
import type {
  ChallanDetailResponse,
  CorrectionEligibilityResponse,
  CorrectionNotice,
  Receipt,
  Serial,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Timeline } from './Timeline.js';

interface ChallanDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly challanId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly canRecordEvidence: boolean;
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
  canRecordEvidence,
  onEdit,
  onDeleted,
  onBack,
}: ChallanDetailProps) {
  const [detail, setDetail] = useState<ChallanDetailResponse | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [serials, setSerials] = useState<readonly Serial[] | null>(null);
  const [eligibility, setEligibility] = useState<CorrectionEligibilityResponse | null>(
    null,
  );
  const [notices, setNotices] = useState<readonly CorrectionNotice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelNote, setCancelNote] = useState('');

  const reload = useCallback(() => {
    setLoadError(null);
    api
      .getChallan(organisationId, challanId)
      .then(async (loaded) => {
        // Delivery evidence only exists once the challan is issued.
        if (loaded.challan.status === 'issued') {
          const [loadedReceipt, workSerials, loadedEligibility, loadedNotices] =
            await Promise.all([
              api.getReceipt(organisationId, challanId),
              api.listWorkSerials(organisationId, loaded.challan.workId),
              api.challanCorrectionEligibility(organisationId, challanId),
              api.listChallanCorrectionNotices(organisationId, challanId),
            ]);
          setReceipt(loadedReceipt);
          setSerials(workSerials.filter((s) => s.deliveryChallanId === challanId));
          setEligibility(loadedEligibility);
          setNotices(loadedNotices);
        } else if (loaded.challan.status === 'cancelled') {
          setReceipt(null);
          setSerials(null);
          setEligibility(null);
          setNotices(await api.listChallanCorrectionNotices(organisationId, challanId));
        } else {
          setReceipt(null);
          setSerials(null);
          setEligibility(null);
          setNotices([]);
        }
        setDetail(loaded);
      })
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
  const uninstalled = (serials ?? []).filter((s) => s.installedOn === null);

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
        {challan.status !== 'draft' && (
          <div>
            <dt>Warranty certificate</dt>
            <dd>
              {challan.warrantyTemplateVersion != null
                ? `Included (template ${challan.warrantyTemplateVersion})`
                : 'Not included'}
            </dd>
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
              <td className="cell--numeric">{formatRate(item.rate)}</td>
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

      {challan.status === 'issued' && (
        <>
          <h2>Delivery receipt</h2>
          {receipt !== null ? (
            <dl className="fact-list">
              <div>
                <dt>Received on</dt>
                <dd>{receipt.receivedOn}</dd>
              </div>
              <div>
                <dt>Received by</dt>
                <dd>{receipt.receivedBy}</dd>
              </div>
              {receipt.remarks !== null && (
                <div>
                  <dt>Remarks</dt>
                  <dd>{receipt.remarks}</dd>
                </div>
              )}
            </dl>
          ) : canRecordEvidence ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const receivedOn = formValue(data, 'receipt-date');
                const receivedBy = formValue(data, 'receipt-by');
                const remarks = formValue(data, 'receipt-remarks').trim();
                void act(async () => {
                  const recorded = await api.recordReceipt(organisationId, challan.id, {
                    receivedOn,
                    receivedBy,
                    ...(remarks.length > 0 ? { remarks } : {}),
                  });
                  setReceipt(recorded);
                  return null;
                }, 'Receipt recorded.');
              }}
            >
              <p className="muted">
                Record the consignee&apos;s acknowledgement of this delivery.
              </p>
              <div className="field">
                <label htmlFor="receipt-date">Received on</label>
                <input id="receipt-date" name="receipt-date" type="date" required />
              </div>
              <div className="field">
                <label htmlFor="receipt-by">Received by</label>
                <input
                  id="receipt-by"
                  name="receipt-by"
                  required
                  minLength={2}
                  maxLength={200}
                />
              </div>
              <div className="field">
                <label htmlFor="receipt-remarks">Remarks (optional)</label>
                <input id="receipt-remarks" name="receipt-remarks" maxLength={1000} />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Record receipt
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">No receipt recorded yet.</p>
          )}

          <h2>Serial numbers</h2>
          {serials !== null && serials.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Serial numbers recorded against this challan
              </caption>
              <thead>
                <tr>
                  <th scope="col">Serial</th>
                  <th scope="col">Item</th>
                  <th scope="col">Installation</th>
                </tr>
              </thead>
              <tbody>
                {serials.map((serial) => (
                  <tr key={serial.id}>
                    <th scope="row">{serial.serialNumber}</th>
                    <td className="cell--wrap">{serial.itemDescription}</td>
                    <td>
                      {serial.installedOn !== null ? (
                        <span className="chip chip--installed">
                          installed {serial.installedOn}
                        </span>
                      ) : (
                        <span className="muted">not installed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No serial numbers recorded yet.</p>
          )}

          {canRecordEvidence && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const challanItemId = formValue(data, 'serial-line');
                const serialNumbers = formValue(data, 'serial-numbers')
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0);
                if (challanItemId === '' || serialNumbers.length === 0) {
                  setActionError('Choose a line and enter at least one serial number.');
                  return;
                }
                void act(async () => {
                  const updated = await api.recordSerials(organisationId, challan.id, {
                    challanItemId,
                    serialNumbers,
                  });
                  setSerials(updated.filter((s) => s.deliveryChallanId === challan.id));
                  form.reset();
                  return null;
                }, 'Serial numbers recorded.');
              }}
            >
              <h3>Record serial numbers</h3>
              <div className="field">
                <label htmlFor="serial-line">Challan line</label>
                <select id="serial-line" name="serial-line" required>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.position}. {item.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="serial-numbers">Serial numbers (one per line)</label>
                <textarea id="serial-numbers" name="serial-numbers" rows={4} required />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Record serials
                </button>
              </div>
            </form>
          )}

          {canRecordEvidence && uninstalled.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const serialId = formValue(data, 'install-serial');
                const installedOn = formValue(data, 'install-date');
                const remarks = formValue(data, 'install-remarks').trim();
                void act(async () => {
                  const updated = await api.recordInstallation(
                    organisationId,
                    serialId,
                    {
                      installedOn,
                      ...(remarks.length > 0 ? { remarks } : {}),
                    },
                  );
                  setSerials(updated.filter((s) => s.deliveryChallanId === challan.id));
                  form.reset();
                  return null;
                }, 'Installation recorded.');
              }}
            >
              <h3>Record installation</h3>
              <div className="field">
                <label htmlFor="install-serial">Serial</label>
                <select id="install-serial" name="install-serial" required>
                  {uninstalled.map((serial) => (
                    <option key={serial.id} value={serial.id}>
                      {serial.serialNumber}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="install-date">Installed on</label>
                <input id="install-date" name="install-date" type="date" required />
              </div>
              <div className="field">
                <label htmlFor="install-remarks">Remarks (optional)</label>
                <input id="install-remarks" name="install-remarks" maxLength={1000} />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Record installation
                </button>
              </div>
            </form>
          )}
        </>
      )}

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

      {notices.length > 0 && (
        <>
          <h2>Correction notices</h2>
          <table className="data-table">
            <caption className="visually-hidden">
              Correction notices issued against this challan
            </caption>
            <thead>
              <tr>
                <th scope="col">Notice</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">PDF</th>
              </tr>
            </thead>
            <tbody>
              {notices.map((notice) => (
                <tr key={notice.id}>
                  <th scope="row">{notice.noticeNumber}</th>
                  <td>
                    <span className={`chip chip--${notice.status}`}>
                      {notice.status}
                    </span>
                  </td>
                  <td>{notice.createdAt.slice(0, 10)}</td>
                  <td>
                    {notice.renderedAvailable ? (
                      <button
                        type="button"
                        className="button--ghost"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            openPdf(
                              await api.downloadCorrectionNoticePdf(
                                organisationId,
                                notice.id,
                              ),
                            );
                            return null;
                          }, 'Correction notice PDF opened in a new tab.')
                        }
                      >
                        Open PDF
                      </button>
                    ) : canModify ? (
                      <button
                        type="button"
                        className="button--ghost"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            await api.renderCorrectionNotice(organisationId, notice.id);
                            reload();
                            return null;
                          }, 'Correction notice PDF generated.')
                        }
                      >
                        Generate PDF
                      </button>
                    ) : (
                      <span className="muted">not rendered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {challan.status === 'issued' && canModify && eligibility !== null && (
        <>
          <h2>Request correction</h2>
          {eligibility.pendingRequestId !== null ? (
            <p className="muted" role="note">
              A correction request for this challan is already awaiting a decision in
              the approvals queue.
            </p>
          ) : eligibility.path === 'cancel_replace' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const reason = formValue(data, 'correction-reason');
                const phone = formValue(data, 'correction-consignee-phone').trim();
                void act(async () => {
                  await api.proposeChallanCancelReplace(organisationId, challan.id, {
                    reason,
                    replacement: {
                      challanDate: formValue(data, 'correction-date'),
                      prefix: challan.prefix,
                      consignee: {
                        name: formValue(data, 'correction-consignee-name'),
                        address: formValue(data, 'correction-consignee-address'),
                        ...(phone.length > 0 ? { phone } : {}),
                      },
                      items: items.map((item) => ({
                        workItemId: item.workItemId,
                        quantity: formValue(data, `correction-qty-${item.workItemId}`),
                      })),
                    },
                  });
                  reload();
                  return null;
                }, 'Correction requested: on approval this challan is cancelled and a corrected draft is created.');
              }}
            >
              <p className="muted">
                This challan has no recorded receipt, serials, or measurements, so the
                lawful correction path is <strong>cancel and replace</strong>: on
                approval the issued challan is cancelled (its number stays in the
                series) and a corrected draft is created for re-issue.
              </p>
              <div className="field">
                <label htmlFor="correction-date">Corrected challan date</label>
                <input
                  id="correction-date"
                  name="correction-date"
                  type="date"
                  defaultValue={challan.challanDate}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="correction-consignee-name">Consignee name</label>
                <input
                  id="correction-consignee-name"
                  name="correction-consignee-name"
                  defaultValue={challan.consignee.name}
                  required
                  minLength={2}
                  maxLength={200}
                />
              </div>
              <div className="field">
                <label htmlFor="correction-consignee-address">Consignee address</label>
                <input
                  id="correction-consignee-address"
                  name="correction-consignee-address"
                  defaultValue={challan.consignee.address}
                  required
                  minLength={3}
                  maxLength={1000}
                />
              </div>
              <div className="field">
                <label htmlFor="correction-consignee-phone">
                  Consignee phone (optional)
                </label>
                <input
                  id="correction-consignee-phone"
                  name="correction-consignee-phone"
                  defaultValue={challan.consignee.phone ?? ''}
                  maxLength={30}
                />
              </div>
              {items.map((item) => (
                <div className="field" key={item.workItemId}>
                  <label htmlFor={`correction-qty-${item.workItemId}`}>
                    Quantity — {item.description}
                  </label>
                  <input
                    id={`correction-qty-${item.workItemId}`}
                    name={`correction-qty-${item.workItemId}`}
                    defaultValue={item.quantity}
                    required
                    inputMode="decimal"
                  />
                </div>
              ))}
              <div className="field">
                <label htmlFor="correction-reason">Reason for correction</label>
                <input
                  id="correction-reason"
                  name="correction-reason"
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
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const reason = formValue(data, 'notice-reason');
                const statement = formValue(data, 'notice-statement').trim();
                const field = formValue(data, 'notice-field').trim();
                const corrected = formValue(data, 'notice-corrected').trim();
                void act(async () => {
                  await api.proposeChallanCorrectionNotice(organisationId, challan.id, {
                    reason,
                    ...(statement.length > 0 ? { statement } : {}),
                    ...(field.length > 0 && corrected.length > 0
                      ? { corrections: [{ field, corrected }] }
                      : {}),
                  });
                  reload();
                  return null;
                }, 'Correction notice requested; on approval it is issued with the next notice number.');
              }}
            >
              <p className="muted">
                This challan has recorded evidence ({eligibility.evidence.receipts}{' '}
                receipt(s), {eligibility.evidence.serials} serial(s),{' '}
                {eligibility.evidence.measurements} measurement(s)), so it can no longer
                be cancelled. The lawful correction path is a numbered{' '}
                <strong>correction notice</strong> that preserves the original document.
              </p>
              <div className="field">
                <label htmlFor="notice-statement">Correction statement</label>
                <textarea
                  id="notice-statement"
                  name="notice-statement"
                  rows={3}
                  maxLength={4000}
                />
              </div>
              <div className="field">
                <label htmlFor="notice-field">Corrected field (optional)</label>
                <input id="notice-field" name="notice-field" maxLength={100} />
              </div>
              <div className="field">
                <label htmlFor="notice-corrected">Corrected reading (optional)</label>
                <input id="notice-corrected" name="notice-corrected" maxLength={1000} />
              </div>
              <div className="field">
                <label htmlFor="notice-reason">Reason for correction</label>
                <input
                  id="notice-reason"
                  name="notice-reason"
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Request correction notice
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <Timeline
        api={api}
        organisationId={organisationId}
        scope={{
          kind: 'entity',
          entityType: 'delivery_challans',
          entityId: challanId,
        }}
      />

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
