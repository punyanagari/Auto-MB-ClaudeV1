import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ContractSourceDocumentKind,
  LoaDocumentDetail,
  TenderDetail,
} from '@auto-mb/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FileText,
  Loader2,
  Upload,
} from 'lucide-react';
import { RequestFailedError, type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Badge } from '../ui/badge.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';
import { formatInr, formatLocalDateTime } from '../format.js';

/** Whether the tender behind an award deep link can still take a letter,
 * as a refusal sentence or null.
 *
 * The server refuses both of these too — `TENDER_NOT_AWARDED` and
 * `TENDER_ALREADY_AWARDED` — and that is the layer that matters. This one
 * exists so the refusal arrives before the upload rather than after it. */
function staleAwardLink(tender: TenderDetail): string | null {
  if (tender.status !== 'awarded') {
    return `Tender ${tender.tenderNumber} is ${tender.status}, not awarded, so a Letter of Acceptance cannot be recorded against it. Record the award on the tender first.`;
  }
  if (tender.award !== null) {
    return `Tender ${tender.tenderNumber} already has ${tender.award.loaFilename} recorded as its Letter of Acceptance. Open the tender to reach the Work it became.`;
  }
  return null;
}

interface UploadLoaProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The award conversion's deep link (migration 0083). When an awarded
   * tender sent the operator here, the screen shows that tender's facts
   * to check the letter against, and the accepted letter is recorded
   * against it — which is what makes the conversion a prefill of THIS
   * intake rather than a second way to create a Work. */
  readonly tenderId: string | null;
  readonly onUploaded: (document: LoaDocumentDetail) => void;
  /** Opens the LOA document a refusal named — the duplicate this upload
   * turned out to be. */
  readonly onOpenDocument: (documentId: string) => void;
  /** Opens the Work a duplicate letter was already confirmed into. */
  readonly onOpenWork: (workId: string) => void;
  readonly onCancel: () => void;
}

/**
 * Where a refusal points.
 *
 * LOA_DOCUMENT_DUPLICATE answers with the document already holding these
 * bytes (`details.existingRecordId`) and, when it has been confirmed,
 * the Work it became. The message has always named the file and the
 * date; naming a record and then making the operator go and find it is
 * the shape of dead end this pack exists to remove, so the id becomes
 * the button that opens it.
 */
interface ExistingRecord {
  readonly documentId: string;
  readonly confirmedWorkId: string | null;
}

function existingRecordOf(cause: unknown): ExistingRecord | null {
  if (!(cause instanceof RequestFailedError)) return null;
  const details = cause.details as {
    existingRecordId?: unknown;
    confirmedWorkId?: unknown;
  } | null;
  if (typeof details?.existingRecordId !== 'string') return null;
  return {
    documentId: details.existingRecordId,
    confirmedWorkId:
      typeof details.confirmedWorkId === 'string' ? details.confirmedWorkId : null,
  };
}

interface OptionalDocumentDefinition {
  readonly kind: ContractSourceDocumentKind;
  readonly label: string;
  readonly description: string;
}

const OPTIONAL_DOCUMENTS: readonly OptionalDocumentDefinition[] = [
  {
    kind: 'nit',
    label: 'Tender NIT',
    description: 'Notice Inviting Tender and tender identity details.',
  },
  {
    kind: 'contract_agreement',
    label: 'Contract Agreement',
    description: 'Signed agreement or contract document, when available.',
  },
  {
    kind: 'tender_specification',
    label: 'Tender document and specifications',
    description:
      'Payment terms, warranty or maintenance periods, release clauses and item specifications.',
  },
];

type UploadState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'accepted'; readonly filename: string }
  | {
      readonly status: 'rejected';
      readonly filename: string;
      readonly message: string;
    };

function fileOf(input: HTMLInputElement | null): File | null {
  return input?.files?.[0] ?? null;
}

function supportInputId(kind: ContractSourceDocumentKind): string {
  return `contract-source-${kind.replaceAll('_', '-')}`;
}

export function UploadLoa({
  api,
  organisationId,
  tenderId,
  onUploaded,
  onOpenDocument,
  onOpenWork,
  onCancel,
}: UploadLoaProps) {
  const [tender, setTender] = useState<TenderDetail | null>(null);
  /** Why this letter cannot be recorded against the tender the link
   * names — a read that failed, or a tender no longer able to take it. */
  const [tenderError, setTenderError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingRecord | null>(null);
  const [uploadedLoa, setUploadedLoa] = useState<LoaDocumentDetail | null>(null);
  const [supportStates, setSupportStates] = useState<
    Record<ContractSourceDocumentKind, UploadState>
  >({
    nit: { status: 'idle' },
    contract_agreement: { status: 'idle' },
    tender_specification: { status: 'idle' },
  });

  /**
   * The award conversion's PREFLIGHT.
   *
   * This read is not decoration. It is what makes the deep link safe: it
   * answers, before a 25 MB body is scanned and written to object
   * storage, whether the tender at the far end of the link will actually
   * take this letter. Without it the sequence was upload-then-ask, and a
   * link followed from a stale tab — the tender since marked lost, or
   * already converted from another window — stored the bytes, created an
   * LOA document, and only then reported that the tender would not have
   * it. The letter is then loose in the Works register with nothing
   * pointing at it.
   *
   * A failure to READ the tender is surfaced rather than swallowed, for
   * the same reason: silently dropping the panel turned "the link is
   * stale" into "the panel did not render", which reads as a layout bug
   * and invites the upload anyway.
   */
  useEffect(() => {
    if (tenderId === null) {
      setTender(null);
      setTenderError(null);
      return;
    }
    let cancelled = false;
    setTender(null);
    setTenderError(null);
    api
      .getTender(organisationId, tenderId)
      .then((loaded) => {
        if (cancelled) return;
        setTender(loaded);
        setTenderError(staleAwardLink(loaded));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setTenderError(
          errorMessage(
            cause,
            'The tender this letter is being uploaded for could not be read.',
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, tenderId]);

  const hasRejectedSupport = useMemo(
    () => Object.values(supportStates).some((state) => state.status === 'rejected'),
    [supportStates],
  );

  async function uploadSupport(
    loa: LoaDocumentDetail,
    definition: OptionalDocumentDefinition,
    file: File,
  ): Promise<boolean> {
    setSupportStates((current) => ({
      ...current,
      [definition.kind]: { status: 'pending' },
    }));
    try {
      await api.uploadContractSource(
        organisationId,
        loa.id,
        definition.kind,
        file,
        file.name,
      );
      setSupportStates((current) => ({
        ...current,
        [definition.kind]: { status: 'accepted', filename: file.name },
      }));
      return true;
    } catch (cause) {
      const message = errorMessage(cause, `${definition.label} could not be uploaded.`);
      setSupportStates((current) => ({
        ...current,
        [definition.kind]: { status: 'rejected', filename: file.name, message },
      }));
      return false;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setExisting(null);
    const form = event.currentTarget;
    // Refused BEFORE the bytes move. Uploading first and discovering the
    // tender will not take the letter afterwards leaves a stored document
    // nothing points at.
    if (tenderError !== null) {
      setError(tenderError);
      setPending(false);
      return;
    }
    const loaFile = fileOf(form.elements.namedItem('loa') as HTMLInputElement | null);
    if (uploadedLoa === null && loaFile === null) {
      setError('Choose the Letter of Acceptance PDF.');
      setPending(false);
      return;
    }

    try {
      const loa =
        uploadedLoa ??
        (await api.uploadLoa(organisationId, loaFile as File, (loaFile as File).name));
      setUploadedLoa(loa);

      // Recorded as soon as the letter exists, not after it is confirmed:
      // the tender points at the LETTER and the letter already points at
      // the Work it becomes, so one edge carries the whole chain and
      // there is nothing to keep in sync across the review step.
      //
      // Unconditional rather than first-submit-only, because writing the
      // same letter id onto the same tender again is a no-op and this
      // form retries: gating it on "the LOA was just uploaded" would make
      // a failed link unrepeatable, since the retry reuses the letter it
      // already has.
      if (tenderId !== null) {
        await api.linkTenderAwardLetter(organisationId, tenderId, loa.id);
      }

      // `pending` and `processing` are the normal answer now, not a
      // failure: since pack P18 the letter is read by the worker after the
      // upload is accepted, so a freshly uploaded document is always
      // `pending` here. Supporting documents attach against it regardless
      // — they hang off the LOA row, not off its extraction — and the
      // workspace lands the reviewer on the register, where the document
      // carries a Pending badge until the reading finishes.
      //
      // Only a document that was read and produced nothing reviewable is
      // an error, which is what `failed` means.
      if (loa.extractionStatus === 'failed' || loa.extractionStatus === 'discarded') {
        setError(
          'The LOA could not be extracted into a reviewable record. Supporting documents were not attached.',
        );
        return;
      }

      let allAccepted = true;
      for (const definition of OPTIONAL_DOCUMENTS) {
        const input = form.elements.namedItem(
          definition.kind,
        ) as HTMLInputElement | null;
        const file = fileOf(input);
        const previous = supportStates[definition.kind];
        if (file === null || previous.status === 'accepted') continue;
        if (!(await uploadSupport(loa, definition, file))) allAccepted = false;
      }

      if (allAccepted) onUploaded(loa);
    } catch (cause) {
      setExisting(existingRecordOf(cause));
      setError(
        errorMessage(
          cause,
          'The LOA package could not be uploaded. Nothing authoritative was created.',
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-[0.16em] text-primary uppercase">
            Contract intake
          </p>
          <h1 id="upload-loa-title" tabIndex={-1}>
            Upload contract documents
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The Letter of Acceptance is required. Tender documents are optional
            evidence; Auto-MB accepts them only when both the tender number and name of
            work match the LOA.
          </p>
        </div>
        <Badge variant="info">Human confirmation required</Badge>
      </header>

      {tenderError !== null && (
        <div className="mb-5">
          <FormError>{tenderError}</FormError>
        </div>
      )}

      {tender !== null && tenderError === null && (
        <div className="mb-5 rounded-xl border border-primary/25 bg-primary/5 p-4">
          <p className="m-0 text-sm font-medium">
            Creating the Work for tender{' '}
            <span className="font-mono tabular-nums">{tender.tenderNumber}</span>
          </p>
          <p className="mt-1 m-0 text-sm text-muted-foreground">
            {tender.authority} · {tender.title}
          </p>
          <p className="mt-1 m-0 text-xs text-muted-foreground">
            Closed{' '}
            <span className="font-mono tabular-nums">
              {formatLocalDateTime(tender.bidClosesAtLocal)}
            </span>
            {tender.estimatedValue !== null && (
              <>
                {' '}
                · estimated{' '}
                <span className="font-mono tabular-nums">
                  {formatInr(tender.estimatedValue)}
                </span>
              </>
            )}
            . Check the letter against these before uploading; the letter itself is what
            creates the Work, and Auto-MB will record it against this tender.
          </p>
        </div>
      )}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
          <Card aria-labelledby="required-loa-title">
            <div className="flex items-start gap-3">
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <FileText className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="required-loa-title" className="m-0 text-lg">
                  Letter of Acceptance
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Required. Its tender number and name of work become the identity
                  anchor for every optional document in this package.
                </p>
              </div>
            </div>

            {uploadedLoa === null ? (
              <Field className="mt-6 max-w-none">
                <label htmlFor="loa-file">LOA PDF</label>
                <input
                  id="loa-file"
                  name="loa"
                  type="file"
                  accept="application/pdf,.pdf"
                  required
                />
                <Hint>
                  Searchable PDF, up to 25 MB. Scanned image-only files may fail
                  extraction.
                </Hint>
              </Field>
            ) : (
              <div className="mt-6 flex items-center gap-3 rounded-xl border border-success/25 bg-success/5 p-4">
                <CheckCircle2
                  className="size-5 shrink-0 text-success"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <strong className="block truncate text-sm">
                    {uploadedLoa.originalFilename}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    LOA uploaded. Correct rejected supporting documents or continue to
                    review.
                  </span>
                </span>
              </div>
            )}

            <div className="mt-6 rounded-xl border border-warning/25 bg-warning/[0.06] p-4">
              <div className="flex gap-3">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-warning-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium">Identity matching is mandatory</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Missing or different tender numbers and work names are rejected
                    before storage. Punctuation differences are ignored, but Auto-MB
                    never guesses a relationship between contracts.
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <Card aria-labelledby="extraction-outcome-title">
            <h2 id="extraction-outcome-title" className="mt-0 text-base">
              What optional documents contribute
            </h2>
            <ul className="mt-4 flex list-none flex-col gap-3 p-0 text-sm">
              {[
                'Payment matrix by item category',
                'Overall and item-specific warranty or maintenance periods',
                'PBG and Security Deposit release clauses',
                'Item specifications mapped to awarded item references',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <FileCheck2
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
              Extraction is evidence, not authority. You review every value. The payment
              matrix remains manually editable and shows a warning when it differs from
              the tender text.
            </p>
          </Card>
        </div>

        <section className="mt-5" aria-labelledby="supporting-documents-title">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="supporting-documents-title" className="m-0 text-base">
                Optional supporting documents
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Add what is available now. More matched evidence can be attached while
                reviewing the LOA.
              </p>
            </div>
            <Badge variant="neutral">Optional</Badge>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {OPTIONAL_DOCUMENTS.map((definition) => {
              const state = supportStates[definition.kind];
              return (
                <Card key={definition.kind} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="m-0 text-sm">{definition.label}</h3>
                      <p className="mt-1 min-h-10 text-xs text-muted-foreground">
                        {definition.description}
                      </p>
                    </div>
                    {state.status === 'pending' && (
                      <Loader2
                        className="size-4 animate-spin text-primary"
                        aria-label="Uploading"
                      />
                    )}
                    {state.status === 'accepted' && (
                      <CheckCircle2
                        className="size-4 text-success"
                        aria-label="Accepted"
                      />
                    )}
                    {state.status === 'rejected' && (
                      <AlertTriangle
                        className="size-4 text-destructive"
                        aria-label="Rejected"
                      />
                    )}
                  </div>

                  {state.status === 'accepted' ? (
                    <div className="mt-4 rounded-lg border border-success/25 bg-success/5 px-3 py-2.5">
                      <p className="truncate text-xs font-medium">{state.filename}</p>
                      <p className="mt-1 text-xs text-success">
                        Tender identity matched and evidence extracted.
                      </p>
                    </div>
                  ) : (
                    <Field className="mt-3 mb-0 max-w-none">
                      <label
                        className="sr-only"
                        htmlFor={supportInputId(definition.kind)}
                      >
                        {definition.label} PDF
                      </label>
                      <input
                        id={supportInputId(definition.kind)}
                        name={definition.kind}
                        type="file"
                        accept="application/pdf,.pdf"
                        disabled={pending || state.status === 'pending'}
                      />
                    </Field>
                  )}
                  {state.status === 'rejected' && (
                    <p
                      className="mt-2 text-xs font-medium text-destructive"
                      role="alert"
                    >
                      {state.message}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        </section>

        {error !== null && (
          <div className="mt-5">
            <FormError>{error}</FormError>
            {existing !== null && (
              <Actions className="mt-2">
                {existing.confirmedWorkId === null ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      onOpenDocument(existing.documentId);
                    }}
                  >
                    Open that document
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      onOpenWork(existing.confirmedWorkId as string);
                    }}
                  >
                    Open the Work it became
                  </Button>
                )}
              </Actions>
            )}
          </div>
        )}

        <Actions className="mt-6 justify-end border-t border-border pt-5">
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          {uploadedLoa !== null && hasRejectedSupport && (
            <Button
              variant="secondary"
              onClick={() => {
                onUploaded(uploadedLoa);
              }}
              disabled={pending}
            >
              Continue without rejected documents
            </Button>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Processing package…
              </>
            ) : uploadedLoa === null ? (
              <>
                <Upload className="size-4" aria-hidden="true" />
                Upload and analyse
              </>
            ) : (
              'Retry selected documents'
            )}
          </Button>
        </Actions>
      </form>
    </div>
  );
}
