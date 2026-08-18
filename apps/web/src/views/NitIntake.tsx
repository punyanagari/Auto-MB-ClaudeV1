import { useState } from 'react';
import { FileSearch, FileUp, Sparkles } from 'lucide-react';
import type {
  ConfirmTenderRequest,
  TenderDetail,
  TenderNotice,
  TenderNoticeField,
  TenderNoticeProposal,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Actions, Field, FormError, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';

/**
 * NIT intake: upload the notice, review what the machine read, confirm.
 *
 * Replicates `app/tenders/new/page.tsx` and `components/nit-intake.tsx`
 * of the frozen mock at fdfe5ef: a `.75fr / 1.25fr` two-card grid, the
 * numbered "1. Upload tender NIT" dropzone on the left and "2. Review
 * extracted details" on the right, the same field set in the same order
 * with the title spanning both columns, and the same `Sparkles` empty
 * state before anything is uploaded.
 *
 * The mock's extraction is a hardcoded literal behind a button. This one
 * runs `pdftotext` and a field reader on the server and answers in the
 * upload response, so the two cards stay the two steps the mock drew —
 * but the copy is corrected, application-first, from "Extraction is
 * simulated in this preview" to what actually happens. `AGENTS.md`
 * § Design contract 2 allows exactly that: purely textual change.
 *
 * The one thing added inside the mock's grammar is the review MARK. The
 * server returns each field with its own `needsReview` flag, and a field
 * the reader could not resolve is outlined and labelled rather than
 * silently blank — the propose-never-commit rule (`AGENTS.md` rule 10)
 * is only real if the human can see which values are the machine's
 * guesses. The mock has no data behind it to flag.
 */

interface NitIntakeProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onConfirmed: (tender: TenderDetail) => void;
  readonly onCancel: () => void;
}

interface FormState {
  tenderNumber: string;
  authority: string;
  title: string;
  bidClosesAtLocal: string;
  estimatedValue: string;
  emdAmount: string;
  eligibilitySummary: string;
}

const EMPTY_FORM: FormState = {
  tenderNumber: '',
  authority: '',
  title: '',
  bidClosesAtLocal: '',
  estimatedValue: '',
  emdAmount: '',
  eligibilitySummary: '',
};

function formFromProposal(proposal: TenderNoticeProposal | null): FormState {
  if (proposal === null) return EMPTY_FORM;
  return {
    tenderNumber: proposal.tenderNumber.value ?? '',
    authority: proposal.authority.value ?? '',
    title: proposal.title.value ?? '',
    bidClosesAtLocal: proposal.bidClosesAtLocal.value ?? '',
    estimatedValue: proposal.estimatedValue.value ?? '',
    emdAmount: proposal.emdAmount.value ?? '',
    eligibilitySummary: proposal.eligibility.value ?? '',
  };
}

export function NitIntake({
  api,
  organisationId,
  onConfirmed,
  onCancel,
}: NitIntakeProps) {
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<TenderNotice | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: string): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function upload(): Promise<void> {
    if (file === null) return;
    setPending(true);
    setError(null);
    try {
      const uploaded = await api.uploadTenderNotice(organisationId, file, file.name);
      setNotice(uploaded);
      setForm(formFromProposal(uploaded.proposal));
    } catch (cause) {
      setError(
        errorMessage(cause, 'The notice could not be uploaded. Nothing was created.'),
      );
    } finally {
      setPending(false);
    }
  }

  async function confirm(): Promise<void> {
    if (notice === null) return;
    setPending(true);
    setError(null);
    try {
      const body: ConfirmTenderRequest = {
        tenderNumber: form.tenderNumber.trim(),
        authority: form.authority.trim(),
        title: form.title.trim(),
        bidClosesAtLocal: form.bidClosesAtLocal,
        ...(form.estimatedValue.trim() === ''
          ? {}
          : { estimatedValue: form.estimatedValue.trim() }),
        ...(form.emdAmount.trim() === '' ? {} : { emdAmount: form.emdAmount.trim() }),
        ...(form.eligibilitySummary.trim() === ''
          ? {}
          : { eligibilitySummary: form.eligibilitySummary.trim() }),
      };
      onConfirmed(await api.confirmTenderNotice(organisationId, notice.id, body));
    } catch (cause) {
      setError(errorMessage(cause, 'The tender could not be created.'));
    } finally {
      setPending(false);
    }
  }

  const proposal = notice?.proposal ?? null;

  return (
    <>
      <PageHeader
        title="Upload tender NIT"
        titleId="nit-intake-title"
        description="Extract key tender details, review them, and create the bid workspace."
      />
      {error !== null && <FormError>{error}</FormError>}
      <div className="grid gap-5 lg:grid-cols-[.75fr_1.25fr]">
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">1. Upload tender NIT</h2>
          </CardHeader>
          <label
            htmlFor="nit-file"
            className="flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <FileUp className="size-8 text-primary" aria-hidden="true" />
            <span className="font-medium">Choose NIT PDF</span>
            <span className="text-xs text-muted-foreground">
              The original file is retained with the tender record.
            </span>
            <input
              id="nit-file"
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                setNotice(null);
              }}
            />
          </label>
          {file !== null && (
            <p className="mt-3 mb-0 truncate rounded-lg border border-border p-3 text-sm">
              {file.name}
            </p>
          )}
          <Actions>
            <Button
              disabled={file === null || pending || notice !== null}
              onClick={() => void upload()}
            >
              <FileSearch data-icon="inline-start" aria-hidden="true" />
              Extract tender details
            </Button>
          </Actions>
          <Hint>
            Auto-MB reads the notice&rsquo;s text layer and proposes the fields below.
            It never creates a tender on its own — every value is yours to check and
            correct before the record exists.
          </Hint>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">2. Review extracted details</h2>
          </CardHeader>
          {notice === null ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <Sparkles className="size-8" aria-hidden="true" />
              <p className="m-0">Upload an NIT to prefill the tender record.</p>
            </div>
          ) : (
            <>
              {notice.extractionStatus === 'failed' && (
                <p className="mb-3 rounded-lg border border-warning/30 bg-warning/15 p-3 text-sm text-warning-foreground">
                  This PDF has no readable text layer, so nothing could be read off it.
                  The file is stored with the tender; type the details in below.
                </p>
              )}
              {proposal !== null && proposal.needsReviewTotal > 0 && (
                <p className="mb-3 rounded-lg border border-warning/30 bg-warning/15 p-3 text-sm text-warning-foreground">
                  {proposal.needsReviewTotal} field
                  {proposal.needsReviewTotal === 1 ? '' : 's'} could not be read
                  confidently and {proposal.needsReviewTotal === 1 ? 'is' : 'are'}{' '}
                  marked below. Check them against the notice before confirming.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <ProposedField
                  id="tender-number"
                  label="Tender number"
                  proposed={proposal?.tenderNumber}
                  value={form.tenderNumber}
                  onChange={(value) => {
                    set('tenderNumber', value);
                  }}
                />
                <ProposedField
                  id="tender-authority"
                  label="Railway / authority"
                  proposed={proposal?.authority}
                  value={form.authority}
                  onChange={(value) => {
                    set('authority', value);
                  }}
                />
                <ProposedField
                  id="tender-title"
                  label="Tender title"
                  className="sm:col-span-2"
                  proposed={proposal?.title}
                  value={form.title}
                  onChange={(value) => {
                    set('title', value);
                  }}
                />
                <ProposedField
                  id="tender-closes"
                  label="Bid deadline"
                  type="datetime-local"
                  hint="The closing time the notice prints, in your organisation's timezone."
                  proposed={proposal?.bidClosesAtLocal}
                  value={form.bidClosesAtLocal}
                  onChange={(value) => {
                    set('bidClosesAtLocal', value);
                  }}
                />
                <ProposedField
                  id="tender-value"
                  label="Estimated value"
                  hint="Rupees, in figures. Leave empty if the notice does not state it."
                  mono
                  proposed={proposal?.estimatedValue}
                  value={form.estimatedValue}
                  onChange={(value) => {
                    set('estimatedValue', value);
                  }}
                />
                <ProposedField
                  id="tender-emd"
                  label="EMD"
                  mono
                  proposed={proposal?.emdAmount}
                  value={form.emdAmount}
                  onChange={(value) => {
                    set('emdAmount', value);
                  }}
                />
                <ProposedField
                  id="tender-eligibility"
                  label="Eligibility summary"
                  className="sm:col-span-2"
                  proposed={proposal?.eligibility}
                  value={form.eligibilitySummary}
                  onChange={(value) => {
                    set('eligibilitySummary', value);
                  }}
                />
              </div>
              <Actions>
                <Button variant="outline" onClick={onCancel} disabled={pending}>
                  Cancel
                </Button>
                <Button disabled={pending} onClick={() => void confirm()}>
                  {pending ? 'Creating tender…' : 'Confirm and create tender'}
                </Button>
              </Actions>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/** One reviewed field: the mock's `Label` + `Input` pair, plus the mark
 * the mock has no data to need. A field the reader flagged is outlined in
 * the warning tint and says so in text below — never in colour alone. */
function ProposedField({
  id,
  label,
  value,
  proposed,
  onChange,
  type = 'text',
  hint,
  mono = false,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly proposed: TenderNoticeField | undefined;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'datetime-local';
  readonly hint?: string;
  readonly mono?: boolean;
  readonly className?: string;
}) {
  const flagged = proposed?.needsReview ?? false;
  const hintId = `${id}-hint`;
  return (
    <Field className={cn('my-0 max-w-none', className)}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        aria-describedby={flagged || hint !== undefined ? hintId : undefined}
        className={cn(mono && 'font-mono tabular-nums', flagged && 'border-warning/60')}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      {(flagged || hint !== undefined) && (
        <Hint id={hintId} className={cn(flagged && 'text-warning-foreground')}>
          {flagged ? 'Not read confidently — check this against the notice. ' : ''}
          {hint ?? ''}
        </Hint>
      )}
    </Field>
  );
}
