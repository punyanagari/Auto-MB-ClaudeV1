import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChallanDetailResponse,
  ChallanItem,
  CorrectionEligibilityResponse,
  CorrectionNotice,
  Receipt,
  Serial,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { wayfindingOf, type Wayfind } from '../lib/wayfinding.js';
import { formatInr, formatRate, formatTimestampDate, todayIso } from '../format.js';
import { openPdf } from '../lib/openPdf.js';
import { formatMinorUnits, parseDecimalMinorUnits } from '../loa-payload.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, Actions, FormError, FormNotice, Hint } from '../ui/form.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Timeline } from './Timeline.js';

interface ChallanDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly challanId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly canRecordEvidence: boolean;
  /** The signing authority (0091). Draws the one action that queues this
   * challan for the organisation's own certificate; the server checks the
   * same authority, which is where it is enforced. */
  readonly canSign: boolean;
  /** R8: false closes the two mutating surfaces (cancel, correction) on a
   * completed Work, which the server refuses anyway. Omitted means the
   * caller has not resolved the Work — the surfaces stay open exactly as
   * they were before this gate, and the server stays authoritative. */
  readonly workActive?: boolean;
  readonly onEdit: (challanId: string) => void;
  readonly onDeleted: () => void;
  readonly onBack: () => void;
}

/** Exact challan total: Σ lineAmount summed in BigInt minor units (a
 * DecimalString carries at most three fraction digits). The float sum
 * this replaces could drift off the exact paisa on large totals while
 * being displayed as authoritative. Null when a line amount is not a
 * plain non-negative decimal — then no total is shown rather than a
 * guessed one. */
function exactTotal(items: readonly ChallanItem[]): string | null {
  let total = 0n;
  for (const item of items) {
    const line = parseDecimalMinorUnits(item.lineAmount, 3);
    if (line === null) return null;
    total += line;
  }
  return formatMinorUnits(total, 3);
}

/** How many serials a line needs: one per delivered unit. Read off the
 * decimal string rather than through parseFloat — the quantity is exact
 * numeric(18,3) and only its whole part is ever a count of units. */
function unitsOf(quantity: string): number {
  return Number(quantity.split('.')[0] ?? '0');
}

/** Why the "Cancel this challan" form is closed, or null when a
 * cancellation can still be attempted. The page has already loaded the
 * correction eligibility and printed it further up; offering Cancel
 * beside that text walked a cancel-authority holder into a guaranteed 409
 * CHALLAN_HAS_EVIDENCE. Evidence is not the server's only reason to
 * refuse — a challan billed into a live Measurement Book still bounces
 * with SOURCE_BILLED_IN_MB, and that answer is reported as an action
 * error — so this closes the cases the page can already see, not all of
 * them. */
function cancelClosedReason(
  workActive: boolean,
  eligibility: CorrectionEligibilityResponse | null,
): string | null {
  if (!workActive) {
    return (
      'This Work is completed, so its issued documents are frozen. Reopen the ' +
      'Work from its page to cancel this challan; the challan, its lines, and ' +
      'its PDFs above stay readable meanwhile.'
    );
  }
  if (eligibility === null) return null;
  if (eligibility.pendingRequestId !== null) {
    return (
      'A correction request for this challan is already awaiting an approval ' +
      'decision. Let that decision land — cancelling here would go around it.'
    );
  }
  if (eligibility.path !== 'cancel_replace') {
    const { receipts, serials, measurements } = eligibility.evidence;
    return (
      `Cancellation is closed for this challan: ${String(receipts)} receipt(s), ` +
      `${String(serials)} serial(s), and ${String(measurements)} measurement(s) ` +
      'are recorded against it. Request a correction notice above instead.'
    );
  }
  return null;
}

/** The serials recorded against a challan, grouped by the line they sit
 * on. The page needs a per-line count and a per-line list, and both used
 * to be a full scan of every serial on the challan — O(lines × serials)
 * on a document with a serial per delivered unit. */
function serialsByLine(
  serials: readonly Serial[] | null,
): ReadonlyMap<string, readonly Serial[]> {
  const grouped = new Map<string, Serial[]>();
  for (const serial of serials ?? []) {
    const group = grouped.get(serial.challanItemId);
    if (group === undefined) grouped.set(serial.challanItemId, [serial]);
    else group.push(serial);
  }
  return grouped;
}

/** One line of the challan's item table. Memoised: the table is the
 * document, and the page re-renders on every action, note and pending
 * flag around it. */
const ChallanLineRow = memo(function ChallanLineRow({
  item,
}: {
  readonly item: ChallanItem;
}) {
  return (
    <tr>
      <th scope="row">{item.position}</th>
      <td className={wrapCell}>{item.description}</td>
      <td>{item.unit}</td>
      <td className={numericCell}>{item.quantity}</td>
      <td className={numericCell}>{formatRate(item.rate)}</td>
      <td className={numericCell}>{formatInr(item.lineAmount)}</td>
    </tr>
  );
});

/** One recorded serial. Memoised for the same reason as the line rows:
 * a challan carries one serial per delivered unit. */
const SerialRow = memo(function SerialRow({ serial }: { readonly serial: Serial }) {
  return (
    <tr>
      <th scope="row">{serial.serialNumber}</th>
      <td className={wrapCell}>{serial.itemDescription}</td>
      <td>
        {serial.installedOn !== null ? (
          <StatusChip status="installed">installed {serial.installedOn}</StatusChip>
        ) : (
          <span className="text-muted-foreground">not installed</span>
        )}
      </td>
    </tr>
  );
});

/** Stable empty line list, so the memo over a not-yet-loaded challan does
 * not see a fresh array on every render. */
const NO_ITEMS: readonly ChallanItem[] = [];

interface RecordSerialsFormProps {
  /** The lines the operator may record against: every line once the
   * challan is issued, the serial-tracked lines while it is a draft. */
  readonly lines: readonly ChallanItem[];
  readonly pending: boolean;
  readonly onRecord: (
    challanItemId: string,
    /** Mutable because it is the request payload the API client takes. */
    serialNumbers: string[],
    form: HTMLFormElement,
  ) => void;
  readonly onInvalid: (message: string) => void;
}

/** Serial recording, shared by the draft and the issued challan. The API
 * accepts serials against a DRAFT on purpose — that is the pre-issue flow
 * for items flagged requires_serials — but this form used to sit inside
 * the issued-only branch, so the flag dead-ended at a 409
 * SERIALS_INCOMPLETE with no control anywhere to satisfy it. */
function RecordSerialsForm({
  lines,
  pending,
  onRecord,
  onInvalid,
}: RecordSerialsFormProps) {
  return (
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
          onInvalid('Choose a line and enter at least one serial number.');
          return;
        }
        onRecord(challanItemId, serialNumbers, form);
      }}
    >
      <Field>
        <label htmlFor="serial-line">Challan line</label>
        <select id="serial-line" name="serial-line" required>
          {lines.map((item) => (
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
  );
}

export function ChallanDetail({
  api,
  organisationId,
  challanId,
  canModify,
  canIssue,
  canCancel,
  canRecordEvidence,
  canSign,
  workActive = true,
  onEdit,
  onDeleted,
  onBack,
}: ChallanDetailProps) {
  const [detail, setDetail] = useState<ChallanDetailResponse | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [serials, setSerials] = useState<readonly Serial[] | null>(null);
  /** Work item ids flagged for serial traceability. The challan line does
   * not carry the flag, so a draft reads it off the Work to know which of
   * its lines the server will hold the issue for. */
  const [serialTracked, setSerialTracked] = useState<ReadonlySet<string>>(new Set());
  const [eligibility, setEligibility] = useState<CorrectionEligibilityResponse | null>(
    null,
  );
  const [notices, setNotices] = useState<readonly CorrectionNotice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Where a refusal is actually fixed, when it names another screen — the
   * inspection gate's remedy is the Work's Inspection clause tab, and a
   * clerk told only "not certified" has nowhere to go. */
  const [actionWayfind, setActionWayfind] = useState<Wayfind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const reload = useCallback(() => {
    setLoadError(null);
    api
      .getChallan(organisationId, challanId)
      .then(async (loaded) => {
        // This screen is a WORK challan's: its evidence, its serials, its
        // corrections all read through the Work. A standalone challan
        // (migration 0056) has none of that and lives in the Delivery
        // Challan register instead, so it is turned away here rather than
        // half-rendered.
        if (loaded.challan.workId === null) {
          setLoadError(
            'This is a standalone Delivery Challan; open it from the Delivery Challans register.',
          );
          return;
        }
        const workId = loaded.challan.workId;
        // Delivery evidence only exists once the challan is issued.
        if (loaded.challan.status === 'issued') {
          const [loadedReceipt, workSerials, loadedEligibility, loadedNotices] =
            await Promise.all([
              api.getReceipt(organisationId, challanId),
              api.listWorkSerials(organisationId, workId),
              api.challanCorrectionEligibility(organisationId, challanId),
              api.listChallanCorrectionNotices(organisationId, challanId),
            ]);
          setReceipt(loadedReceipt);
          setSerials(workSerials.filter((s) => s.deliveryChallanId === challanId));
          setSerialTracked(new Set());
          setEligibility(loadedEligibility);
          setNotices(loadedNotices);
        } else if (loaded.challan.status === 'cancelled') {
          setReceipt(null);
          setSerials(null);
          setSerialTracked(new Set());
          setEligibility(null);
          setNotices(await api.listChallanCorrectionNotices(organisationId, challanId));
        } else {
          // A draft carries serials too: an item flagged for serial
          // traceability needs one serial per unit BEFORE issue, so the
          // Work's flags and whatever has been recorded so far are what
          // the draft page is missing.
          const [work, workSerials] = await Promise.all([
            api.getWork(organisationId, loaded.challan.workId),
            api.listWorkSerials(organisationId, workId),
          ]);
          setReceipt(null);
          setSerials(workSerials.filter((s) => s.deliveryChallanId === challanId));
          setSerialTracked(
            new Set(
              work.schedules
                .flatMap((schedule) => schedule.items)
                .filter((item) => item.requiresSerials)
                .map((item) => item.id),
            ),
          );
          setEligibility(null);
          setNotices([]);
        }
        setDetail(loaded);
      })
      .catch((cause: unknown) => {
        setLoadError(errorMessage(cause, 'The challan could not be loaded.'));
      });
  }, [api, organisationId, challanId]);

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  /* Derived once per load rather than once per render, and above the two
   * early returns below so the hook order never depends on load state. */
  const items = detail?.items ?? NO_ITEMS;
  const total = useMemo(() => exactTotal(items), [items]);
  const serialsOfLine = useMemo(() => serialsByLine(serials), [serials]);
  const uninstalled = useMemo(
    () => (serials ?? []).filter((serial) => serial.installedOn === null),
    [serials],
  );

  async function act(work: () => Promise<ChallanDetailResponse | null>, done: string) {
    setPending(true);
    setActionError(null);
    setActionWayfind(null);
    setNotice(null);
    try {
      const updated = await work();
      if (updated !== null) setDetail(updated);
      setNotice(done);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setActionWayfind(
        wayfindingOf(cause, challan?.workId == null ? {} : { workId: challan.workId }),
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <Card aria-labelledby="challan-title">
        <h1 id="challan-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card aria-labelledby="challan-title">
        <h1 id="challan-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading challan…
        </p>
      </Card>
    );
  }

  const { challan } = detail;
  // The lines a correction can restate: Work item lines only. A manual
  // (non-LOA) line names no schedule item, so there is no sanctioned
  // quantity for a correction to move, and the server says so by name.
  const correctableItems = items.filter(
    (item): item is ChallanItem & { workItemId: string } => item.workItemId !== null,
  );
  // The draft's serial-tracked lines, with what is recorded against each.
  // The server counts the same way before it lets the challan be issued.
  const trackedLines = items
    .filter((item) => item.workItemId !== null && serialTracked.has(item.workItemId))
    .map((item) => ({
      item,
      recorded: (serialsOfLine.get(item.id) ?? []).length,
      required: unitsOf(item.quantity),
    }));
  const shortLines = trackedLines.filter((line) => line.recorded !== line.required);
  const cancelClosed = cancelClosedReason(workActive, eligibility);

  return (
    <Card className="w-full" aria-labelledby="challan-title">
      <h1 id="challan-title" tabIndex={-1}>
        {challan.status === 'draft'
          ? 'Draft Delivery Challan'
          : `Delivery Challan ${challan.challanNumber ?? ''}`}
      </h1>
      <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
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
            <dd>{formatTimestampDate(challan.issuedAt)}</dd>
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
            <ChallanLineRow key={item.id} item={item} />
          ))}
          <tr>
            <th scope="row" colSpan={5}>
              Total
            </th>
            <td className={numericCell}>
              <strong>{total === null ? '—' : formatInr(total)}</strong>
            </td>
          </tr>
        </tbody>
      </DataTable>

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && (
        <FormError>
          {actionError}
          {actionWayfind !== null && (
            <>
              {' '}
              <a href={actionWayfind.hash}>{actionWayfind.label}</a>
            </>
          )}
        </FormError>
      )}

      {/* Said beside the Issue button, because that is where the refusal
          used to arrive from: the server holds the issue until every
          serial-tracked line carries one serial per unit. */}
      {challan.status === 'draft' && shortLines.length > 0 && (
        <FormError role="note">
          Serials outstanding —{' '}
          {shortLines
            .map(
              (line) =>
                `${line.item.description} (${String(line.recorded)} of ` +
                `${String(line.required)} recorded)`,
            )
            .join('; ')}
          . This challan cannot be issued until each of those lines carries one serial
          per unit; record them below.
        </FormError>
      )}

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
                await openPdf(() =>
                  api.downloadChallanPdf(organisationId, challan.id, 'rendered'),
                );
                return null;
              }, 'PDF opened in a new tab.')
            }
          >
            Open PDF
          </Button>
        )}
        {/* SEND FOR SIGNING (0091, ADR-0012). Only on an issued challan
            that has a render — the signature covers stored bytes, so
            there is nothing to sign before one exists — and only for a
            member holding the signing authority. The queue at #/signing
            is where it goes next; this is the only place it is raised,
            because raising it is a thing you do TO a document. */}
        {challan.status === 'issued' && challan.renderedAvailable && canSign && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await api.createSigningRequest(organisationId, {
                  documentType: 'delivery_challan',
                  documentId: challan.id,
                });
                return null;
              }, 'Sent to the signing queue.')
            }
          >
            Send for signing
          </Button>
        )}
        {challan.signedCopyAvailable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await openPdf(() =>
                  api.downloadChallanPdf(organisationId, challan.id, 'signed'),
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

      {challan.status === 'draft' && trackedLines.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Serial numbers</h2>
          <p className="text-muted-foreground">
            These lines are flagged for serial traceability, so one serial per unit has
            to be recorded here before the challan is issued. Editing the draft&apos;s
            lines clears the serials recorded so far, so set the quantities first and
            record serials once they are final.
          </p>
          <DataTable>
            <caption className="sr-only">
              Serial-tracked lines on this draft and their recorded serials
            </caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Quantity</th>
                <th scope="col">Serials recorded</th>
                <th scope="col">Serials</th>
              </tr>
            </thead>
            <tbody>
              {trackedLines.map((line) => (
                <tr key={line.item.id}>
                  <th scope="row" className={wrapCell}>
                    {line.item.position}. {line.item.description}
                  </th>
                  <td className={numericCell}>{line.item.quantity}</td>
                  <td className={numericCell}>
                    {line.recorded} of {line.required}
                  </td>
                  <td className={wrapCell}>
                    {(serialsOfLine.get(line.item.id) ?? [])
                      .map((serial) => serial.serialNumber)
                      .join(', ') || (
                      <span className="text-muted-foreground">none yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {canRecordEvidence ? (
            <Disclosure
              label="New serial numbers"
              startOpen={(serials ?? []).length === 0}
            >
              <RecordSerialsForm
                lines={trackedLines.map((line) => line.item)}
                pending={pending}
                onInvalid={setActionError}
                onRecord={(challanItemId, serialNumbers, form) => {
                  void act(async () => {
                    const updated = await api.recordSerials(
                      organisationId,
                      challan.id,
                      {
                        challanItemId,
                        serialNumbers,
                      },
                    );
                    setSerials(
                      updated.filter((s) => s.deliveryChallanId === challan.id),
                    );
                    form.reset();
                    return null;
                  }, 'Serial numbers recorded.');
                }}
              />
            </Disclosure>
          ) : (
            <p className="text-muted-foreground">
              Serials are recorded by a site or office member before this challan is
              issued.
            </p>
          )}
        </>
      )}

      {challan.status === 'issued' && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Delivery receipt</h2>
          {receipt !== null ? (
            <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
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
                  <SerialRow key={serial.id} serial={serial} />
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="text-muted-foreground">No serial numbers recorded yet.</p>
          )}

          {canRecordEvidence && (
            <Disclosure
              label="New serial numbers"
              startOpen={(serials ?? []).length === 0}
            >
              <RecordSerialsForm
                lines={items}
                pending={pending}
                onInvalid={setActionError}
                onRecord={(challanItemId, serialNumbers, form) => {
                  void act(async () => {
                    const updated = await api.recordSerials(
                      organisationId,
                      challan.id,
                      {
                        challanItemId,
                        serialNumbers,
                      },
                    );
                    setSerials(
                      updated.filter((s) => s.deliveryChallanId === challan.id),
                    );
                    form.reset();
                    return null;
                  }, 'Serial numbers recorded.');
                }}
              />
            </Disclosure>
          )}

          {canRecordEvidence && uninstalled.length > 0 && (
            <Disclosure label="New installation">
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
                    setSerials(
                      updated.filter((s) => s.deliveryChallanId === challan.id),
                    );
                    form.reset();
                    return null;
                  }, 'Installation recorded.');
                }}
              >
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
                  <input
                    id="install-date"
                    name="install-date"
                    type="date"
                    required
                    defaultValue={todayIso()}
                  />
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
            </Disclosure>
          )}
        </>
      )}

      {challan.status === 'issued' && canModify && (
        <Disclosure label="Upload signed copy…">
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
        </Disclosure>
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
                  <td>{formatTimestampDate(notice.createdAt)}</td>
                  <td>
                    {notice.renderedAvailable ? (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            await openPdf(() =>
                              api.downloadCorrectionNoticePdf(
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
          {!workActive ? (
            // R8: corrections are refused on a completed Work
            // (requireActiveWork), so the form closes rather than taking a
            // filled-in replacement challan and failing on submit.
            <p className="text-muted-foreground" role="note">
              This Work is completed, so no correction can be filed against its
              documents. Reopen the Work from its page first; the challan and its PDFs
              above stay available meanwhile.
            </p>
          ) : eligibility.pendingRequestId !== null ? (
            <p className="text-muted-foreground" role="note">
              A correction request for this challan is already awaiting a decision in
              the approvals queue.
            </p>
          ) : eligibility.path === 'cancel_replace' ? (
            <Disclosure label="Request cancel & replace…">
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
                        // A correction restates Work item quantities; the
                        // server refuses a manual line here by name
                        // (CORRECTION_LINE_REQUIRES_WORK_ITEM), so the
                        // form never offers one.
                        items: correctableItems.map((item) => ({
                          workItemId: item.workItemId,
                          quantity: formValue(
                            data,
                            `correction-qty-${item.workItemId}`,
                          ),
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
                  <label htmlFor="correction-consignee-address">
                    Consignee address
                  </label>
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
                {correctableItems.map((item) => (
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
            </Disclosure>
          ) : (
            <Disclosure label="Request correction notice…">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const reason = formValue(data, 'notice-reason');
                  const statement = formValue(data, 'notice-statement').trim();
                  const field = formValue(data, 'notice-field').trim();
                  const corrected = formValue(data, 'notice-corrected').trim();
                  void act(async () => {
                    await api.proposeChallanCorrectionNotice(
                      organisationId,
                      challan.id,
                      {
                        reason,
                        ...(statement.length > 0 ? { statement } : {}),
                        ...(field.length > 0 && corrected.length > 0
                          ? { corrections: [{ field, corrected }] }
                          : {}),
                      },
                    );
                    reload();
                    return null;
                  }, 'Correction notice requested; on approval it is issued with the next notice number.');
                }}
              >
                <p className="text-muted-foreground">
                  This challan has recorded evidence ({eligibility.evidence.receipts}{' '}
                  receipt(s), {eligibility.evidence.serials} serial(s),{' '}
                  {eligibility.evidence.measurements} measurement(s)), so it can no
                  longer be cancelled. The lawful correction path is a numbered{' '}
                  <strong>correction notice</strong> that preserves the original
                  document.
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
                  <input
                    id="notice-corrected"
                    name="notice-corrected"
                    maxLength={1000}
                  />
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
            </Disclosure>
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

      {challan.status === 'issued' && canCancel && cancelClosed !== null && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">Cancel this challan</h2>
          <FormError role="note">{cancelClosed}</FormError>
        </>
      )}

      {challan.status === 'issued' && canCancel && cancelClosed === null && (
        <Actions>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setCancelNote('');
              setCancelling(true);
            }}
          >
            Cancel challan
          </Button>
        </Actions>
      )}

      {cancelling && (
        /* The mock's `components/cancel-document-dialog` at
           `a8e1fde`. Cancelling an issued challan is the one act on this
           page that spends a number permanently, so it asks in a modal
           and says what it costs. The cases where cancellation is closed
           outright — evidence recorded, a correction already pending, a
           completed Work — never reach here: `cancelClosedReason` has
           already replaced this control with the reason above. */
        <ConfirmDialog
          title={`Cancel ${challan.challanNumber ?? 'this challan'}?`}
          description="The document stays in the register and its number will never be reused. Serials recorded against it are released."
          confirmLabel="Confirm cancellation"
          cancelLabel="Keep document"
          pending={pending}
          confirmDisabled={cancelNote.trim().length < 3}
          onCancel={() => {
            setCancelling(false);
          }}
          onConfirm={() => {
            const note = cancelNote;
            setCancelling(false);
            void act(
              () => api.cancelChallan(organisationId, challan.id, { note }),
              'Challan cancelled.',
            );
          }}
        >
          <Field>
            <label htmlFor="cancel-note">Reason</label>
            <input
              id="cancel-note"
              value={cancelNote}
              onChange={(event) => {
                setCancelNote(event.target.value);
              }}
              minLength={3}
              autoComplete="off"
            />
            <Hint>
              The reason stays on the cancelled record, which anyone reading the
              Work&rsquo;s deliveries later will see.
            </Hint>
          </Field>
        </ConfirmDialog>
      )}
    </Card>
  );
}
