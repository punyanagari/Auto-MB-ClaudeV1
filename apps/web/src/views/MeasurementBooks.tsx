import { useCallback, useEffect, useState } from 'react';
import type {
  Challan,
  Installation,
  MbSourceRef,
  MbSourceType,
  MeasurementBook,
  MeasurementBookDetailResponse,
  PacCertificate,
} from '@auto-mb/contracts';
import {
  existingRecordIdOf,
  formValue,
  RequestFailedError,
  type ApiClient,
} from '../api.js';
import { formatInr } from '../format.js';

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
  /** Cancelling a finalized MB runs under the cancel authority
   * (membership.canCancelDocuments), matching the challan detail
   * screens. */
  readonly canCancel: boolean;
  /** Lets the Work page refresh its Bills section once a bill is
   * prepared from a finalized MB. */
  readonly onBillPrepared: () => void;
}

function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
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
  canCancel,
  onBillPrepared,
}: MeasurementBooksProps) {
  const [books, setBooks] = useState<readonly MeasurementBook[] | null>(null);
  const [detail, setDetail] = useState<MeasurementBookDetailResponse | null>(null);
  const [candidates, setCandidates] = useState<readonly SourceCandidate[] | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [claimedElsewhere, setClaimedElsewhere] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [existingDraftId, setExistingDraftId] = useState<string | null>(null);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
        if (!cancelled) setBooks(loaded.books);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Measurement Books could not be loaded.',
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
      throw cause;
    } finally {
      setPending(false);
    }
  }, []);

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
    setBooks((await api.listWorkMeasurementBooks(organisationId, workId)).books);
  }, [api, organisationId, workId]);

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
          label: `${challan.challanNumber ?? challan.id} · ${challan.challanDate}`,
        })),
      ...installationList.installations
        .filter((installation: Installation) => installation.status === 'recorded')
        .map((installation) => ({
          sourceType: 'installation' as const,
          sourceId: installation.id,
          label: `${installation.itemNumber} × ${installation.quantity} · ${installation.installedOn} · ${installation.locationName}`,
        })),
      ...pacList.certificates
        .filter((certificate: PacCertificate) => certificate.status === 'recorded')
        .map((certificate) => ({
          sourceType: 'pac_certificate' as const,
          sourceId: certificate.id,
          label: `${certificate.reference} · ${certificate.issueDate}`,
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

  if (loadError !== null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </>
    );
  }

  if (books === null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <p className="muted" role="status">
          Loading Measurement Books…
        </p>
      </>
    );
  }

  const nextSequence =
    books.reduce((highest, book) => Math.max(highest, book.sequenceNumber ?? 0), 0) + 1;
  const nextNumber = String(nextSequence).padStart(2, '0');
  const hasDraft = books.some((book) => book.status === 'draft');
  const liveFinal = books.some((book) => book.isFinal && book.status !== 'cancelled');
  const book = detail?.book ?? null;
  /** A finalized MB always carries its number; the fallback exists only
   * because the shared contract type keeps it nullable for drafts. */
  const mbNumberLabel = book?.mbNumber ?? 'this Measurement Book';

  return (
    <>
      <h2>Measurement Books</h2>
      <p className="muted">
        Stage-wise billing documents built from the Work&apos;s unbilled sources. A
        draft recomputes from live state; finalizing assigns the next gap-free MB number
        and freezes the snapshot; the bill is prepared from the finalized MB.
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

      {books.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Measurement Books raised on this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className="cell--numeric">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {books.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <button
                    type="button"
                    className="button--link"
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
                  </button>{' '}
                  {row.isFinal && <span className="chip chip--issued">FINAL BILL</span>}
                </th>
                <td>{row.mbDate}</td>
                <td>
                  <span className={`chip chip--${row.status}`}>{row.status}</span>
                </td>
                <td className="cell--numeric">
                  {row.totalAmount !== null ? formatInr(row.totalAmount) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No Measurement Books raised yet.</p>
      )}

      {canModify && !hasDraft && !liveFinal && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const mbDate = formValue(data, 'mb-draft-date');
            const isFinal = data.get('mb-draft-final') === 'on';
            setExistingDraftId(null);
            tryAct(async () => {
              try {
                const created = await api.createWorkMeasurementBook(
                  organisationId,
                  workId,
                  { mbDate, ...(isFinal ? { isFinal } : {}) },
                );
                await refreshList();
                await openBook(created.book.id);
                form.reset();
              } catch (cause) {
                const existing = existingRecordIdOf(cause);
                if (existing !== null) setExistingDraftId(existing);
                throw cause;
              }
            }, 'Draft Measurement Book created — select its sources below.');
          }}
        >
          <h3>New Measurement Book draft</h3>
          <div className="field">
            <label htmlFor="mb-draft-date">MB date</label>
            <input id="mb-draft-date" name="mb-draft-date" type="date" required />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" name="mb-draft-final" /> Final Measurement Book
            </label>
            <p className="muted">
              The final MB bills the final-bill stage and must sweep every remaining
              open source of the Work; once it is finalized, no further Measurement
              Books can be raised.
            </p>
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Create draft
            </button>
          </div>
        </form>
      )}
      {existingDraftId !== null && (
        <div className="actions">
          <button
            type="button"
            className="button--ghost"
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
          </button>
        </div>
      )}

      {detail !== null && book !== null && (
        <div className="detail-block">
          <h3>
            Measurement Book {book.mbNumber ?? 'draft'} · {book.mbDate}{' '}
            <span className={`chip chip--${book.status}`}>{book.status}</span>{' '}
            {book.isFinal && <span className="chip chip--issued">FINAL BILL</span>}
          </h3>
          {book.status === 'cancelled' && book.cancellationNote !== null && (
            <p className="muted">Cancelled: {book.cancellationNote}</p>
          )}

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
                            <div className="field" key={key}>
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
                                <span className="chip chip--cancelled" id={claimId}>
                                  claimed by {holder}
                                </span>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <p className="muted">None available.</p>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Save source selection
                </button>
              </div>
            </form>
          )}

          {/* A status region, not an alert: these warnings are part of the
              view as it opens rather than a response to something the
              operator just did. */}
          {detail.warnings.length > 0 && (
            <div role="status">
              <p className="form-error">
                The payment matrix cannot price every selected item — finalizing will be
                refused until the missing category rows exist:
              </p>
              <ul>
                {detail.warnings.map((warning) => (
                  <li key={warning.workItemId}>
                    {warning.itemNumber}: no{' '}
                    <a href="#payment-matrix">payment matrix</a> row for{' '}
                    {warning.missingCategory}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.lines.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                {book.status === 'draft'
                  ? 'Live preview of the Measurement Book lines'
                  : 'Finalized Measurement Book lines'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Schedule/Sr</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="cell--numeric">
                    Supplied Δ
                  </th>
                  <th scope="col" className="cell--numeric">
                    Installed Δ
                  </th>
                  <th scope="col" className="cell--numeric">
                    PAC Δ
                  </th>
                  <th scope="col" className="cell--numeric">
                    Amount
                  </th>
                  <th scope="col">Remark</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.workItemId}>
                    <th scope="row">{line.itemNumber}</th>
                    <td className="cell--wrap">{line.description}</td>
                    <td>{line.unitCode}</td>
                    <td className="cell--numeric">{line.deltaSupplied}</td>
                    <td className="cell--numeric">{line.deltaInstalled}</td>
                    <td className="cell--numeric">{line.deltaPac}</td>
                    <td className="cell--numeric">{formatInr(line.lineTotal)}</td>
                    <td className="cell--wrap">{line.remark}</td>
                  </tr>
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
                  <td className="cell--numeric">
                    <strong>
                      {detail.previewTotal !== null
                        ? formatInr(detail.previewTotal)
                        : '—'}
                    </strong>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <p className="muted">
              Nothing to bill yet — select sources with unbilled quantities.
            </p>
          )}

          <div className="actions">
            {book.status === 'draft' && (
              <button
                type="button"
                className="button--ghost"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    openPdf(
                      await api.downloadMeasurementBookDraftPreview(
                        organisationId,
                        book.id,
                      ),
                    );
                  }, 'Draft preview PDF opened in a new tab (watermarked DRAFT; nothing is stored).');
                }}
              >
                Preview PDF (draft)
              </button>
            )}
            {book.status === 'draft' && canIssue && !confirmingFinalize && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setConfirmingDelete(false);
                  setConfirmingFinalize(true);
                }}
              >
                Finalize…
              </button>
            )}
            {book.status === 'draft' && canModify && !confirmingDelete && (
              <button
                type="button"
                className="button--ghost"
                disabled={pending}
                onClick={() => {
                  setConfirmingFinalize(false);
                  setConfirmingDelete(true);
                }}
              >
                Delete draft…
              </button>
            )}
            {book.status === 'finalized' && canIssue && book.billId === null && (
              <button
                type="button"
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
              </button>
            )}
            {book.status === 'finalized' && canModify && (
              <button
                type="button"
                className="button--ghost"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    setDetail(await api.renderMeasurementBook(organisationId, book.id));
                    await refreshList();
                  }, 'Measurement Book PDF rendered and stored.');
                }}
              >
                {book.renderedAvailable ? 'Re-render PDF' : 'Render PDF'}
              </button>
            )}
            {book.renderedAvailable && (
              <button
                type="button"
                className="button--ghost"
                disabled={pending}
                onClick={() => {
                  tryAct(async () => {
                    openPdf(
                      await api.downloadMeasurementBookPdf(organisationId, book.id),
                    );
                  }, 'Measurement Book PDF opened in a new tab.');
                }}
              >
                Open PDF
              </button>
            )}
          </div>

          {book.status === 'draft' && canIssue && confirmingFinalize && (
            <div className="detail-block">
              <h4>Confirm finalize</h4>
              <p>
                Finalizing freezes this Measurement Book as an immutable numbered
                snapshot — next number {nextNumber} — and claims its sources for good.
                Continue?
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
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
                >
                  Finalize now
                </button>
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => {
                    setConfirmingFinalize(false);
                  }}
                >
                  Keep drafting
                </button>
              </div>
            </div>
          )}

          {/* Deleting is the one unrecoverable draft action, so it gets the
              same two-step treatment as the recoverable finalize above. */}
          {book.status === 'draft' && canModify && confirmingDelete && (
            <div className="detail-block">
              <h4>Confirm delete</h4>
              <p>
                Deleting discards this draft and its lines for good, and releases every
                source it claimed — those challans, installations and PACs become
                billable by another Measurement Book again. Continue?
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    tryAct(async () => {
                      await api.deleteMeasurementBook(organisationId, book.id);
                      setDetail(null);
                      setConfirmingDelete(false);
                      await refreshList();
                    }, 'Draft deleted; its source claims are released.');
                  }}
                >
                  Delete draft now
                </button>
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => {
                    setConfirmingDelete(false);
                  }}
                >
                  Keep drafting
                </button>
              </div>
            </div>
          )}

          {book.status === 'finalized' && canCancel && book.billId === null && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  // Submitting only opens the confirm step below; the browser
                  // has enforced the note by now, and the irreversible act is
                  // authorised there against the MB number.
                  setConfirmingCancel(true);
                }}
              >
                <div className="field">
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
                </div>
                {!confirmingCancel && (
                  <button type="submit" className="button--ghost" disabled={pending}>
                    Cancel Measurement Book…
                  </button>
                )}
              </form>
              {confirmingCancel && (
                <div className="detail-block">
                  <h4>Confirm cancellation</h4>
                  <p>
                    Measurement Book {mbNumberLabel} will be cancelled. This cannot be
                    undone: the number {mbNumberLabel} is retained forever and can never
                    be reused, the sources it billed are released for a later MB, and
                    the note above is stored on the record.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
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
                    >
                      Cancel {mbNumberLabel} now
                    </button>
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        setConfirmingCancel(false);
                      }}
                    >
                      Keep this Measurement Book
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {book.status === 'finalized' && book.billId !== null && (
            <p className="muted">
              A bill was prepared from this Measurement Book; it is permanently locked —
              corrections happen as compensating entries on the next MB.
            </p>
          )}
        </div>
      )}
    </>
  );
}
