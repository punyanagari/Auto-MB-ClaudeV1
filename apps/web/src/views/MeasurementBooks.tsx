import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Challan,
  Contact,
  Installation,
  MbSourceRef,
  MbSourceType,
  MeasurementBook,
  MeasurementBookDetailResponse,
  MeasurementBookKind,
  MeasurementBookLine,
  PacCertificate,
} from '@auto-mb/contracts';
import {
  existingRecordIdOf,
  formValue,
  RequestFailedError,
  type ApiClient,
} from '../api.js';
import { compareDecimalStrings, formatDate, formatInr } from '../format.js';
import { openPdf } from '../lib/openPdf.js';
import {
  errorMessage,
  describeLoadFailure,
  type LoadFailure,
} from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { wayfindingOf, type Wayfind } from '../lib/wayfinding.js';
import { workHash } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { RailwayBillPanel } from './RailwayBillPanel.js';

interface MeasurementBooksProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Draft lifecycle (create, select sources, delete) runs under
   * owner/office. */
  readonly canModify: boolean;
  /** Finalize and bill preparation are financial acts under the issue
   * authority — the server is the arbiter, this only decides what to
   * offer. */
  readonly canIssue: boolean;
  /** Existing bills must be known before offering another financial record. */
  readonly canPrepareBill: boolean;
  /** Cancelling a finalized MB runs under the cancel authority
   * (membership.canCancelDocuments), matching the challan detail
   * screens. */
  readonly canCancel: boolean;
  /** Lets the Work page refresh its Bills section once a bill is
   * prepared from a finalized MB. */
  readonly onBillPrepared: () => void;
  /** Reports how many books this workspace knows of, whenever its list
   * loads or changes — the Measurement tab's badge counts books it never
   * reads itself. */
  readonly onBooksKnown: (count: number) => void;
}

function sourceKey(sourceType: MbSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/** Details shape of the MB_SOURCE_ALREADY_BILLED 409. */
interface SourceConflictDetails {
  readonly sourceType?: MbSourceType;
  readonly sourceId?: string;
  readonly holdingMbNumber?: string | null;
  readonly holdingMeasurementBookId?: string;
}

interface SourceCandidate {
  readonly sourceType: MbSourceType;
  readonly sourceId: string;
  readonly label: string;
}

const KIND_LABELS: Record<MeasurementBookKind, string> = {
  on_account: 'on-account',
  record: 'record',
  final: 'final',
};

/** One preview/snapshot line. Memoised because an MB carries a line per
 * priced Work item — 129 on the flagship corpus Work — and this panel
 * re-renders on every pending flag, notice and confirmation step around
 * it. The line objects come straight off the loaded detail, so their
 * identity only changes when the MB is reloaded. */
const MeasurementLineRow = memo(function MeasurementLineRow({
  line,
}: {
  readonly line: MeasurementBookLine;
}) {
  return (
    <tr>
      <th scope="row">{line.itemNumber}</th>
      <td className={wrapCell}>{line.description}</td>
      <td>{line.unitCode}</td>
      <td className={numericCell}>{line.deltaSupplied}</td>
      <td className={numericCell}>{line.deltaInstalled}</td>
      <td className={numericCell}>{line.deltaPac}</td>
      <td className={numericCell}>{formatInr(line.lineTotal)}</td>
      <td className={wrapCell}>{line.remark}</td>
    </tr>
  );
});

/**
 * The stage-wise Measurement Book workspace (Milestone 8; ADR-0006,
 * spec §5.9): draft an MB against the Work's open sources (issued
 * delivery challans, recorded installations, recorded PACs), preview
 * the computed stage deltas/amounts/remarks live, finalize into a
 * numbered immutable snapshot, prepare the bill from it, and render the
 * MB document PDF. Drafts stream a DRAFT-watermarked preview PDF;
 * finalized MBs render a persisted one.
 */
export function MeasurementBooks({
  api,
  organisationId,
  workId,
  canModify,
  canIssue,
  canPrepareBill,
  canCancel,
  onBillPrepared,
  onBooksKnown,
}: MeasurementBooksProps) {
  const [books, setBooks] = useState<readonly MeasurementBook[] | null>(null);
  const [detail, setDetail] = useState<MeasurementBookDetailResponse | null>(null);
  const [candidates, setCandidates] = useState<readonly SourceCandidate[] | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [claimedElsewhere, setClaimedElsewhere] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  /** The Work's consignees: the pick list for a record MB's author, and
   * the names the record-draft rows carry. */
  const [consignees, setConsignees] = useState<readonly Contact[]>([]);
  /** Controlled so the consignee field can appear the moment 'record' is
   * chosen, before anything is submitted. */
  const [createKind, setCreateKind] = useState<MeasurementBookKind>('on_account');
  /** Record draft ids checked for the next merge. */
  const [mergeSelection, setMergeSelection] = useState<ReadonlySet<string>>(new Set());
  const [existingDraftId, setExistingDraftId] = useState<string | null>(null);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingUnmerge, setConfirmingUnmerge] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  /** The consignee pick list, when it could not be read. Surfaced rather
   * than swallowed (audit finding 27 residue): without it the record-MB
   * option quietly disappears, which looks exactly like a Work that has
   * no consignees. */
  const [consigneeFailure, setConsigneeFailure] = useState<LoadFailure | null>(null);
  const [loadVersion, retry] = useReload();
  const [actionError, setActionError] = useState<{
    readonly message: string;
    /** Where the refusal is actually fixed, when it names another screen. */
    readonly wayfind: Wayfind | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBooks(null);
    setDetail(null);
    setLoadError(null);
    api
      .listWorkMeasurementBooks(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setBooks(loaded.books);
        onBooksKnown(loaded.books.length);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(describeLoadFailure(cause, 'Measurement Books'));
      });
    // A convenience read: without it record MBs lose their names and the
    // record kind is not offered, but the books themselves still load.
    // Its failure is reported all the same — an absent option and an
    // unreadable one are different facts.
    setConsigneeFailure(null);
    api
      .listWorkConsignees(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setConsignees(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setConsigneeFailure(describeLoadFailure(cause, 'The Work’s consignees'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const act = useCallback(
    async (work: () => Promise<void>, done: string) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
      } catch (cause) {
        setActionError({
          message: errorMessage(cause),
          wayfind: wayfindingOf(cause, { workId }),
        });
        throw cause;
      } finally {
        setPending(false);
      }
    },
    [workId],
  );

  /** act() variant for handlers that follow up after success only. */
  const tryAct = useCallback(
    (work: () => Promise<void>, done: string) => {
      void act(work, done).catch(() => {
        // Surfaced through actionError already.
      });
    },
    [act],
  );

  const refreshList = useCallback(async () => {
    const fresh = (await api.listWorkMeasurementBooks(organisationId, workId)).books;
    setBooks(fresh);
    onBooksKnown(fresh.length);
  }, [api, organisationId, workId, onBooksKnown]);

  const loadCandidates = useCallback(async () => {
    const [challans, installationList, pacList] = await Promise.all([
      api.listChallans(organisationId, workId),
      api.listWorkInstallations(organisationId, workId),
      api.listWorkPacCertificates(organisationId, workId),
    ]);
    const all: SourceCandidate[] = [
      ...challans
        .filter((challan: Challan) => challan.status === 'issued')
        .map((challan) => ({
          sourceType: 'delivery_challan' as const,
          sourceId: challan.id,
          label: `${challan.challanNumber ?? challan.id} · ${formatDate(challan.challanDate)}`,
        })),
      ...installationList.installations
        .filter((installation: Installation) => installation.status === 'recorded')
        .map((installation) => ({
          sourceType: 'installation' as const,
          sourceId: installation.id,
          label: `${installation.itemNumber} × ${installation.quantity} · ${formatDate(installation.installedOn)} · ${installation.locationName}`,
        })),
      ...pacList.certificates
        .filter((certificate: PacCertificate) => certificate.status === 'recorded')
        .map((certificate) => ({
          sourceType: 'pac_certificate' as const,
          sourceId: certificate.id,
          label: `${certificate.reference} · ${formatDate(certificate.issueDate)}`,
        })),
    ];
    setCandidates(all);
  }, [api, organisationId, workId]);

  const openBook = useCallback(
    async (measurementBookId: string) => {
      const loaded = await api.getMeasurementBook(organisationId, measurementBookId);
      setDetail(loaded);
      setConfirmingFinalize(false);
      setConfirmingDelete(false);
      setConfirmingUnmerge(false);
      setConfirmingCancel(false);
      setCancelNote('');
      setSelection(
        new Set(
          loaded.sources
            .filter((source) => source.releasedAt === null)
            .map((source) => sourceKey(source.sourceType, source.sourceId)),
        ),
      );
      setClaimedElsewhere(new Map());
      if (loaded.book.status === 'draft' && canModify) {
        await loadCandidates();
      } else {
        setCandidates(null);
      }
    },
    [api, canModify, loadCandidates, organisationId],
  );

  /* Two lookups the register used to do by linear scan, one per row:
   * `books.find(...)` for the MB a merged record was absorbed into, and a
   * fresh consignee Map built on every render. Both are hoisted above the
   * early returns below so the hook order is the same on every path. */
  const booksById = useMemo(
    () => new Map((books ?? []).map((candidate) => [candidate.id, candidate])),
    [books],
  );
  const consigneeNameById = useMemo(
    () => new Map(consignees.map((consignee) => [consignee.id, consignee.designation])),
    [consignees],
  );

  if (loadError !== null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <FormError>
          {loadError.message} Existing Measurement Books remain unknown, so drafting and
          finalisation are paused.
        </FormError>
        {loadError.retryable && (
          <Button variant="outline" onClick={retry}>
            Retry Measurement Books
          </Button>
        )}
      </>
    );
  }

  if (books === null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <p className="text-muted-foreground" role="status">
          Loading Measurement Books…
        </p>
      </>
    );
  }

  const nextSequence =
    books.reduce((highest, book) => Math.max(highest, book.sequenceNumber ?? 0), 0) + 1;
  const nextNumber = String(nextSequence).padStart(2, '0');
  const liveFinal = books.some((book) => book.isFinal && book.status !== 'cancelled');
  const book = detail?.book ?? null;
  /** A finalized MB always carries its number; the fallback exists only
   * because the shared contract type keeps it nullable for drafts. */
  const mbNumberLabel = book?.mbNumber ?? 'this Measurement Book';
  const consigneeLabel = (contactId: string | null): string =>
    contactId === null ? 'consignee' : (consigneeNameById.get(contactId) ?? contactId);
  /** How a merged record names its absorber: by number once finalized,
   * as "draft" while it is still one. */
  const absorberLabel = (absorberId: string): string =>
    booksById.get(absorberId)?.mbNumber ?? 'draft';
  const recordDrafts = books.filter(
    (candidate) => candidate.kind === 'record' && candidate.status === 'draft',
  );
  /** The record MBs the OPEN draft absorbed: their existence is what makes
   * it an absorbing draft — un-merge is its way apart, delete is refused. */
  const absorbedRecords =
    book === null
      ? []
      : books.filter(
          (candidate) =>
            candidate.status === 'merged' && candidate.mergedIntoId === book.id,
        );

  return (
    <>
      <h2>Measurement Books</h2>
      <p className="text-muted-foreground">
        Stage-wise billing documents built from the Work&apos;s unbilled sources. A
        draft recomputes from live state; finalizing assigns the next gap-free MB number
        and freezes the snapshot; the bill is prepared from the finalized MB.
      </p>
      {consigneeFailure !== null && (
        <>
          <FormError>
            {consigneeFailure.message} A record Measurement Book cannot be started
            without them — this does not mean the Work has no consignees.
          </FormError>
          {consigneeFailure.retryable && (
            <Button variant="outline" onClick={retry}>
              Retry consignees
            </Button>
          )}
        </>
      )}
      {actionError !== null && (
        <FormError>
          {actionError.message}
          {actionError.wayfind !== null && (
            <>
              {' '}
              <a href={actionError.wayfind.hash}>{actionError.wayfind.label}</a>
            </>
          )}
        </FormError>
      )}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {/* The Work's unbillable variation exposure, drawn where the mock
          draws it (Auto-MB-Vercel-du, components/measurement-book.tsx at
          a8e1fde): above the MB register, because it is a fact about the
          Work rather than about any one book, and it reads the same on a
          draft as on a finalized one.

          It is gated on an opened book only because that is the one
          response carrying it — `unbillableVariationExposure` rides on
          MeasurementBookDetailResponse, and the list endpoint has no
          equivalent. The position is the mock's; the availability is the
          API's.

          `formatInr`, not the compact form the mock uses: this is the
          money a variation would have to sanction, and rounding it to two
          decimal places of a crore would misstate the figure an operator
          takes to an approving authority. Exposure arrives as an exact
          decimal string and is printed as one. */}
      {detail !== null &&
        compareDecimalStrings(detail.unbillableVariationExposure, '0') > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
            <div>
              <p className="text-sm font-medium text-warning-foreground">
                Unbillable variation exposure
              </p>
              <p className="text-xs text-muted-foreground">
                Installed above sanctioned quantity; excluded from measurement and
                billing until variation approval.
              </p>
            </div>
            <span className="font-mono font-semibold tabular-nums text-warning-foreground">
              {formatInr(detail.unbillableVariationExposure)}
            </span>
          </div>
        )}

      {books.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Measurement Books raised on this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Kind</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className={numericCell}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {books.map((row) => {
              const mergedInto = row.mergedIntoId;
              return (
                <tr key={row.id}>
                  <th scope="row">
                    <Button
                      variant="link"
                      size="inline"
                      className="font-medium"
                      onClick={() => {
                        tryAct(
                          async () => {
                            await openBook(row.id);
                          },
                          `Measurement Book ${row.mbNumber ?? 'draft'} opened below.`,
                        );
                      }}
                    >
                      {row.mbNumber ?? 'Draft'}
                    </Button>{' '}
                    {row.isFinal && <StatusChip status="issued">FINAL BILL</StatusChip>}
                  </th>
                  <td>
                    {KIND_LABELS[row.kind]}
                    {row.kind === 'record' && (
                      <span className="text-muted-foreground">
                        {' '}
                        · {consigneeLabel(row.consigneeContactId)}
                      </span>
                    )}
                  </td>
                  <td>{formatDate(row.mbDate)}</td>
                  <td>
                    {row.status === 'merged' && mergedInto !== null ? (
                      /* The chip is the row's one live affordance: a merged
                         record's story continues on the draft that absorbed
                         it, so its status links there. */
                      <Button
                        variant="link"
                        size="inline"
                        onClick={() => {
                          tryAct(async () => {
                            await openBook(mergedInto);
                          }, 'The absorbing Measurement Book is opened below.');
                        }}
                      >
                        <StatusChip status="merged">
                          merged into {absorberLabel(mergedInto)}
                        </StatusChip>
                      </Button>
                    ) : (
                      <StatusChip status={row.status} />
                    )}
                  </td>
                  <td className={numericCell}>
                    {row.totalAmount !== null ? formatInr(row.totalAmount) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No Measurement Books raised yet.</p>
      )}

      {canModify && !liveFinal && (
        <Disclosure label="New Measurement Book" startOpen={books.length === 0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const mbDate = formValue(data, 'mb-draft-date');
              const consigneeContactId = formValue(data, 'mb-draft-consignee');
              const kind = createKind;
              setExistingDraftId(null);
              tryAct(async () => {
                try {
                  const created = await api.createWorkMeasurementBook(
                    organisationId,
                    workId,
                    {
                      mbDate,
                      kind,
                      ...(kind === 'record' ? { consigneeContactId } : {}),
                    },
                  );
                  await refreshList();
                  await openBook(created.book.id);
                  form.reset();
                  setCreateKind('on_account');
                } catch (cause) {
                  const existing = existingRecordIdOf(cause);
                  if (existing !== null) setExistingDraftId(existing);
                  throw cause;
                }
              }, 'Draft Measurement Book created — select its sources below.');
            }}
          >
            <Field>
              <label htmlFor="mb-draft-date">MB date</label>
              <input id="mb-draft-date" name="mb-draft-date" type="date" required />
            </Field>
            <Field>
              <label htmlFor="mb-draft-kind">Kind</label>
              <select
                id="mb-draft-kind"
                name="mb-draft-kind"
                value={createKind}
                onChange={(event) => {
                  setCreateKind(event.target.value as MeasurementBookKind);
                }}
              >
                <option value="on_account">
                  On-account — the billable Measurement Book
                </option>
                {/* A record MB is a consignee's sheet, so the kind is only
                    offered once the Work has consignees to name. */}
                {consignees.length > 0 && (
                  <option value="record">
                    Record — one consignee&apos;s parallel measurement sheet
                  </option>
                )}
                <option value="final">
                  Final — the last Measurement Book of the Work
                </option>
              </select>
              {createKind === 'on_account' && (
                <Hint>
                  Finalizes into the numbered snapshot that bills and tax invoices are
                  prepared from.
                </Hint>
              )}
              {createKind === 'record' && (
                <Hint>
                  Several consignees measure in parallel, one record draft each; a
                  record MB never takes a number — it ends merged into an on-account
                  draft, or deleted.
                </Hint>
              )}
              {createKind === 'final' && (
                <Hint>
                  The final MB bills the final-bill stage and must sweep every remaining
                  open source of the Work; once it is finalized, no further Measurement
                  Books can be raised.
                </Hint>
              )}
            </Field>
            {createKind === 'record' && (
              <Field>
                <label htmlFor="mb-draft-consignee">
                  Consignee filling this record MB
                </label>
                <select
                  id="mb-draft-consignee"
                  name="mb-draft-consignee"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Pick a consignee of this Work
                  </option>
                  {consignees.map((consignee) => (
                    <option key={consignee.id} value={consignee.id}>
                      {consignee.designation}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Actions>
              <Button type="submit" disabled={pending}>
                Create draft
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
      {existingDraftId !== null && (
        <Actions>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              const id = existingDraftId;
              tryAct(async () => {
                await openBook(id);
                setExistingDraftId(null);
              }, 'Existing draft opened below.');
            }}
          >
            Open existing draft
          </Button>
        </Actions>
      )}

      {recordDrafts.length > 0 && (
        <div className="my-3">
          <h3>Record drafts by consignee</h3>
          <p className="text-muted-foreground">
            Parallel measurement sheets, one open draft per consignee. Merging absorbs
            the checked drafts into one new on-account draft that claims the union of
            their sources; each record MB is then marked merged, pointing at it.
          </p>
          {canModify ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const mbDate = formValue(data, 'mb-merge-date');
                const recordMbIds = recordDrafts
                  .filter((draft) => mergeSelection.has(draft.id))
                  .map((draft) => draft.id);
                tryAct(async () => {
                  const created = await api.mergeWorkMeasurementBooks(
                    organisationId,
                    workId,
                    { recordMbIds, mbDate },
                  );
                  setMergeSelection(new Set());
                  await refreshList();
                  await openBook(created.book.id);
                  form.reset();
                }, 'Record drafts merged into a new on-account draft — its combined sources and preview are below.');
              }}
            >
              <fieldset>
                <legend>Record drafts to merge</legend>
                {recordDrafts.map((draft) => (
                  <Field key={draft.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={mergeSelection.has(draft.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setMergeSelection((previous) => {
                            const next = new Set(previous);
                            if (checked) next.add(draft.id);
                            else next.delete(draft.id);
                            return next;
                          });
                        }}
                      />{' '}
                      {consigneeLabel(draft.consigneeContactId)} ·{' '}
                      {formatDate(draft.mbDate)}
                    </label>
                  </Field>
                ))}
              </fieldset>
              <Field>
                <label htmlFor="mb-merge-date">Merged MB date</label>
                <input id="mb-merge-date" name="mb-merge-date" type="date" required />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending || mergeSelection.size === 0}>
                  Merge into on-account draft
                </Button>
              </Actions>
            </form>
          ) : (
            <ul>
              {recordDrafts.map((draft) => (
                <li key={draft.id}>
                  {consigneeLabel(draft.consigneeContactId)} ·{' '}
                  {formatDate(draft.mbDate)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {detail !== null && book !== null && (
        <div className="my-3">
          <h3>
            Measurement Book {book.mbNumber ?? 'draft'} · {formatDate(book.mbDate)}{' '}
            <StatusChip status={book.status} />{' '}
            {book.kind === 'record' && (
              <StatusChip status="record">
                record · {consigneeLabel(book.consigneeContactId)}
              </StatusChip>
            )}{' '}
            {book.isFinal && <StatusChip status="issued">FINAL BILL</StatusChip>}
          </h3>
          {book.status === 'cancelled' && book.cancellationNote !== null && (
            <p className="text-muted-foreground">Cancelled: {book.cancellationNote}</p>
          )}
          {book.status === 'merged' && book.mergedIntoId !== null && (
            <p className="text-muted-foreground">
              Merged into Measurement Book {absorberLabel(book.mergedIntoId)} — the
              sources this sheet gathered are claimed there now.
            </p>
          )}
          {absorbedRecords.length > 0 && (
            <p className="text-muted-foreground">
              This draft absorbed {String(absorbedRecords.length)} record Measurement
              Book{absorbedRecords.length === 1 ? '' : 's'} (
              {absorbedRecords
                .map((record) => consigneeLabel(record.consigneeContactId))
                .join(', ')}
              ); un-merging is the only way to take it apart.
            </p>
          )}

          {/* Deliberately not behind a Disclosure. This is the draft's
              editor, not a form standing open beneath a record: the checked
              boxes are the only display of which sources the draft claims,
              the operator reached this panel by asking for the draft by
              number, and the form disappears the moment the MB is finalized
              into a record worth reading. */}
          {book.status === 'draft' && canModify && candidates !== null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const sources: MbSourceRef[] = candidates
                  .filter((candidate) =>
                    selection.has(sourceKey(candidate.sourceType, candidate.sourceId)),
                  )
                  .map((candidate) => ({
                    sourceType: candidate.sourceType,
                    sourceId: candidate.sourceId,
                  }));
                tryAct(async () => {
                  try {
                    const updated = await api.setMeasurementBookSources(
                      organisationId,
                      book.id,
                      { sources },
                    );
                    setDetail(updated);
                  } catch (cause) {
                    if (cause instanceof RequestFailedError && cause.status === 409) {
                      const conflict = cause.details as SourceConflictDetails | null;
                      if (conflict?.sourceType && conflict.sourceId) {
                        const claimed = sourceKey(
                          conflict.sourceType,
                          conflict.sourceId,
                        );
                        // The server reports one clash per attempt, so the
                        // markers have to accumulate: replacing the map would
                        // unmark the row an earlier attempt already flagged.
                        setClaimedElsewhere((previous) =>
                          new Map(previous).set(
                            claimed,
                            conflict.holdingMbNumber ??
                              conflict.holdingMeasurementBookId ??
                              'another Measurement Book',
                          ),
                        );
                        // A claimed source can never join this MB and its box
                        // is now disabled, so drop it from the selection —
                        // otherwise every later save re-sends the same clash.
                        setSelection((previous) => {
                          const next = new Set(previous);
                          next.delete(claimed);
                          return next;
                        });
                      }
                    }
                    throw cause;
                  }
                }, 'Source selection saved; the preview below recomputed.');
              }}
            >
              <fieldset>
                <legend>
                  Billable sources — each source can be billed by at most one live
                  Measurement Book, ever
                </legend>
                {(
                  [
                    ['delivery_challan', 'Delivery challans (issued)'],
                    ['installation', 'Installations (recorded)'],
                    ['pac_certificate', 'PAC certificates (recorded)'],
                  ] as const
                ).map(([sourceType, heading]) => {
                  const group = candidates.filter(
                    (candidate) => candidate.sourceType === sourceType,
                  );
                  return (
                    <div key={sourceType}>
                      <h4>{heading}</h4>
                      {group.length > 0 ? (
                        group.map((candidate) => {
                          const key = sourceKey(
                            candidate.sourceType,
                            candidate.sourceId,
                          );
                          const holder = claimedElsewhere.get(key);
                          const claimId = `mb-claim-${candidate.sourceType}-${candidate.sourceId}`;
                          return (
                            <Field key={key}>
                              {/* The chip stays outside the label so it
                                  describes the box rather than becoming part
                                  of its name, and the box is disabled because
                                  the server would only refuse the claim with a
                                  409 after the operator saved. */}
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selection.has(key)}
                                  disabled={holder !== undefined}
                                  aria-describedby={
                                    holder !== undefined ? claimId : undefined
                                  }
                                  onChange={(event) => {
                                    const next = new Set(selection);
                                    if (event.currentTarget.checked) next.add(key);
                                    else next.delete(key);
                                    setSelection(next);
                                  }}
                                />{' '}
                                {candidate.label}
                              </label>
                              {holder !== undefined && (
                                <StatusChip status="cancelled" id={claimId}>
                                  claimed by {holder}
                                </StatusChip>
                              )}
                            </Field>
                          );
                        })
                      ) : (
                        <p className="text-muted-foreground">None available.</p>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Save source selection
                </Button>
              </Actions>
            </form>
          )}

          {/* A status region, not an alert: these warnings are part of the
              view as it opens rather than a response to something the
              operator just did. */}
          {detail.warnings.length > 0 && (
            <div role="status">
              <p className="my-2 text-[13px] font-medium text-destructive">
                The payment matrix cannot price every selected item — finalizing will be
                refused until the missing category rows exist:
              </p>
              <ul>
                {detail.warnings.map((warning) => (
                  <li key={warning.workItemId}>
                    {warning.itemNumber}: no{' '}
                    <a href={workHash(workId, 'schedules')}>payment matrix</a> row for{' '}
                    {warning.missingCategory}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.lines.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
                {book.status === 'draft'
                  ? 'Live preview of the Measurement Book lines'
                  : 'Finalized Measurement Book lines'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Schedule/Sr</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className={numericCell}>
                    Supplied Δ
                  </th>
                  <th scope="col" className={numericCell}>
                    Installed Δ
                  </th>
                  <th scope="col" className={numericCell}>
                    PAC Δ
                  </th>
                  <th scope="col" className={numericCell}>
                    Amount
                  </th>
                  <th scope="col">Remark</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <MeasurementLineRow key={line.workItemId} line={line} />
                ))}
              </tbody>
              {/* The total belongs in the foot so it is announced as the
                  table's summary rather than as one more data row. This
                  screen is not what gets printed — the MB PDF is rendered
                  server-side from its own template — and the server stays
                  authoritative for the figure itself. */}
              <tfoot>
                <tr>
                  <th scope="row" colSpan={6}>
                    Total payable this MB
                  </th>
                  <td className={numericCell}>
                    <strong>
                      {detail.previewTotal !== null
                        ? formatInr(detail.previewTotal)
                        : '—'}
                    </strong>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </DataTable>
          ) : (
            <p className="text-muted-foreground">
              Nothing to bill yet — select sources with unbilled quantities.
            </p>
          )}

          <Actions>
            {book.status === 'draft' && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    await openPdf(() =>
                      api.downloadMeasurementBookDraftPreview(organisationId, book.id),
                    );
                  }, 'Draft preview PDF opened in a new tab (watermarked DRAFT; nothing is stored).');
                }}
              >
                Preview PDF (draft)
              </Button>
            )}
            {/* A record MB never finalizes — it merges or is deleted — so
                the offer would only ever be a refusal. */}
            {book.status === 'draft' && canIssue && book.kind !== 'record' && (
              <Button
                disabled={pending}
                aria-haspopup="dialog"
                onClick={() => {
                  setConfirmingDelete(false);
                  setConfirmingUnmerge(false);
                  setConfirmingFinalize(true);
                }}
              >
                Finalize…
              </Button>
            )}
            {/* An absorbing draft cannot be deleted (the server refuses with
                MB_HAS_MERGED_RECORDS); un-merge is its way apart. */}
            {book.status === 'draft' && canModify && absorbedRecords.length === 0 && (
              <Button
                variant="outline"
                disabled={pending}
                aria-haspopup="dialog"
                onClick={() => {
                  setConfirmingFinalize(false);
                  setConfirmingUnmerge(false);
                  setConfirmingDelete(true);
                }}
              >
                Delete draft…
              </Button>
            )}
            {book.status === 'draft' && canModify && absorbedRecords.length > 0 && (
              <Button
                variant="outline"
                disabled={pending}
                aria-haspopup="dialog"
                onClick={() => {
                  setConfirmingFinalize(false);
                  setConfirmingDelete(false);
                  setConfirmingUnmerge(true);
                }}
              >
                Unmerge record drafts…
              </Button>
            )}
            {book.status === 'finalized' &&
              canIssue &&
              canPrepareBill &&
              book.billId === null && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    tryAct(async () => {
                      await api.prepareBillFromMeasurementBook(organisationId, book.id);
                      await openBook(book.id);
                      await refreshList();
                      onBillPrepared();
                    }, 'Bill prepared from this Measurement Book — see the Bills section.');
                  }}
                >
                  Prepare bill
                </Button>
              )}
            {book.status === 'finalized' && canModify && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    setDetail(await api.renderMeasurementBook(organisationId, book.id));
                    await refreshList();
                  }, 'Measurement Book PDF rendered and stored.');
                }}
              >
                {book.renderedAvailable ? 'Re-render PDF' : 'Render PDF'}
              </Button>
            )}
            {book.renderedAvailable && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    await openPdf(() =>
                      api.downloadMeasurementBookPdf(organisationId, book.id),
                    );
                  }, 'Measurement Book PDF opened in a new tab.');
                }}
              >
                Open PDF
              </Button>
            )}
          </Actions>

          {book.status === 'draft' &&
            canIssue &&
            book.kind !== 'record' &&
            confirmingFinalize && (
              <ConfirmDialog
                title="Confirm finalize"
                description={`Finalizing freezes this Measurement Book as an immutable numbered snapshot — next number ${nextNumber} — and claims its sources for good. Continue?`}
                cancelLabel="Keep drafting"
                confirmLabel="Finalize now"
                tone="default"
                pending={pending}
                onCancel={() => {
                  setConfirmingFinalize(false);
                }}
                onConfirm={() => {
                  tryAct(async () => {
                    const finalized = await api.finalizeMeasurementBook(
                      organisationId,
                      book.id,
                    );
                    setDetail(finalized);
                    setConfirmingFinalize(false);
                    setCandidates(null);
                    await refreshList();
                  }, 'Measurement Book finalized.');
                }}
              />
            )}

          {/* Deleting is the one unrecoverable draft action, so it gets the
              same two-step treatment as the recoverable finalize above. */}
          {book.status === 'draft' && canModify && confirmingDelete && (
            <ConfirmDialog
              title="Confirm delete"
              description="Deleting discards this draft and its lines for good, and releases every source it claimed — those challans, installations and PACs become billable by another Measurement Book again. Continue?"
              cancelLabel="Keep drafting"
              confirmLabel="Delete draft now"
              pending={pending}
              onCancel={() => {
                setConfirmingDelete(false);
              }}
              onConfirm={() => {
                tryAct(async () => {
                  await api.deleteMeasurementBook(organisationId, book.id);
                  setDetail(null);
                  setConfirmingDelete(false);
                  await refreshList();
                }, 'Draft deleted; its source claims are released.');
              }}
            />
          )}

          {/* Un-merge undoes a merge exactly: it restores what the merge
              took, releases what was added since, and the emptied draft
              goes. Irreversible in the same way delete is, so it gets the
              same two-step treatment. */}
          {book.status === 'draft' && canModify && confirmingUnmerge && (
            <ConfirmDialog
              title="Confirm unmerge"
              description={
                <>
                  Un-merging takes this draft apart: each of the{' '}
                  {String(absorbedRecords.length)} absorbed record Measurement Book
                  {absorbedRecords.length === 1 ? '' : 's'} returns to draft holding
                  exactly the sources the merge took from it, sources selected on this
                  draft after the merge are released, and this emptied draft is deleted.
                  Continue?
                </>
              }
              cancelLabel="Keep the merged draft"
              confirmLabel="Unmerge now"
              pending={pending}
              onCancel={() => {
                setConfirmingUnmerge(false);
              }}
              onConfirm={() => {
                tryAct(async () => {
                  await api.unmergeMeasurementBook(organisationId, book.id);
                  setDetail(null);
                  setConfirmingUnmerge(false);
                  await refreshList();
                }, 'Unmerged: the record drafts are restored and the absorbing draft is deleted.');
              }}
            />
          )}

          {book.status === 'finalized' && canCancel && book.billId === null && (
            <>
              {/* The note is a question, not a record: it stays behind its
                  own verb so a finalized MB reads as what it is. The confirm
                  step below stays outside the panel — it is the second half
                  of the two-step, not part of the form. */}
              <Disclosure label="Cancel Measurement Book…">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    // Submitting only opens the confirm step below; the browser
                    // has enforced the note by now, and the irreversible act is
                    // authorised there against the MB number.
                    setConfirmingCancel(true);
                  }}
                >
                  <Field>
                    <label htmlFor="mb-cancel-note">
                      Cancellation note (only the newest live MB can cancel)
                    </label>
                    <input
                      id="mb-cancel-note"
                      name="mb-cancel-note"
                      value={cancelNote}
                      onChange={(event) => {
                        // Rewording the note withdraws the confirmation: what is
                        // confirmed must be the wording that gets stored.
                        setCancelNote(event.target.value);
                        setConfirmingCancel(false);
                      }}
                      required
                      minLength={3}
                      maxLength={1000}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={pending}
                    aria-haspopup="dialog"
                  >
                    Continue to confirmation
                  </Button>
                </form>
              </Disclosure>
              {confirmingCancel && (
                <ConfirmDialog
                  title="Confirm cancellation"
                  description={`Measurement Book ${mbNumberLabel} will be cancelled. This cannot be undone: the number ${mbNumberLabel} is retained forever and can never be reused, the sources it billed are released for a later MB, and the note above is stored on the record.`}
                  cancelLabel="Keep this Measurement Book"
                  confirmLabel={`Cancel ${mbNumberLabel} now`}
                  pending={pending}
                  onCancel={() => {
                    setConfirmingCancel(false);
                  }}
                  onConfirm={() => {
                    tryAct(async () => {
                      const cancelled = await api.cancelMeasurementBook(
                        organisationId,
                        book.id,
                        cancelNote.trim(),
                      );
                      setDetail(cancelled);
                      setConfirmingCancel(false);
                      await refreshList();
                    }, 'Measurement Book cancelled; its number is retained and its sources are released.');
                  }}
                />
              )}
            </>
          )}
          {book.status === 'finalized' && book.billId !== null && (
            <p className="text-muted-foreground">
              A bill was prepared from this Measurement Book; it is permanently locked —
              corrections happen as compensating entries on the next MB.
            </p>
          )}
          {/* The other side of the contract. A finalized measurement is
              this agency's statement; the railway's own On-Account Bill is
              its answer, and until that answer arrives and verifies the
              measurement is outstanding with the railway. */}
          {book.status === 'finalized' && (
            <RailwayBillPanel
              api={api}
              organisationId={organisationId}
              workId={workId}
              book={book}
              canIssue={canIssue}
              canCancel={canCancel}
              onClosed={async () => {
                await openBook(book.id);
                await refreshList();
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
