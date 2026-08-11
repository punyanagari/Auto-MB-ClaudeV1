import { useMemo, useState, type FormEvent } from 'react';
import type {
  ContractSourceDocumentKind,
  LoaDocumentDetail,
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
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Badge } from '../ui/badge.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';

interface UploadLoaProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onUploaded: (document: LoaDocumentDetail) => void;
  readonly onCancel: () => void;
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
  | { readonly status: 'rejected'; readonly filename: string; readonly message: string };

function fileOf(input: HTMLInputElement | null): File | null {
  return input?.files?.[0] ?? null;
}

function supportInputId(kind: ContractSourceDocumentKind): string {
  return `contract-source-${kind.replaceAll('_', '-')}`;
}

export function UploadLoa({
  api,
  organisationId,
  onUploaded,
  onCancel,
}: UploadLoaProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedLoa, setUploadedLoa] = useState<LoaDocumentDetail | null>(null);
  const [supportStates, setSupportStates] = useState<
    Record<ContractSourceDocumentKind, UploadState>
  >({
    nit: { status: 'idle' },
    contract_agreement: { status: 'idle' },
    tender_specification: { status: 'idle' },
  });

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
      const message =
        cause instanceof RequestFailedError
          ? cause.message
          : `${definition.label} could not be uploaded.`;
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
    const form = event.currentTarget;
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

      if (loa.extractionStatus !== 'review') {
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
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The LOA package could not be uploaded. Nothing authoritative was created.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-1 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Contract intake
          </p>
          <h1 id="upload-loa-title" tabIndex={-1}>
            Upload contract documents
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The Letter of Acceptance is required. Tender documents are optional evidence;
            Auto-MB accepts them only when both the tender number and name of work match
            the LOA.
          </p>
        </div>
        <Badge variant="info">Human confirmation required</Badge>
      </header>

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
                  Required. Its tender number and name of work become the identity anchor
                  for every optional document in this package.
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
                <Hint>Searchable PDF, up to 25 MB. Scanned image-only files may fail extraction.</Hint>
              </Field>
            ) : (
              <div className="mt-6 flex items-center gap-3 rounded-xl border border-success/25 bg-success/5 p-4">
                <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
                <span className="min-w-0">
                  <strong className="block truncate text-sm">
                    {uploadedLoa.originalFilename}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    LOA uploaded. Correct rejected supporting documents or continue to review.
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
                    Missing or different tender numbers and work names are rejected before
                    storage. Punctuation differences are ignored, but Auto-MB never guesses a
                    relationship between contracts.
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
                      <p className="mt-1 text-[11px] text-success">
                        Tender identity matched and evidence extracted.
                      </p>
                    </div>
                  ) : (
                    <Field className="mt-3 mb-0 max-w-none">
                      <label className="sr-only" htmlFor={supportInputId(definition.kind)}>
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
                    <p className="mt-2 text-xs font-medium text-destructive" role="alert">
                      {state.message}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        </section>

        {error !== null && <FormError className="mt-5">{error}</FormError>}

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
