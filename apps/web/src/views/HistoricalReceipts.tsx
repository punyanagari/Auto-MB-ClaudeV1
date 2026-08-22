import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ImportedDeductionHead,
  ImportedPayment,
  ImportedPaymentList,
  TallyReceiptImportResult,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Field, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { WorkLink } from '../ui/work-link.js';

/**
 * The railway receipts register — what the railway has actually paid
 * against the billing history, and what it kept (migration 0120, wave T3
 * of the Tally migration train).
 *
 * THE POINT OF THE SCREEN IS THE THIRD FIGURE. A bank statement says what
 * arrived. This says what was SETTLED, what arrived, and what was withheld
 * under each head between the two — because money the railway kept is
 * settled money, and a register showing only the credit reports every bill
 * as short by its own statutory deductions forever.
 *
 * READ-ONLY HISTORY, and the screen says so. There is no "record a
 * receipt" control here: a receipt entered from now on is a `bill_payments`
 * row against a bill this system raised. What this answers is the question
 * the office asks about the years before the cutover — what has this
 * division actually paid us, and what is sitting in security deposit.
 *
 * TWO COLUMNS ARE NOT WHAT THEY LOOK LIKE:
 *
 *   * a WORK here is a proposal somebody can overrule, made from the
 *     security-deposit head's own work code, the bill the receipt names,
 *     or the narration — in that order (owner ruling 17). A receipt with
 *     no route imports unlinked, and the "No work proposed" filter is the
 *     queue of those.
 *   * `Other` in the head breakdown is not a rounding bucket. It is bill
 *     copy, labour cess, conservation, postage and legal — real railway
 *     deductions with no head of their own (ruling 15) — and each line
 *     keeps the Tally ledger name that says which.
 *
 * THE IMPORT IS A CONVERSATION, not a button — the shape the two invoice
 * importers established. The file is read twice against the same bytes:
 * once to say what it WOULD do, and once, after the operator has read
 * that, to write.
 *
 * The mock draws no receipts screen; this is built in its existing grammar
 * under AGENTS.md § Design contract 2 and 4, and `docs/UX.md` § 41 records
 * the stance.
 */

/** One request's worth of rows. The real register is 755 receipts. */
const PAGE_SIZE = 100;

/** How many rows of the preview the confirmation step draws. An operator
 * confirms a summary and a sample, not 755 lines — and every refused
 * receipt is drawn regardless, because those are the ones the decision is
 * actually about. */
const PREVIEW_ROWS = 25;

const HEAD_LABEL: Record<ImportedDeductionHead, string> = {
  gst_tds: 'GST TDS',
  income_tax_tds: 'Income-tax TDS',
  security_deposit: 'Security deposit',
  retention: 'Retention',
  liquidated_damages: 'Liquidated damages',
  other: 'Other',
};

/** How the Work was proposed, in the operator's words. */
const WORK_METHOD_LABEL: Record<string, string> = {
  sd_ledger: 'from the security-deposit head',
  bill_reference: 'from the bill it names',
  narration: 'from the narration',
  manual: 'by hand',
};

const OUTCOME_LABEL: Record<
  TallyReceiptImportResult['receipts'][number]['outcome'],
  string
> = {
  imported: 'Joins the register',
  already_read: 'Already read',
  skipped: 'Left for a later wave',
  refused: 'Refused',
};

const OUTCOME_TONE: Record<
  TallyReceiptImportResult['receipts'][number]['outcome'],
  'success' | 'warning' | 'info' | 'destructive' | 'neutral'
> = {
  imported: 'success',
  already_read: 'info',
  skipped: 'neutral',
  refused: 'destructive',
};

interface HistoricalReceiptsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `?work=` deep link. Null reads across every Work in reach. */
  readonly workId: string | null;
  /** BOTH the `import` and `payments` authorities. Withheld rather than
   * offered-and-refused: the register is readable by every writer, and
   * only the upload is gated — and it is gated harder than the other
   * imports because every row it writes is money. */
  readonly canImport: boolean;
  readonly onOpenWork: (workId: string) => void;
  readonly onClearWorkFilter: () => void;
}

/** The head breakdown under one receipt, which is the whole reason this
 * register exists. Rendered in the row rather than behind a disclosure:
 * five heads is what a real receipt carries, and a click to see what was
 * deducted would hide the answer behind the question. */
function Heads({ payment }: { readonly payment: ImportedPayment }) {
  if (payment.deductions.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {payment.deductions.map((line) => (
        <li key={line.id} className="flex flex-wrap items-baseline gap-2">
          <span>{HEAD_LABEL[line.head]}</span>
          <span className="font-mono tabular-nums">{formatInr(line.amount)}</span>
          <span className="text-muted-foreground">
            {line.tallyLedgerName}
            {/* RULING 10, said out loud on the line it happened to. A
                nil somebody typed and a nil this reader invented are not
                the same fact, and the register must never let one read
                as the other. */}
            {line.amountMissing && ' — no amount stated in Tally'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HistoricalReceipts({
  api,
  organisationId,
  workId,
  canImport,
  onOpenWork,
  onClearWorkFilter,
}: HistoricalReceiptsProps) {
  const [payments, setPayments] = useState<readonly ImportedPayment[] | null>(null);
  const [totals, setTotals] = useState<ImportedPaymentList['totals']>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [linked, setLinked] = useState('');
  const [loadVersion, retry] = useReload();

  const fileInput = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<TallyReceiptImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor?: string) =>
      api.listImportedPayments(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(workId !== null ? { work: workId } : {}),
        ...(linked !== '' ? { linked: linked as 'linked' | 'unlinked' } : {}),
      }),
    [api, organisationId, workId, linked],
  );

  useEffect(() => {
    let cancelled = false;
    setPayments(null);
    setTotals(null);
    setNextCursor(null);
    setLoadError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setPayments(page.payments);
        setTotals(page.totals);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The railway receipts could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, loadVersion]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    setPending(true);
    setLoadError(null);
    try {
      const page = await fetchPage(nextCursor);
      setPayments((current) => [...(current ?? []), ...page.payments]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(
        errorMessage(cause, 'The next page of railway receipts could not be loaded.'),
      );
    } finally {
      setPending(false);
    }
  }

  async function runImport(mode: 'preview' | 'commit'): Promise<void> {
    if (chosen === null) return;
    setPending(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const result = await api.importTallyReceipts(organisationId, chosen, mode);
      if (mode === 'preview') {
        setPreview(result);
        return;
      }
      setPreview(null);
      setChosen(null);
      if (fileInput.current !== null) fileInput.current.value = '';
      setImportNotice(
        `${String(result.importedPaymentCount)} receipt(s) brought in from ${result.filename}, carrying ${String(result.importedDeductionCount)} deduction line(s).`,
      );
      retry();
    } catch (cause) {
      setImportError(errorMessage(cause, 'The receipt export could not be read.'));
    } finally {
      setPending(false);
    }
  }

  const narrowed = workId !== null;
  /* Refused first, then what would join the register, then everything
     else — the rule both invoice previews follow: the half the operator
     is deciding about is never the half that gets truncated. */
  const previewRows =
    preview === null
      ? []
      : [
          ...preview.receipts.filter((row) => row.outcome === 'refused'),
          ...preview.receipts.filter((row) => row.outcome === 'imported'),
          ...preview.receipts.filter(
            (row) => row.outcome !== 'refused' && row.outcome !== 'imported',
          ),
        ].slice(0, PREVIEW_ROWS);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Documents"
        titleId="historical-receipts-title"
        title="Railway receipts"
        description="What the railway has paid against the historical billing, and what it withheld under each head. Read-only: they are a record of what TallyPrime holds, and nothing measures, bills or settles against them."
      />

      <section
        aria-labelledby="historical-receipts-title"
        className="flex flex-col gap-4"
      >
        {narrowed && (
          <p className="text-[13px]">
            Showing the receipts filed against one Work.{' '}
            <Button variant="ghost" size="sm" onClick={onClearWorkFilter}>
              Read every receipt
            </Button>
          </p>
        )}

        {totals !== null && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted-foreground">
              <span className="font-mono tabular-nums">{String(totals.count)}</span>{' '}
              receipt(s):{' '}
              <span className="font-mono tabular-nums">{formatInr(totals.gross)}</span>{' '}
              settled,{' '}
              <span className="font-mono tabular-nums">{formatInr(totals.net)}</span>{' '}
              received, and{' '}
              <span className="font-mono tabular-nums">
                {formatInr(totals.deductionTotal)}
              </span>{' '}
              deducted.{' '}
              <span className="font-mono tabular-nums">
                {String(totals.unlinkedCount)}
              </span>{' '}
              carry no proposed Work.
            </p>
            <DataTable>
              <caption className="sr-only">
                What has been deducted under each head across the receipts shown
              </caption>
              <thead>
                <tr>
                  <th scope="col">Deduction head</th>
                  <th scope="col" className={numericCell}>
                    Lines
                  </th>
                  <th scope="col" className={numericCell}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {totals.heads.map((row) => (
                  <tr key={row.head}>
                    <th scope="row">{HEAD_LABEL[row.head]}</th>
                    <td className={numericCell}>{String(row.lineCount)}</td>
                    <td className={numericCell}>{formatInr(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}

        {canImport && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">
              Bring in a TallyPrime receipt voucher export
            </h2>
            <p className="text-[13px] text-muted-foreground">
              In TallyPrime, open the Day Book, narrow it to Receipt, and export it as
              XML — never the whole voucher file, which is far too large to upload.
              Import the Tally census first if you have not: the chart of accounts is
              what says whether a line on a receipt is a bank, a customer or a deduction
              head. Nothing is written until you have read what the file would do.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Field className="my-0">
                <label htmlFor="tally-receipts">TallyPrime receipts (.xml)</label>
                <input
                  ref={fileInput}
                  id="tally-receipts"
                  name="tally-receipts"
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  onChange={(event) => {
                    setChosen(event.currentTarget.files?.[0] ?? null);
                    setPreview(null);
                    setImportError(null);
                    setImportNotice(null);
                  }}
                />
              </Field>
              <Button
                variant="outline"
                disabled={chosen === null || pending}
                onClick={() => void runImport('preview')}
              >
                Read the file
              </Button>
            </div>

            {importError !== null && <FormError>{importError}</FormError>}
            {importNotice !== null && <FormNotice>{importNotice}</FormNotice>}

            {preview !== null && (
              <div className="flex flex-col gap-3">
                <p className="text-[13px]">
                  <span className="font-mono tabular-nums">
                    {String(preview.voucherCount)}
                  </span>{' '}
                  voucher(s) in the file,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.receiptCount)}
                  </span>{' '}
                  of them receipts:{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.importableCount)}
                  </span>{' '}
                  would join the register,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.alreadyReadCount)}
                  </span>{' '}
                  are already here, and{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.refusedCount)}
                  </span>{' '}
                  are refused.
                </p>
                <p className="text-[13px]">
                  <span className="font-mono tabular-nums">
                    {formatInr(preview.grossTotal)}
                  </span>{' '}
                  settled,{' '}
                  <span className="font-mono tabular-nums">
                    {formatInr(preview.netTotal)}
                  </span>{' '}
                  received,{' '}
                  <span className="font-mono tabular-nums">
                    {formatInr(preview.deductionTotal)}
                  </span>{' '}
                  deducted.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.workLinkedCount)}
                  </span>{' '}
                  carry a proposed Work and{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.unlinkedCount)}
                  </span>{' '}
                  do not.
                </p>
                {/* THE PARTS AN OPERATOR IS ACTUALLY DECIDING ABOUT, and
                    each is stated even when it is zero: silence would
                    read as absence of the problem rather than absence of
                    the check. */}
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {String(preview.bankPartyCount)}
                  </span>{' '}
                  receipt(s) are loan drawdowns, deposit or EMD refunds and FDR
                  maturities, and{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.noDeductionCount)}
                  </span>{' '}
                  are plain collections — a later wave reads both.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.missingAmountLineCount)}
                  </span>{' '}
                  head line(s) name a deduction with no amount stated and import as
                  zero.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.roundOffLineCount)}
                  </span>{' '}
                  round-off line(s) totalling{' '}
                  <span className="font-mono tabular-nums">
                    {formatInr(preview.roundOffTotal)}
                  </span>{' '}
                  fold into what was received rather than becoming a head.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.uncensusedLedgerRefusalCount)}
                  </span>{' '}
                  receipt(s) name a ledger the current census does not hold and are
                  refused until a fresh masters export is imported.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.ambiguousBillReferenceCount)}
                  </span>{' '}
                  bill reference(s) match more than one invoice and settle none.
                </p>

                <DataTable>
                  <caption className="sr-only">
                    What each receipt in the export would do, refused ones first
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Receipt</th>
                      <th scope="col">Paid by</th>
                      <th scope="col">Outcome</th>
                      <th scope="col" className={numericCell}>
                        Settled
                      </th>
                      <th scope="col" className={numericCell}>
                        Deducted
                      </th>
                      <th scope="col">Work</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row) => (
                      <tr key={row.tallyGuid}>
                        <th scope="row" className="font-mono tabular-nums">
                          {row.voucherNumber ?? '—'}
                          <span className="block text-muted-foreground">
                            {formatDate(row.voucherDate)}
                          </span>
                        </th>
                        <td className={wrapCell}>{row.counterpartyLedger || '—'}</td>
                        <td className={wrapCell}>
                          <StatusChip
                            status={row.outcome}
                            tone={OUTCOME_TONE[row.outcome]}
                          >
                            {OUTCOME_LABEL[row.outcome]}
                          </StatusChip>
                          {row.reason !== null && (
                            <span className="block text-muted-foreground">
                              {row.reason}
                            </span>
                          )}
                        </td>
                        <td className={numericCell}>{formatInr(row.gross)}</td>
                        <td className={numericCell}>{formatInr(row.deductionTotal)}</td>
                        <td className={wrapCell}>
                          {row.workCode === null ? (
                            <span className="text-muted-foreground">None proposed</span>
                          ) : (
                            <>
                              <span className="font-mono tabular-nums">
                                {row.workCode}
                              </span>{' '}
                              <span className="text-muted-foreground">
                                {WORK_METHOD_LABEL[row.workLinkMethod ?? 'manual']}
                              </span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {preview.receipts.length > previewRows.length && (
                  <p className="text-[13px] text-muted-foreground">
                    {String(preview.receipts.length - previewRows.length)} further
                    receipt(s) are not drawn here.
                  </p>
                )}

                <div>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      void runImport('commit');
                    }}
                  >
                    Bring in these receipts
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setLinked(formValue(data, 'receipt-linked'));
          }}
        >
          <Field className="my-0">
            <label htmlFor="receipt-linked">Work</label>
            <select id="receipt-linked" name="receipt-linked" defaultValue={linked}>
              <option value="">Linked or not</option>
              <option value="linked">A Work is proposed</option>
              <option value="unlinked">No Work proposed</option>
            </select>
          </Field>
          <Button type="submit" variant="outline">
            Apply filter
          </Button>
        </form>

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry the railway receipts">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && payments === null && (
          <LoadingState label="the railway receipts" rows={5} columns={7} />
        )}

        {payments !== null &&
          (payments.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Railway receipts with what was settled, what was received, what was
                  deducted under each head, and which invoice each settled
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Receipt</th>
                    <th scope="col">Paid by</th>
                    <th scope="col">Work</th>
                    <th scope="col" className={numericCell}>
                      Settled
                    </th>
                    <th scope="col" className={numericCell}>
                      Received
                    </th>
                    <th scope="col" className={numericCell}>
                      Deducted
                    </th>
                    <th scope="col">Under which head</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((row) => (
                    <tr key={row.id}>
                      <th scope="row" className="font-mono tabular-nums">
                        {row.voucherNumber ?? '—'}
                        <span className="block text-muted-foreground">
                          {formatDate(row.voucherDate)}
                        </span>
                        {/* THE SOURCE LAMP. This row came out of another
                            system's books, and nothing in this product
                            settles against it. */}
                        <StatusChip status="tally" tone="info">
                          TallyPrime
                        </StatusChip>
                      </th>
                      <td className={wrapCell}>
                        {row.counterpartyLedger}
                        {row.contactName !== null && (
                          <span className="block text-muted-foreground">
                            {row.contactName} (proposed)
                          </span>
                        )}
                      </td>
                      <td className={wrapCell}>
                        {row.workId === null ? (
                          <span className="text-muted-foreground">None proposed</span>
                        ) : row.workWithdrawn ? (
                          /* THE WORK WAS WITHDRAWN AFTER THIS RECEIPT WAS
                             FILED against it, and the row still names it
                             because nothing edits an imported payment. A
                             link would open a Work that is gone, so the
                             code is drawn as text and the receipt counts
                             in the queue above — the historical invoice
                             register's own answer to the same case. */
                          <>
                            <span className="font-mono tabular-nums">
                              {row.workCode} (withdrawn)
                            </span>
                            <span className="block text-muted-foreground">
                              back in the queue for a Work
                            </span>
                          </>
                        ) : (
                          <>
                            <WorkLink
                              workId={row.workId}
                              workCode={row.workCode ?? ''}
                              workTitle={row.workCode ?? ''}
                              tab="bills"
                              onOpenWork={onOpenWork}
                            />
                            <span className="block text-muted-foreground">
                              {WORK_METHOD_LABEL[row.workLinkMethod ?? 'manual']}
                            </span>
                          </>
                        )}
                      </td>
                      <td className={numericCell}>{formatInr(row.gross)}</td>
                      <td className={numericCell}>{formatInr(row.net)}</td>
                      <td className={numericCell}>{formatInr(row.deductionTotal)}</td>
                      <td className={wrapCell}>
                        <Heads payment={row} />
                        {row.invoiceLinks.length > 0 && (
                          <span className="block text-muted-foreground">
                            Settles{' '}
                            {row.invoiceLinks
                              .map((link) => link.invoiceNumber)
                              .join(', ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {nextCursor !== null && (
                <div>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void loadMore()}
                  >
                    Load more receipts
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState>
              {linked === 'unlinked'
                ? 'Every receipt here carries a proposed Work. Clear the filter to read the register.'
                : 'No railway receipts have been brought in yet. Export the Day Book narrowed to Receipt from TallyPrime and choose the file above.'}
            </EmptyState>
          ))}
      </section>
    </div>
  );
}
