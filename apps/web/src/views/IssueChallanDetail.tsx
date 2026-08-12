import { useCallback, useEffect, useState } from 'react';
import type { IssueChallanDetailResponse } from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatTimestampDate } from '../format.js';
import { openPdf } from '../lib/openPdf.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';

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
  /** R8: false closes the two mutating surfaces (cancel, correction) on a
   * completed Work, which the server refuses anyway — assertWorkOperable
   * for the cancel, requireActiveWork for the correction. Omitted means
   * the caller has not resolved the Work: the surfaces stay open exactly
   * as they were before this gate, and the server stays authoritative. */
  readonly workActive?: boolean;
  readonly onEdit: (challanId: string) => void;
  readonly onDeleted: () => void;
  readonly onBack: () => void;
}

const MOVEMENT_LABELS = {
  issue: 'Issue',
  loan: 'Loan (returnable)',
  return: 'Return',
} as const;

export function IssueChallanDetail({
  api,
  organisationId,
  challanId,
  canModify,
  canIssue,
  canCancel,
  workActive = true,
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
      <Card aria-labelledby="issue-challan-title">
        <h1 id="issue-challan-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card aria-labelledby="issue-challan-title">
        <h1 id="issue-challan-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading Issue Challan…
        </p>
      </Card>
    );
  }

  const { issueChallan, lines } = detail;

  return (
    <Card className="w-full" aria-labelledby="issue-challan-title">
      <h1 id="issue-challan-title" tabIndex={-1}>
        {issueChallan.status === 'draft'
          ? 'Draft Issue Challan'
          : `Issue Challan ${issueChallan.challanNumber ?? ''}`}
      </h1>
      <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip status={issueChallan.status} />
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
                <span className="text-muted-foreground">
                  {issueChallan.issuedToRole}
                </span>
              </>
            )}
            {issueChallan.location !== null && (
              <>
                <br />
                <span className="text-muted-foreground">{issueChallan.location}</span>
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
            <dd>{formatTimestampDate(issueChallan.issuedAt)}</dd>
          </div>
        )}
      </dl>

      {issueChallan.movementType !== 'issue' && (
        <FormNotice role="note">
          {issueChallan.movementType === 'loan'
            ? 'Loan movement: the material is returnable.'
            : 'Return movement: the material goes back to its origin.'}
        </FormNotice>
      )}

      {issueChallan.status === 'cancelled' &&
        issueChallan.cancellationNote !== null && (
          <FormError role="note">Cancelled: {issueChallan.cancellationNote}</FormError>
        )}

      <DataTable>
        <caption className="sr-only">Issue Challan lines</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th scope="col">Unit</th>
            <th scope="col" className={numericCell}>
              Quantity
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <th scope="row">{line.position}</th>
              <td>{line.itemNumber ?? 'Manual'}</td>
              <td className={wrapCell}>{line.description}</td>
              <td>{line.unit}</td>
              <td className={numericCell}>{line.quantity}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      <Actions>
        {issueChallan.status === 'draft' && canModify && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                onEdit(issueChallan.id);
              }}
            >
              Edit draft
            </Button>
            <Button
              variant="outline"
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
            </Button>
          </>
        )}
        {issueChallan.status === 'draft' && canIssue && (
          <Button
            disabled={pending}
            onClick={() =>
              void act(
                () => api.issueIssueChallan(organisationId, issueChallan.id),
                'Issue Challan issued.',
              )
            }
          >
            {pending ? 'Working…' : 'Issue challan'}
          </Button>
        )}
        {issueChallan.status === 'issued' && canModify && (
          <Button
            disabled={pending}
            onClick={() =>
              void act(
                () => api.renderIssueChallan(organisationId, issueChallan.id),
                'PDF generated.',
              )
            }
          >
            {issueChallan.renderedAvailable ? 'Re-generate PDF' : 'Generate PDF'}
          </Button>
        )}
        {issueChallan.renderedAvailable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await openPdf(() =>
                  api.downloadIssueChallanPdf(
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
          </Button>
        )}
        {issueChallan.signedCopyAvailable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await openPdf(() =>
                  api.downloadIssueChallanPdf(
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
          </Button>
        )}
        <Button variant="outline" onClick={onBack}>
          Back to Work
        </Button>
      </Actions>

      {issueChallan.status === 'issued' && canModify && (
        <Disclosure label="Upload signed copy">
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
                  api.uploadIssueChallanSignedCopy(
                    organisationId,
                    issueChallan.id,
                    file,
                  ),
                'Signed copy uploaded.',
              );
            }}
          >
            <Field>
              <label htmlFor="issue-signed-file">Scanned signed copy (PDF)</label>
              <input
                id="issue-signed-file"
                name="issue-signed-file"
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
        </Disclosure>
      )}

      {/* R8: a completed Work takes no correction (requireActiveWork), so
          the replacement form closes rather than collecting a date, a
          recipient, and a quantity per line only to fail on submit. The
          record itself — lines, cancellation note, both PDFs — stays. */}
      {issueChallan.status === 'issued' && canModify && !workActive && (
        <>
          <h2>Request correction</h2>
          <p className="text-muted-foreground" role="note">
            This Work is completed, so no correction can be filed against its documents.
            Reopen the Work from its page first; this challan and its PDFs stay
            available meanwhile.
          </p>
        </>
      )}

      {issueChallan.status === 'issued' &&
        canModify &&
        workActive &&
        hasPendingCorrection && (
          <>
            <h2>Request correction</h2>
            <p className="text-muted-foreground" role="note">
              A correction request for this Issue Challan is already awaiting a decision
              in the approvals queue.
            </p>
          </>
        )}

      {issueChallan.status === 'issued' &&
        canModify &&
        workActive &&
        !hasPendingCorrection && (
          <>
            <h2>Request correction</h2>
            <Disclosure label="Request cancel & replace">
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
                                  quantity: formValue(
                                    data,
                                    `ic-correction-qty-${line.id}`,
                                  ),
                                }
                              : {
                                  description: line.description,
                                  unit: line.unit,
                                  quantity: formValue(
                                    data,
                                    `ic-correction-qty-${line.id}`,
                                  ),
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
                <p className="text-muted-foreground">
                  Issue Challans carry no downstream evidence, so the lawful correction
                  path is <strong>cancel and replace</strong>: on approval the issued
                  challan is cancelled (its number stays in the series) and a corrected
                  draft is created for re-issue.
                </p>
                <Field>
                  <label htmlFor="ic-correction-date">Corrected challan date</label>
                  <input
                    id="ic-correction-date"
                    name="ic-correction-date"
                    type="date"
                    defaultValue={issueChallan.challanDate}
                    required
                  />
                </Field>
                <Field>
                  <label htmlFor="ic-correction-name">Issued to</label>
                  <input
                    id="ic-correction-name"
                    name="ic-correction-name"
                    defaultValue={issueChallan.issuedToName}
                    required
                    minLength={2}
                    maxLength={200}
                  />
                </Field>
                <Field>
                  <label htmlFor="ic-correction-role">Issued-to role (optional)</label>
                  <input
                    id="ic-correction-role"
                    name="ic-correction-role"
                    defaultValue={issueChallan.issuedToRole ?? ''}
                    maxLength={200}
                  />
                </Field>
                <Field>
                  <label htmlFor="ic-correction-location">Location (optional)</label>
                  <input
                    id="ic-correction-location"
                    name="ic-correction-location"
                    defaultValue={issueChallan.location ?? ''}
                    maxLength={200}
                  />
                </Field>
                <Field>
                  <label htmlFor="ic-correction-remarks">Remarks (optional)</label>
                  <input
                    id="ic-correction-remarks"
                    name="ic-correction-remarks"
                    defaultValue={issueChallan.remarks ?? ''}
                    maxLength={1000}
                  />
                </Field>
                {lines.map((line) => (
                  <Field key={line.id}>
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
                  </Field>
                ))}
                <Field>
                  <label htmlFor="ic-correction-reason">Reason for correction</label>
                  <input
                    id="ic-correction-reason"
                    name="ic-correction-reason"
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
            </Disclosure>
          </>
        )}

      {issueChallan.status === 'issued' && canCancel && !workActive && (
        <>
          <h2>Cancel this challan</h2>
          <FormError role="note">
            This Work is completed, so its issued documents are frozen. Reopen the Work
            from its page to cancel this challan; the challan, its lines, and its PDFs
            above stay readable and downloadable meanwhile.
          </FormError>
        </>
      )}

      {issueChallan.status === 'issued' && canCancel && workActive && (
        <Disclosure label="Cancel challan">
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
            <Field>
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
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Cancel challan
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </Card>
  );
}
