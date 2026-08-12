import { useCallback, useEffect, useState } from 'react';
import type {
  ExtensionRequest,
  ExtensionResponseOutcome,
  WorkCompletionResponse,
} from '@auto-mb/contracts';
import {
  existingRecordIdOf,
  formValue,
  RequestFailedError,
  type ApiClient,
} from '../api.js';
import { openPdf } from '../lib/openPdf.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, FormNotice } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

interface CompletionExtensionsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  /** Holds can_approve_amendments — gates manual back-fill deletion. */
  readonly canApprove: boolean;
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
}: CompletionExtensionsProps) {
  const [completion, setCompletion] = useState<WorkCompletionResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
          cause instanceof RequestFailedError
            ? cause.message
            : 'The completion details could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId]);

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
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The action failed; nothing was changed.',
        );
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
        <FormError>{loadError}</FormError>
      </>
    );
  }

  if (completion === null) {
    return (
      <>
        <h2>Completion &amp; extensions</h2>
        <p className="text-muted-foreground" role="status">
          Loading completion details…
        </p>
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
        <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
          <div>
            <dt>Original completion date</dt>
            <dd>{dates.originalCompletionDate}</dd>
          </div>
          <div>
            <dt>Current completion date</dt>
            <dd>{dates.currentCompletionDate}</dd>
          </div>
        </dl>
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
              <tr key={extension.id}>
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
          label="Save draft extension request"
          startOpen={extensions.length === 0}
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
                await api.createExtensionRequest(organisationId, workId, {
                  proposedCompletionDate,
                  reason,
                  addressee,
                  ...(letterDate.length > 0 ? { letterDate } : {}),
                });
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
        <Disclosure label="Record paper letter as final">
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
        <Disclosure label="Upload response">
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
        <Disclosure label="Record response">
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
