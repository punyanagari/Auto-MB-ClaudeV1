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
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';
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
      <Card aria-labelledby="challan-title">
        <h1
          id="challan-title"
          tabIndex={-1}
          className="mb-2 text-2xl leading-8 font-semibold tracking-tight text-balance"
        >
          Delivery Challan
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card aria-labelledby="challan-title">
        <h1
          id="challan-title"
          tabIndex={-1}
          className="mb-2 text-2xl leading-8 font-semibold tracking-tight text-balance"
        >
          Delivery Challan
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading challan…
        </p>
      </Card>
    );
  }

  const { challan, items } = detail;
  const total = items
    .reduce((sum, item) => sum + Number(item.lineAmount), 0)
    .toFixed(2);
  const uninstalled = (serials ?? []).filter((s) => s.installedOn === null);

  return (
    <Card className="w-full" aria-labelledby="challan-title">
      <h1
        id="challan-title"
        tabIndex={-1}
        className="mb-2 text-2xl leading-8 font-semibold tracking-tight text-balance"
      >
        {challan.status === 'draft'
          ? 'Draft Delivery Challan'
          : `Delivery Challan ${challan.challanNumber ?? ''}`}
      </h1>
      <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip status={challan.status} />
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
            <span className="text-muted-foreground">{challan.consignee.address}</span>
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
        <FormError role="note">Cancelled: {challan.cancellationNote}</FormError>
      )}

      <DataTable>
        <caption className="sr-only">Challan line items</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Description</th>
            <th scope="col">Unit</th>
            <th scope="col">Quantity</th>
            <th scope="col" className={numericCell}>
              Rate
            </th>
            <th scope="col" className={numericCell}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.position}</th>
              <td className={wrapCell}>{item.description}</td>
              <td>{item.unit}</td>
              <td className={numericCell}>{item.quantity}</td>
              <td className={numericCell}>{formatRate(item.rate)}</td>
              <td className={numericCell}>{formatInr(item.lineAmount)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={5}>
              Total
            </th>
            <td className={numericCell}>
              <strong>{formatInr(total)}</strong>
            </td>
          </tr>
        </tbody>
      </DataTable>

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      <Actions>
        {challan.status === 'draft' && canModify && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                onEdit(challan.id);
              }}
            >
              Edit draft
            </Button>
            <Button
              variant="outline"
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
            </Button>
          </>
        )}
        {challan.status === 'draft' && canIssue && (
          <Button
            disabled={pending}
            onClick={() =>
              void act(
                () => api.issueChallan(organisationId, challan.id),
                'Challan issued.',
              )
            }
          >
            {pending ? 'Working…' : 'Issue challan'}
          </Button>
        )}
        {challan.status === 'issued' && canModify && (
          <Button
            disabled={pending}
            onClick={() =>
              void act(
                () => api.renderChallan(organisationId, challan.id),
                'PDF generated.',
              )
            }
          >
            {challan.renderedAvailable ? 'Re-generate PDF' : 'Generate PDF'}
          </Button>
        )}
        {challan.renderedAvailable && (
          <Button
            variant="outline"
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
          </Button>
        )}
        {challan.signedCopyAvailable && (
          <Button
            variant="outline"
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
          </Button>
        )}
        <Button variant="outline" onClick={onBack}>
          Back to Work
        </Button>
      </Actions>

      {challan.status === 'issued' && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Delivery receipt</h2>
          {receipt !== null ? (
            <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
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
              <p className="text-muted-foreground">
                Record the consignee&apos;s acknowledgement of this delivery.
              </p>
              <Field>
                <label htmlFor="receipt-date">Received on</label>
                <input id="receipt-date" name="receipt-date" type="date" required />
              </Field>
              <Field>
                <label htmlFor="receipt-by">Received by</label>
                <input
                  id="receipt-by"
                  name="receipt-by"
                  required
                  minLength={2}
                  maxLength={200}
                />
              </Field>
              <Field>
                <label htmlFor="receipt-remarks">Remarks (optional)</label>
                <input id="receipt-remarks" name="receipt-remarks" maxLength={1000} />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Record receipt
                </Button>
              </Actions>
            </form>
          ) : (
            <p className="text-muted-foreground">No receipt recorded yet.</p>
          )}

          <h2 className="mt-6 mb-2 text-sm font-semibold">Serial numbers</h2>
          {serials !== null && serials.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
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
                    <td className={wrapCell}>{serial.itemDescription}</td>
                    <td>
                      {serial.installedOn !== null ? (
                        <StatusChip status="installed">
                          installed {serial.installedOn}
                        </StatusChip>
                      ) : (
                        <span className="text-muted-foreground">not installed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="text-muted-foreground">No serial numbers recorded yet.</p>
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
              <h3 className="mt-4 mb-2 text-[13px] font-semibold">
                Record serial numbers
              </h3>
              <Field>
                <label htmlFor="serial-line">Challan line</label>
                <select id="serial-line" name="serial-line" required>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.position}. {item.description}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <label htmlFor="serial-numbers">Serial numbers (one per line)</label>
                <textarea id="serial-numbers" name="serial-numbers" rows={4} required />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Record serials
                </Button>
              </Actions>
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
              <h3 className="mt-4 mb-2 text-[13px] font-semibold">
                Record installation
              </h3>
              <Field>
                <label htmlFor="install-serial">Serial</label>
                <select id="install-serial" name="install-serial" required>
                  {uninstalled.map((serial) => (
                    <option key={serial.id} value={serial.id}>
                      {serial.serialNumber}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <label htmlFor="install-date">Installed on</label>
                <input id="install-date" name="install-date" type="date" required />
              </Field>
              <Field>
                <label htmlFor="install-remarks">Remarks (optional)</label>
                <input id="install-remarks" name="install-remarks" maxLength={1000} />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Record installation
                </Button>
              </Actions>
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
          <h2 className="mt-6 mb-2 text-sm font-semibold">Signed copy</h2>
          <Field>
            <label htmlFor="signed-file">Scanned signed copy (PDF)</label>
            <input
              id="signed-file"
              name="signed-file"
              type="file"
              accept="application/pdf"
            />
          </Field>
          <Actions>
            <Button type="submit" disabled={pending}>
              Upload signed copy
            </Button>
          </Actions>
        </form>
      )}

      {notices.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Correction notices</h2>
          <DataTable>
            <caption className="sr-only">
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
                    <StatusChip status={notice.status} />
                  </td>
                  <td>{notice.createdAt.slice(0, 10)}</td>
                  <td>
                    {notice.renderedAvailable ? (
                      <Button
                        variant="outline"
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
                      </Button>
                    ) : canModify ? (
                      <Button
                        variant="outline"
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
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">not rendered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      {challan.status === 'issued' && canModify && eligibility !== null && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Request correction</h2>
          {eligibility.pendingRequestId !== null ? (
            <p className="text-muted-foreground" role="note">
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
              <p className="text-muted-foreground">
                This challan has no recorded receipt, serials, or measurements, so the
                lawful correction path is <strong>cancel and replace</strong>: on
                approval the issued challan is cancelled (its number stays in the
                series) and a corrected draft is created for re-issue.
              </p>
              <Field>
                <label htmlFor="correction-date">Corrected challan date</label>
                <input
                  id="correction-date"
                  name="correction-date"
                  type="date"
                  defaultValue={challan.challanDate}
                  required
                />
              </Field>
              <Field>
                <label htmlFor="correction-consignee-name">Consignee name</label>
                <input
                  id="correction-consignee-name"
                  name="correction-consignee-name"
                  defaultValue={challan.consignee.name}
                  required
                  minLength={2}
                  maxLength={200}
                />
              </Field>
              <Field>
                <label htmlFor="correction-consignee-address">Consignee address</label>
                <input
                  id="correction-consignee-address"
                  name="correction-consignee-address"
                  defaultValue={challan.consignee.address}
                  required
                  minLength={3}
                  maxLength={1000}
                />
              </Field>
              <Field>
                <label htmlFor="correction-consignee-phone">
                  Consignee phone (optional)
                </label>
                <input
                  id="correction-consignee-phone"
                  name="correction-consignee-phone"
                  defaultValue={challan.consignee.phone ?? ''}
                  maxLength={30}
                />
              </Field>
              {items.map((item) => (
                <Field key={item.workItemId}>
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
                </Field>
              ))}
              <Field>
                <label htmlFor="correction-reason">Reason for correction</label>
                <input
                  id="correction-reason"
                  name="correction-reason"
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Request cancel &amp; replace
                </Button>
              </Actions>
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
              <p className="text-muted-foreground">
                This challan has recorded evidence ({eligibility.evidence.receipts}{' '}
                receipt(s), {eligibility.evidence.serials} serial(s),{' '}
                {eligibility.evidence.measurements} measurement(s)), so it can no longer
                be cancelled. The lawful correction path is a numbered{' '}
                <strong>correction notice</strong> that preserves the original document.
              </p>
              <Field>
                <label htmlFor="notice-statement">Correction statement</label>
                <textarea
                  id="notice-statement"
                  name="notice-statement"
                  rows={3}
                  maxLength={4000}
                />
              </Field>
              <Field>
                <label htmlFor="notice-field">Corrected field (optional)</label>
                <input id="notice-field" name="notice-field" maxLength={100} />
              </Field>
              <Field>
                <label htmlFor="notice-corrected">Corrected reading (optional)</label>
                <input id="notice-corrected" name="notice-corrected" maxLength={1000} />
              </Field>
              <Field>
                <label htmlFor="notice-reason">Reason for correction</label>
                <input
                  id="notice-reason"
                  name="notice-reason"
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Request correction notice
                </Button>
              </Actions>
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
          <h2 className="mt-6 mb-2 text-sm font-semibold">Cancel this challan</h2>
          <Field>
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
          </Field>
          <Actions>
            <Button type="submit" disabled={pending}>
              Cancel challan
            </Button>
          </Actions>
        </form>
      )}
    </Card>
  );
}
