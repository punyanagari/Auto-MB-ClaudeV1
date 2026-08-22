import { useCallback, useEffect, useState } from 'react';
import type {
  ExtensionRequest,
  ExtensionResponseOutcome,
  WorkCompletionResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, formValue, type ApiClient } from '../api.js';
import { formatDate, todayIso } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { openPdf } from '../lib/openPdf.js';
import { useReload, useReveal } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Stat } from '../ui/stat.js';
import { DataTable } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, FormNotice } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';

interface CompletionExtensionsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  /** Holds can_approve_amendments — gates manual back-fill deletion. */
  readonly canApprove: boolean;
  /** The address asked for this panel by name (`?focus=extension`, from
   * the dashboard's completion panel). The composer opens expanded and
   * the proposed-date field takes focus, so the operator lands on the
   * first thing they have to decide instead of most of an Overview above
   * it. Nothing is pre-filled: a proposal equal to the current date is
   * not an extension, and the grounds are the substance of the letter. */
  readonly openComposer?: boolean;
}

/**
 * The Work's completion ledger: the one-time completion-date set, the DOC
 * extension-request lifecycle (draft -> finalised -> responded), the
 * railway response upload, and the history. The current completion date
 * itself is never edited here — it moves only when the server applies a
 * responded extension.
 */
export function CompletionExtensions({
  api,
  organisationId,
  workId,
  canModify,
  canIssue,
  canApprove,
  openComposer = false,
}: CompletionExtensionsProps) {
  const [completion, setCompletion] = useState<WorkCompletionResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { reveal, revealProps } = useReveal();
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setCompletion(null);
    setLoadError(null);
    api
      .getWorkCompletion(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setCompletion(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The completion details could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  /* The address's intent, once the composer it names actually exists.
   *
   * The panel reads before it can render a form, so this waits on
   * `completion` rather than firing on mount into an empty page. It looks
   * the field up by its own static id: the composer is behind a
   * Disclosure that unmounts its children, so a ref held here would be
   * null exactly when the panel is closed, and the id is the same one the
   * label points at. Scrolled instantly — an animated jump is a new
   * animation, and this product disables those under
   * `prefers-reduced-motion` rather than shipping one that ignores it. */
  useEffect(() => {
    if (!openComposer || completion === null) return;
    const field = document.getElementById('extension-proposed');
    if (!(field instanceof HTMLInputElement)) return;
    // Optional call, exactly as `lib/view-state.ts` reveals a row: jsdom
    // does not implement `scrollIntoView`, and the FOCUS is the part that
    // has to happen — a component test proving the field is focused is
    // worth more than one that throws on the scroll before reaching it.
    field.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    field.focus();
  }, [openComposer, completion]);

  const reload = useCallback(async () => {
    setCompletion(await api.getWorkCompletion(organisationId, workId));
  }, [api, organisationId, workId]);

  const act = useCallback(
    async (work: () => Promise<void>, done: string) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
      } catch (cause) {
        setActionError(errorMessage(cause));
        // A one-draft 409 names the draft that already occupies the slot
        // (created in another tab or by a colleague): reload so the view
        // switches to that existing draft instead of a dead-ended form.
        if (existingRecordIdOf(cause) !== null) {
          await reload().catch(() => undefined);
        }
      } finally {
        setPending(false);
      }
    },
    [reload],
  );

  if (loadError !== null) {
    return (
      <>
        <h2>Completion &amp; extensions</h2>
        <ErrorState onRetry={retry} retryLabel="Retry completion details">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (completion === null) {
    return (
      <>
        <h2>Completion &amp; extensions</h2>
        <LoadingState label="the completion details" rows={3} />
      </>
    );
  }

  const dates = completion.completion;
  const extensions = completion.extensionRequests;
  const draft = extensions.find((extension) => extension.status === 'draft');

  return (
    <>
      <h2>Completion &amp; extensions</h2>
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      {dates.currentCompletionDate !== null ? (
        /* The mock's gapless tile grid (Auto-MB-Vercel-du,
           components/work-registers.tsx at fdfe5ef). The two dates are
           what this panel exists to compare, so they are the metrics —
           mono and tabular, which is what lets the eye see at a glance
           whether the second has moved from the first. Both go through
           `formatDate`: they arrive as date-only `YYYY-MM-DD` and used to
           render raw. */
        <div className="mt-3 mb-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          <div className="bg-card p-4">
            <Stat
              label="Original completion date"
              value={
                dates.originalCompletionDate === null
                  ? '—'
                  : formatDate(dates.originalCompletionDate)
              }
            />
          </div>
          <div className="bg-card p-4">
            <Stat
              label="Current completion date"
              value={formatDate(dates.currentCompletionDate)}
            />
          </div>
        </div>
      ) : canModify ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const completionDate = formValue(data, 'completion-date');
            void act(async () => {
              setCompletion(
                await api.setCompletionDate(organisationId, workId, {
                  completionDate,
                }),
              );
            }, 'Completion date recorded.');
          }}
        >
          <p className="text-muted-foreground">
            Record the contract completion date once; afterwards it changes only through
            a responded extension request.
          </p>
          <Field>
            <label htmlFor="completion-date">Completion date (per the contract)</label>
            <input id="completion-date" name="completion-date" type="date" required />
          </Field>
          <Actions>
            <Button type="submit" disabled={pending}>
              Set completion date
            </Button>
          </Actions>
        </form>
      ) : (
        <p className="text-muted-foreground">No completion date recorded yet.</p>
      )}

      {extensions.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Extension requests for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Proposed date</th>
              <th scope="col">Letter date</th>
              <th scope="col">Outcome</th>
              <th scope="col">Granted date</th>
            </tr>
          </thead>
          <tbody>
            {extensions.map((extension) => (
              <tr key={extension.id} {...revealProps(extension.id)}>
                <th scope="row">{extension.requestNumber ?? 'Draft'}</th>
                <td>
                  {extension.source === 'manual'
                    ? `paper — ${extension.manualReference ?? ''}`
                    : 'software'}
                </td>
                <td>
                  <StatusChip status={extension.status} />
                </td>
                <td>{extension.proposedCompletionDate}</td>
                <td>{extension.letterDate ?? '—'}</td>
                <td>{extension.responseOutcome ?? '—'}</td>
                <td>{extension.grantedCompletionDate ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No extension requests yet.</p>
      )}

      {draft !== undefined && (
        <Actions>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await openPdf(() =>
                  api.downloadExtensionDraftPreview(organisationId, draft.id),
                );
              }, 'Draft preview opened — watermarked DRAFT, no number until finalised.')
            }
          >
            Preview draft (DRAFT watermark)
          </Button>
          {canIssue && (
            <Button
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  await api.finaliseExtensionRequest(organisationId, draft.id);
                  reveal(draft.id);
                  await reload();
                }, 'Extension request finalised and numbered.')
              }
            >
              Finalise extension request
            </Button>
          )}
          {canModify && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  await api.deleteExtensionRequest(organisationId, draft.id);
                  await reload();
                }, 'Draft extension request deleted.')
              }
            >
              Delete draft
            </Button>
          )}
        </Actions>
      )}

      {canModify && dates.currentCompletionDate !== null && draft === undefined && (
        <Disclosure
          label="New extension request"
          startOpen={openComposer || extensions.length === 0}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const proposedCompletionDate = formValue(data, 'extension-proposed');
              const reason = formValue(data, 'extension-reason');
              const addressee = formValue(data, 'extension-addressee');
              const letterDate = formValue(data, 'extension-letter-date');
              void act(async () => {
                const created = await api.createExtensionRequest(
                  organisationId,
                  workId,
                  {
                    proposedCompletionDate,
                    reason,
                    addressee,
                    ...(letterDate.length > 0 ? { letterDate } : {}),
                  },
                );
                reveal(created.extensionRequest.id);
                await reload();
                form.reset();
              }, 'Draft extension request created.');
            }}
          >
            <Field>
              <label htmlFor="extension-proposed">Proposed completion date</label>
              <input
                id="extension-proposed"
                name="extension-proposed"
                type="date"
                required
              />
            </Field>
            <Field>
              <label htmlFor="extension-addressee">Addressee</label>
              <input
                id="extension-addressee"
                name="extension-addressee"
                required
                maxLength={200}
              />
            </Field>
            <Field>
              <label htmlFor="extension-letter-date">Letter date</label>
              <input
                id="extension-letter-date"
                name="extension-letter-date"
                type="date"
                required
                defaultValue={todayIso()}
              />
            </Field>
            <Field>
              <label htmlFor="extension-reason">Grounds for the extension</label>
              <textarea
                id="extension-reason"
                name="extension-reason"
                required
                minLength={3}
                maxLength={5000}
                rows={4}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Save draft extension request
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {canIssue && dates.currentCompletionDate !== null && (
        <Disclosure label="Record paper letter as final…">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void act(async () => {
                const result = await api.backfillExtensionRequest(
                  organisationId,
                  workId,
                  {
                    reference: formValue(data, 'backfill-reference').trim(),
                    letterDate: formValue(data, 'backfill-letter-date'),
                    proposedCompletionDate: formValue(data, 'backfill-proposed'),
                    reason: formValue(data, 'backfill-reason'),
                    addressee: formValue(data, 'backfill-addressee'),
                  },
                );
                reveal(result.extensionRequest.id);
                await reload();
                form.reset();
                if (result.warnings.length > 0) {
                  setActionError(result.warnings.join(' '));
                }
              }, `Paper letter recorded as final — it took the next number in the sequence.`);
            }}
          >
            <p className="text-muted-foreground">
              For letters issued on paper before this register was adopted. The record
              is final on arrival, takes the next number in the sequence, and is never
              rendered — the paper letter stays the record. Back-fill letters in the
              order they were issued.
            </p>
            <FieldRow>
              <Field>
                <label htmlFor="backfill-reference">Paper letter reference</label>
                <input
                  id="backfill-reference"
                  name="backfill-reference"
                  required
                  minLength={1}
                  maxLength={100}
                />
              </Field>
              <Field>
                <label htmlFor="backfill-letter-date">Paper letter date</label>
                <input
                  id="backfill-letter-date"
                  name="backfill-letter-date"
                  type="date"
                  required
                />
              </Field>
              <Field>
                <label htmlFor="backfill-proposed">
                  Completion date the letter asked for
                </label>
                <input
                  id="backfill-proposed"
                  name="backfill-proposed"
                  type="date"
                  required
                />
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor="backfill-addressee">Addressee of the letter</label>
              <input
                id="backfill-addressee"
                name="backfill-addressee"
                required
                maxLength={200}
              />
            </Field>
            <Field>
              <label htmlFor="backfill-reason">Grounds stated in the letter</label>
              <textarea
                id="backfill-reason"
                name="backfill-reason"
                required
                minLength={3}
                maxLength={5000}
                rows={3}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Record paper letter as final
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {extensions
        .filter((extension) => extension.status === 'finalised')
        .map((extension) => (
          <FinalisedExtensionActions
            key={extension.id}
            api={api}
            organisationId={organisationId}
            extension={extension}
            canModify={canModify}
            canApprove={canApprove}
            pending={pending}
            act={act}
            reload={reload}
          />
        ))}
    </>
  );
}

interface FinalisedExtensionActionsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly extension: ExtensionRequest;
  readonly canModify: boolean;
  readonly canApprove: boolean;
  readonly pending: boolean;
  readonly act: (work: () => Promise<void>, done: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

/** Response handling for one finalised request: upload the railway's
 * answer, then record the outcome — accepted applies the proposed date,
 * modified applies the granted date, rejected changes nothing. Manual
 * back-fills additionally offer approval-gated deletion while they hold
 * the top of the sequence. */
function FinalisedExtensionActions({
  api,
  organisationId,
  extension,
  canModify,
  canApprove,
  pending,
  act,
  reload,
}: FinalisedExtensionActionsProps) {
  const [outcome, setOutcome] = useState<ExtensionResponseOutcome>('accepted');
  if (!canModify) return null;
  return (
    <div>
      <h3>Railway response — {extension.requestNumber}</h3>
      {extension.source === 'manual' && canApprove && (
        <Actions>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await api.deleteExtensionRequest(organisationId, extension.id);
                await reload();
              }, 'Manual back-fill deleted; its number returns to the sequence.')
            }
          >
            Delete manual back-fill (top of sequence only)
          </Button>
        </Actions>
      )}
      {!extension.responseDocumentAvailable && (
        <Disclosure label="Upload response…">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = event.currentTarget.elements.namedItem(
                `response-file-${extension.id}`,
              );
              const file =
                input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
              if (file === null) return;
              void act(async () => {
                await api.uploadExtensionResponse(organisationId, extension.id, file);
                await reload();
              }, 'Railway response uploaded.');
            }}
          >
            <Field>
              <label htmlFor={`response-file-${extension.id}`}>
                Railway response (PDF)
              </label>
              <input
                id={`response-file-${extension.id}`}
                name={`response-file-${extension.id}`}
                type="file"
                accept="application/pdf"
                required
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Upload response
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
      {extension.responseDocumentAvailable && (
        <Disclosure label="Record response…">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const grantedCompletionDate = formValue(
                data,
                `response-granted-${extension.id}`,
              );
              void act(async () => {
                await api.respondExtensionRequest(organisationId, extension.id, {
                  outcome,
                  ...(outcome === 'modified' ? { grantedCompletionDate } : {}),
                });
                await reload();
              }, 'Response recorded.');
            }}
          >
            <Field>
              <label htmlFor={`response-outcome-${extension.id}`}>Outcome</label>
              <select
                id={`response-outcome-${extension.id}`}
                name={`response-outcome-${extension.id}`}
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value as ExtensionResponseOutcome);
                }}
              >
                <option value="accepted">accepted — proposed date granted</option>
                <option value="modified">modified — a different date granted</option>
                <option value="rejected">rejected — no extension</option>
              </select>
            </Field>
            {outcome === 'modified' && (
              <Field>
                <label htmlFor={`response-granted-${extension.id}`}>
                  Granted completion date
                </label>
                <input
                  id={`response-granted-${extension.id}`}
                  name={`response-granted-${extension.id}`}
                  type="date"
                  required
                />
              </Field>
            )}
            <Actions>
              <Button type="submit" disabled={pending}>
                Record response
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </div>
  );
}
