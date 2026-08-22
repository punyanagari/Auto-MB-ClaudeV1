import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TallyLedger,
  TallyMasterImportResult,
  TallyLedgerList,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Field, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The Tally ledger census — this organisation's chart of accounts as
 * TallyPrime holds it (migration 0118), and wave T1 of the Tally
 * migration train.
 *
 * A MIRROR, AND THE SCREEN SAYS SO. There is no "new ledger" control here
 * and there never will be: a ledger is created in Tally, which remains
 * the general accounting books (owner ruling 1). What this screen answers
 * is the question nothing in this application could answer before — who
 * does this company trade with, which security deposits and bank
 * guarantees are keyed to which work, and which of the parties Tally
 * knows about the contacts master has never heard of.
 *
 * TWO THINGS ARE NOT WHAT THEY LOOK LIKE, and both are labelled for it:
 *
 *   * A CONTACT HERE IS A PROPOSAL, not a link. Owner rulings 6 and 8:
 *     the match is made on GSTIN and then on an exact name, ambiguity
 *     proposes nothing, and a person confirms. Nothing on this screen
 *     confirms one yet — the column is evidence that the parties line up,
 *     which is what the wave after this one acts on.
 *   * A WORK CODE HERE REACHES NO WORK. Owner rulings 4 and 5: 202
 *     distinct codes appear in the masters against the works this system
 *     holds, most of them naming pre-cutover history, and a Tally code
 *     never creates a Work. It is text, and it is shown as text.
 *
 * THE IMPORT IS A CONVERSATION, not a button — the shape the Zoho
 * importer next door established. The file is read twice against the same
 * bytes: once to say what it WOULD do, and once, after the operator has
 * read that, to write. Re-importing a fresher export refreshes the
 * masters Tally has altered and leaves the rest alone, which is what
 * makes taking a new export on import day (ruling 3) safe rather than
 * frightening.
 *
 * The mock draws no Tally screen; this is built in its existing grammar
 * under AGENTS.md § Design contract 2 and 4, and `docs/UX.md` § 37
 * records the stance.
 */

/** One request's worth of rows. The real census is 4,327 ledgers, and the
 * class filter above the table is how an operator gets to the tens of
 * rows they actually want. */
const PAGE_SIZE = 100;

/** How many refusals the preview draws. A file producing more than a
 * handful is not a file with some bad masters in it, and the count says
 * so better than three hundred rows would. */
const REFUSAL_LIMIT = 20;

/** The lamp each class earns. `instrument` is the one worth finding —
 * those are the deposits and guarantees the money is sitting in — and
 * `other` is the two fifths of any chart of accounts that is tax heads
 * and bank accounts, which is information rather than a state. */
const CLASS_TONE: Record<
  TallyLedger['classification'],
  'success' | 'warning' | 'info' | 'neutral'
> = {
  customer: 'success',
  vendor: 'info',
  instrument: 'warning',
  other: 'neutral',
};

const CLASS_LABEL: Record<TallyLedger['classification'], string> = {
  customer: 'Customer',
  vendor: 'Vendor',
  instrument: 'Instrument',
  other: 'Other',
};

const NO_FILTER = {
  classification: '',
  matched: '',
  search: '',
  includeSuperseded: false,
};

interface TallyMastersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `import` authority. Without it the census still READS — which
   * parties this organisation trades with is ordinary reference data —
   * and the upload panel is simply absent. */
  readonly canImport: boolean;
}

export function TallyMasters({ api, organisationId, canImport }: TallyMastersProps) {
  const [ledgers, setLedgers] = useState<TallyLedger[] | null>(null);
  const [totals, setTotals] = useState<TallyLedgerList['totals']>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState(NO_FILTER);
  const [pending, setPending] = useState(false);
  const [loadVersion, retry] = useReload();

  const fileInput = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<TallyMasterImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor?: string) =>
      api.listTallyLedgers(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(filter.classification !== ''
          ? { classification: filter.classification as TallyLedger['classification'] }
          : {}),
        ...(filter.matched !== ''
          ? { matched: filter.matched as 'matched' | 'unmatched' }
          : {}),
        ...(filter.search !== '' ? { search: filter.search } : {}),
        ...(filter.includeSuperseded ? { includeSuperseded: true } : {}),
      }),
    [api, organisationId, filter],
  );

  useEffect(() => {
    let cancelled = false;
    setLedgers(null);
    setTotals(null);
    setNextCursor(null);
    setLoadError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setLedgers(page.ledgers);
        setTotals(page.totals);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The Tally census could not be loaded.'));
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
      setLedgers((current) => [...(current ?? []), ...page.ledgers]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(
        errorMessage(cause, 'The next page of the Tally census could not be loaded.'),
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
      const result = await api.importTallyMasters(organisationId, chosen, mode);
      if (mode === 'preview') {
        setPreview(result);
        return;
      }
      setPreview(null);
      setChosen(null);
      if (fileInput.current !== null) fileInput.current.value = '';
      setImportNotice(
        `${String(result.importedCount)} ledger(s) read from ${result.filename}: ${String(result.newCount)} new, ${String(result.updatedCount)} refreshed, ${String(result.unchangedCount)} unchanged.`,
      );
      retry();
    } catch (cause) {
      setImportError(errorMessage(cause, 'The export could not be read.'));
    } finally {
      setPending(false);
    }
  }

  const filtered =
    filter.classification !== '' || filter.matched !== '' || filter.search !== '';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        titleId="tally-masters-title"
        title="Tally census"
        description="The ledger masters TallyPrime holds, mirrored so this system can name them. Read-only: a ledger is created in Tally, and the contacts it proposes are proposals a person confirms."
      />

      <section aria-labelledby="tally-masters-title" className="flex flex-col gap-4">
        {totals !== null && (
          <p className="text-[13px] text-muted-foreground">
            <span className="font-mono tabular-nums">{String(totals.ledgerCount)}</span>{' '}
            ledger(s):{' '}
            <span className="font-mono tabular-nums">
              {String(totals.customerCount)}
            </span>{' '}
            customer,{' '}
            <span className="font-mono tabular-nums">{String(totals.vendorCount)}</span>{' '}
            vendor,{' '}
            <span className="font-mono tabular-nums">
              {String(totals.instrumentCount)}
            </span>{' '}
            instrument across{' '}
            <span className="font-mono tabular-nums">
              {String(totals.distinctCodeCount)}
            </span>{' '}
            work code(s),{' '}
            <span className="font-mono tabular-nums">{String(totals.otherCount)}</span>{' '}
            other.{' '}
            <span className="font-mono tabular-nums">
              {String(totals.unmatchedPartyCount)}
            </span>{' '}
            trading part(ies) are not in the contacts master.
            {totals.supersededCount > 0 && (
              <>
                {' '}
                <span className="font-mono tabular-nums">
                  {String(totals.supersededCount)}
                </span>{' '}
                row(s) are not in the latest export and are out of these counts.{' '}
                {/* OFFERED ONLY WHEN THERE IS SOMETHING TO SEE. A control
                    that is always present and almost always changes
                    nothing teaches an operator to ignore it — and a
                    superseded row is the rare case, not the standing one.
                    Reading them back matters because they are evidence
                    rather than deletions: a master somebody removed in
                    Tally is exactly what an operator wants to look at. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilter((current) => ({
                      ...current,
                      includeSuperseded: !current.includeSuperseded,
                    }));
                  }}
                >
                  {filter.includeSuperseded
                    ? 'Hide the rows the latest export dropped'
                    : 'Show the rows the latest export dropped'}
                </Button>
              </>
            )}
          </p>
        )}

        {canImport && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">Bring in a Tally masters export</h2>
            <p className="text-[13px] text-muted-foreground">
              In TallyPrime, export All Masters as XML and choose the file here. Nothing
              is written until you have read what it would do. Importing a fresher
              export refreshes the ledgers Tally has altered and leaves the rest exactly
              as they are.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Field className="my-0">
                <label htmlFor="tally-export">
                  TallyPrime All Masters export (.xml)
                </label>
                <input
                  ref={fileInput}
                  id="tally-export"
                  name="tally-export"
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
                    {String(preview.ledgerCount)}
                  </span>{' '}
                  ledger(s) in{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.groupCount)}
                  </span>{' '}
                  group(s):{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.newCount)}
                  </span>{' '}
                  new,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.updatedCount)}
                  </span>{' '}
                  altered in Tally since the last import,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.unchangedCount)}
                  </span>{' '}
                  unchanged.
                  {preview.supersededCount > 0 && (
                    <>
                      {' '}
                      <span className="font-mono tabular-nums">
                        {String(preview.supersededCount)}
                      </span>{' '}
                      ledger(s) this census holds are not in this export and will fall
                      out of it.
                    </>
                  )}
                </p>
                <p className="text-[13px]">
                  <span className="font-mono tabular-nums">
                    {String(preview.customerCount)}
                  </span>{' '}
                  customer,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.vendorCount)}
                  </span>{' '}
                  vendor,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.instrumentCount)}
                  </span>{' '}
                  instrument,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.otherCount)}
                  </span>{' '}
                  other.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.proposedContactCount)}
                  </span>{' '}
                  part(ies) match the contacts master and{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.unmatchedPartyCount)}
                  </span>{' '}
                  do not.
                </p>
                {/* THE PART AN OPERATOR IS ACTUALLY DECIDING ABOUT. A
                    count of things the reader could not use is worth more
                    than a count of the things it could, so it is stated
                    even when it is zero — silence would read as absence
                    of the problem rather than absence of the check. */}
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {String(preview.ambiguousCodeCount)}
                  </span>{' '}
                  ledger name(s) carry two different work codes and propose neither.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.malformedGstinCount)}
                  </span>{' '}
                  carry something that is not a GSTIN and will match by name instead.{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.duplicateNameCount)}
                  </span>{' '}
                  share a name with another master.
                </p>

                <DataTable>
                  <caption className="sr-only">
                    Ledgers in the export by the root group of Tally&rsquo;s chart of
                    accounts
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Root group</th>
                      <th scope="col" className={numericCell}>
                        Ledgers
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.byRootGroup.map((row) => (
                      <tr key={row.rootGroup}>
                        <th scope="row" className={wrapCell}>
                          {row.rootGroup}
                        </th>
                        <td className={numericCell}>{String(row.ledgerCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>

                {preview.refusals.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">
                      {String(preview.refusals.length)} ledger(s) will not be imported
                    </h3>
                    <DataTable>
                      <caption className="sr-only">
                        Ledgers this census will not store, with the line of the export
                        they appear on and the reason
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className={numericCell}>
                            Line
                          </th>
                          <th scope="col">Ledger</th>
                          <th scope="col">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.refusals.slice(0, REFUSAL_LIMIT).map((row) => (
                          <tr key={`${String(row.lineNumber)}-${row.ledgerName ?? ''}`}>
                            <th scope="row" className={numericCell}>
                              {String(row.lineNumber)}
                            </th>
                            <td className={wrapCell}>{row.ledgerName ?? '—'}</td>
                            <td className={wrapCell}>{row.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </DataTable>
                  </div>
                )}

                <div>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      void runImport('commit');
                    }}
                  >
                    Bring in this census
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
            setFilter((current) => ({
              ...current,
              classification: formValue(data, 'tally-class'),
              matched: formValue(data, 'tally-matched'),
              search: formValue(data, 'tally-search'),
            }));
          }}
        >
          <Field className="my-0">
            <label htmlFor="tally-search">Ledger name</label>
            <input
              id="tally-search"
              name="tally-search"
              type="text"
              maxLength={300}
              placeholder="Any part of the name"
            />
          </Field>
          <Field className="my-0">
            <label htmlFor="tally-class">Kind</label>
            <select id="tally-class" name="tally-class">
              <option value="">Every kind</option>
              <option value="customer">Customers</option>
              <option value="vendor">Vendors</option>
              <option value="instrument">Instruments (work-coded)</option>
              <option value="other">Everything else</option>
            </select>
          </Field>
          <Field className="my-0">
            <label htmlFor="tally-matched">Contacts master</label>
            <select id="tally-matched" name="tally-matched">
              <option value="">Matched or not</option>
              <option value="matched">A contact is proposed</option>
              <option value="unmatched">No contact could be proposed</option>
            </select>
          </Field>
          <Button type="submit" variant="outline">
            Apply filters
          </Button>
        </form>

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry the Tally census">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && ledgers === null && (
          <LoadingState label="the Tally census" rows={5} columns={6} />
        )}

        {ledgers !== null &&
          (ledgers.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Tally ledger masters with their group, what kind of ledger each is,
                  the work code its name carries, the contact proposed for it and its
                  opening balance
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Ledger</th>
                    <th scope="col">Group</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Work code</th>
                    <th scope="col">Proposed contact</th>
                    <th scope="col" className={numericCell}>
                      Opening balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ledgers.map((row) => (
                    <tr key={row.id}>
                      <th scope="row" className={wrapCell}>
                        {row.ledgerName}
                      </th>
                      <td className={wrapCell}>{row.parentGroup || '—'}</td>
                      <td>
                        <StatusChip
                          status={row.classification}
                          tone={CLASS_TONE[row.classification]}
                        >
                          {CLASS_LABEL[row.classification]}
                        </StatusChip>
                      </td>
                      {/* TEXT, NOT A LINK. Owner rulings 4 and 5: this
                          code names a work that may never have existed in
                          this system, and a link would be a claim nobody
                          made. */}
                      <td className="font-mono tabular-nums">{row.plCode ?? '—'}</td>
                      <td className={wrapCell}>
                        {row.proposedContactName === null ? (
                          <span className="text-muted-foreground">
                            {row.classification === 'customer' ||
                            row.classification === 'vendor'
                              ? 'None proposed'
                              : '—'}
                          </span>
                        ) : (
                          <>
                            {row.proposedContactName}{' '}
                            <span className="text-muted-foreground">
                              (by {row.proposedContactMethod ?? 'match'}, unconfirmed)
                            </span>
                          </>
                        )}
                      </td>
                      <td className={numericCell}>
                        {row.openingBalance === null
                          ? '—'
                          : formatInr(row.openingBalance)}
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
                    Load more ledgers
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState>
              {filtered
                ? 'No ledger matches those filters. Clear them to read the whole census.'
                : 'No Tally masters have been brought in yet. Export All Masters from TallyPrime and choose the file above.'}
            </EmptyState>
          ))}
      </section>
    </div>
  );
}
