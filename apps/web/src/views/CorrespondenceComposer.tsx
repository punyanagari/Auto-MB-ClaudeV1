import { useEffect, useState } from 'react';
import { ArrowLeft, FileUp, Send, Upload } from 'lucide-react';
import type { Contact, CorrespondenceThreadOption, Work } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { todayIso } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Combobox } from '../ui/combobox.js';
import { DateField } from '../ui/date-field.js';
import { Actions, Field, FieldRow, FormError, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { ErrorState, LoadingState } from '../ui/state.js';

/**
 * Writing an outward letter, and registering an inward one.
 *
 * Replicates `app/correspondence/new/page.tsx` and
 * `app/correspondence/new/inward/page.tsx` of the frozen mock at
 * `fdfe5ef`: the back button, the eyebrowed page header, and a
 * `lg:grid-cols-[minmax(0,1fr)_19rem]` split of a details card beside a
 * narrow action card.
 *
 * Four departures, all recorded in `docs/UX.md` § Approved divergences and
 * all built from the mock's own components:
 *
 *   * **No "Letter type" toggle.** The mock's outward screen switches
 *     between three kinds. Two of them already have homes: an inward
 *     letter is registered on the upload screen beside this one, because
 *     the register refuses an inward row with no scan; and an extension
 *     request is raised on the Work, which is the only place its
 *     completion dates and its own numbering exist. A toggle whose other
 *     two positions are somewhere else is a control that lies about where
 *     it leads.
 *   * **The number is not shown before it exists.** Both mock screens put
 *     a read-only next number in a field. The number is allocated inside
 *     the writing transaction, and a letter filed a second later takes a
 *     different one — a pre-shown number is a promise the counter has not
 *     made. The field states the series instead.
 *   * **No "Save draft".** 0086 records why the register has no draft
 *     state: the design contract draws no detail screen to reopen one on.
 *   * **PDF only.** The mock's dropzone offers JPG and PNG. Every stored
 *     document in this product is a PDF through one hardened path
 *     (`upload-guards.ts`), and a second media model for one screen buys
 *     nothing the operator's scanner cannot already produce.
 */

interface ComposerProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/** The pickers both screens need, loaded once. */
interface Pickers {
  readonly contacts: readonly Contact[];
  readonly works: readonly Work[];
  readonly letters: readonly CorrespondenceThreadOption[];
}

function usePickers(api: ApiClient, organisationId: string) {
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setPickers(null);
    setLoadError(null);
    Promise.all([
      api.listContacts(organisationId),
      api.listWorks(organisationId),
      api.listCorrespondenceThreadOptions(organisationId),
    ])
      .then(([contacts, works, thread]) => {
        if (cancelled) return;
        setPickers({ contacts, works, letters: thread.letters });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The contacts and Works could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  return {
    pickers,
    loadError,
    retry: retry,
  };
}

function BackToRegister({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mb-4 -ml-2 text-muted-foreground"
      onClick={onCancel}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      Correspondence
    </Button>
  );
}

/** The mock's contact, Work and earlier-letter pickers, in its order and
 * with its placeholder copy. `docs/DESIGN.md` maps the mock's `Select`
 * onto the application's own form anatomy; the contact and letter pickers
 * stay native selects, and the Work picker is `ui/combobox` because a
 * `<select>` over the whole Works register is a wall of titles nobody can
 * scan (§ 38, owner ruling of 2026-08-22). */
function LetterPickers({
  pickers,
  idPrefix,
  contactLabel,
  contactPlaceholder,
  contactId,
  onContactId,
  workId,
  onWorkId,
  replyToLetterId,
  onReplyToLetterId,
}: {
  readonly pickers: Pickers;
  readonly idPrefix: string;
  readonly contactLabel: string;
  readonly contactPlaceholder: string;
  readonly contactId: string;
  readonly onContactId: (value: string) => void;
  readonly workId: string;
  readonly onWorkId: (value: string) => void;
  readonly replyToLetterId: string;
  readonly onReplyToLetterId: (value: string) => void;
}) {
  return (
    <>
      <FieldRow>
        <Field>
          <label htmlFor={`${idPrefix}-contact`}>{contactLabel}</label>
          <select
            id={`${idPrefix}-contact`}
            value={contactId}
            onChange={(event) => {
              onContactId(event.currentTarget.value);
            }}
          >
            <option value="">{contactPlaceholder}</option>
            {pickers.contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.designation}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <label htmlFor={`${idPrefix}-work`}>Related Work (optional)</label>
          <Combobox
            id={`${idPrefix}-work`}
            value={workId}
            onChange={onWorkId}
            options={[
              { value: '', label: 'General correspondence' },
              ...pickers.works.map((work) => ({
                value: work.id,
                code: work.workCode,
                label: work.title,
              })),
            ]}
            noMatchLabel="No Work matches that code or title."
          />
        </Field>
      </FieldRow>
      <Field>
        <label htmlFor={`${idPrefix}-reply-to`}>
          Reference to earlier letter (optional)
        </label>
        <select
          id={`${idPrefix}-reply-to`}
          value={replyToLetterId}
          onChange={(event) => {
            onReplyToLetterId(event.currentTarget.value);
          }}
        >
          <option value="">No earlier correspondence</option>
          {pickers.letters.map((letter) => (
            <option key={letter.id} value={letter.id}>
              {letter.number} · {letter.subject}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

/** The series a letter will be numbered in, said instead of a number that
 * does not exist yet. */
function SeriesField({
  id,
  label,
  series,
}: {
  readonly id: string;
  readonly label: string;
  readonly series: string;
}) {
  return (
    <Field>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={series} readOnly />
      <Hint>Allocated when the letter is filed, from the series of its date.</Hint>
    </Field>
  );
}

export function WriteOutwardLetter({
  api,
  organisationId,
  onDone,
  onCancel,
}: ComposerProps) {
  const { pickers, loadError, retry } = usePickers(api, organisationId);
  const [letterDate, setLetterDate] = useState(todayIso);
  const [contactId, setContactId] = useState('');
  const [workId, setWorkId] = useState('');
  const [replyToLetterId, setReplyToLetterId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Documents · Correspondence"
      title="Write outward letter"
      titleId="outward-letter-title"
      description="Link the letter to a Work, contact, or earlier correspondence for a complete trail."
    />
  );

  if (loadError !== null) {
    return (
      <>
        <BackToRegister onCancel={onCancel} />
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry">
          {loadError}
        </ErrorState>
      </>
    );
  }
  if (pickers === null) {
    return (
      <>
        <BackToRegister onCancel={onCancel} />
        {header}
        <LoadingState label="the contacts and Works" rows={4} columns={2} />
      </>
    );
  }

  const dispatch = (): void => {
    setFailure(null);
    setDispatching(true);
    api
      .writeOutwardLetter(organisationId, {
        letterDate,
        contactId,
        subject: subject.trim(),
        body: body.trim(),
        ...(workId === '' ? {} : { workId }),
        ...(replyToLetterId === '' ? {} : { replyToLetterId }),
      })
      .then(() => {
        onDone();
      })
      .catch((cause: unknown) => {
        setDispatching(false);
        setFailure(errorMessage(cause, 'The letter could not be dispatched.'));
      });
  };

  const ready =
    contactId !== '' && subject.trim().length >= 2 && body.trim().length >= 2;

  return (
    <>
      <BackToRegister onCancel={onCancel} />
      {header}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Letter details</h2>
            <p className="m-0 text-sm text-muted-foreground">
              An extension of time is requested from the Work, where its completion
              dates and its own letter series live.
            </p>
          </CardHeader>
          <FieldRow>
            <SeriesField
              id="outward-number"
              label="Letter number"
              series="OUT / financial year / serial"
            />
            <DateField
              id="outward-date"
              label="Date"
              value={letterDate}
              max={todayIso()}
              onChange={(event) => {
                setLetterDate(event.currentTarget.value);
              }}
            />
          </FieldRow>
          <LetterPickers
            pickers={pickers}
            idPrefix="outward"
            contactLabel="To"
            contactPlaceholder="Choose any contact"
            contactId={contactId}
            onContactId={setContactId}
            workId={workId}
            onWorkId={setWorkId}
            replyToLetterId={replyToLetterId}
            onReplyToLetterId={setReplyToLetterId}
          />
          <Field>
            <label htmlFor="outward-subject">Subject</label>
            <input
              id="outward-subject"
              placeholder="Clear subject line"
              maxLength={200}
              value={subject}
              onChange={(event) => {
                setSubject(event.currentTarget.value);
              }}
            />
          </Field>
          <Field className="max-w-none">
            <label htmlFor="outward-body">Letter body</label>
            <textarea
              id="outward-body"
              rows={12}
              placeholder="Write the letter…"
              maxLength={20000}
              value={body}
              onChange={(event) => {
                setBody(event.currentTarget.value);
              }}
            />
          </Field>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <h2 className="text-base font-semibold">Generate letter</h2>
            <p className="m-0 text-sm text-muted-foreground">
              A correspondence register entry is created and the letter can be printed
              from it. The letter cannot be edited afterwards.
            </p>
          </CardHeader>
          {failure !== null && <FormError>{failure}</FormError>}
          <Actions className="flex-col items-stretch">
            <Button disabled={!ready || dispatching} onClick={dispatch}>
              <Send data-icon="inline-start" aria-hidden="true" />
              {dispatching ? 'Dispatching…' : 'Finalize & dispatch letter'}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </Actions>
        </Card>
      </div>
    </>
  );
}

export function UploadInwardLetter({
  api,
  organisationId,
  onDone,
  onCancel,
}: ComposerProps) {
  const { pickers, loadError, retry } = usePickers(api, organisationId);
  const [receivedOn, setReceivedOn] = useState(todayIso);
  const [contactId, setContactId] = useState('');
  const [workId, setWorkId] = useState('');
  const [senderReference, setSenderReference] = useState('');
  const [senderLetterDate, setSenderLetterDate] = useState('');
  const [subject, setSubject] = useState('');
  const [replyToLetterId, setReplyToLetterId] = useState('');
  const [responseDueOn, setResponseDueOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Documents · Correspondence"
      title="Upload inward letter"
      titleId="inward-letter-title"
      description="Register a received letter and retain its original PDF in the correspondence trail."
    />
  );

  if (loadError !== null) {
    return (
      <>
        <BackToRegister onCancel={onCancel} />
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry">
          {loadError}
        </ErrorState>
      </>
    );
  }
  if (pickers === null) {
    return (
      <>
        <BackToRegister onCancel={onCancel} />
        {header}
        <LoadingState label="the contacts and Works" rows={4} columns={2} />
      </>
    );
  }

  const register = (): void => {
    if (file === null) return;
    setFailure(null);
    setRegistering(true);
    api
      .registerInwardLetter(organisationId, file, {
        filename: file.name,
        receivedOn,
        contactId,
        subject: subject.trim(),
        ...(workId === '' ? {} : { workId }),
        ...(senderReference.trim() === ''
          ? {}
          : { senderReference: senderReference.trim() }),
        ...(senderLetterDate === '' ? {} : { senderLetterDate }),
        ...(replyToLetterId === '' ? {} : { replyToLetterId }),
        ...(responseDueOn === '' ? {} : { responseDueOn }),
      })
      .then(() => {
        onDone();
      })
      .catch((cause: unknown) => {
        setRegistering(false);
        setFailure(errorMessage(cause, 'The letter could not be registered.'));
      });
  };

  const ready = contactId !== '' && subject.trim().length >= 2 && file !== null;

  return (
    <>
      <BackToRegister onCancel={onCancel} />
      {header}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Received letter details</h2>
            <p className="m-0 text-sm text-muted-foreground">
              The inward number is generated internally; enter the sender&apos;s
              reference exactly as printed.
            </p>
          </CardHeader>
          <FieldRow>
            <SeriesField
              id="inward-number"
              label="Inward number"
              series="IN / financial year / serial"
            />
            <DateField
              id="inward-received"
              label="Received date"
              value={receivedOn}
              max={todayIso()}
              onChange={(event) => {
                setReceivedOn(event.currentTarget.value);
              }}
            />
          </FieldRow>
          <LetterPickers
            pickers={pickers}
            idPrefix="inward"
            contactLabel="Received from"
            contactPlaceholder="Choose sender"
            contactId={contactId}
            onContactId={setContactId}
            workId={workId}
            onWorkId={setWorkId}
            replyToLetterId={replyToLetterId}
            onReplyToLetterId={setReplyToLetterId}
          />
          <FieldRow>
            <Field>
              <label htmlFor="inward-sender-reference">
                Sender&apos;s letter / reference number
              </label>
              <input
                id="inward-sender-reference"
                placeholder="e.g. S&amp;T/PA/Approval/118"
                maxLength={100}
                value={senderReference}
                onChange={(event) => {
                  setSenderReference(event.currentTarget.value);
                }}
              />
            </Field>
            <DateField
              id="inward-letter-date"
              label="Letter date"
              value={senderLetterDate}
              max={receivedOn}
              hint="The date the sender printed on their own letter."
              onChange={(event) => {
                setSenderLetterDate(event.currentTarget.value);
              }}
            />
          </FieldRow>
          <Field>
            <label htmlFor="inward-subject">Subject</label>
            <input
              id="inward-subject"
              placeholder="Subject as stated in the received letter"
              maxLength={200}
              value={subject}
              onChange={(event) => {
                setSubject(event.currentTarget.value);
              }}
            />
          </Field>
          <DateField
            id="inward-response-due"
            label="Response due date (optional)"
            value={responseDueOn}
            min={receivedOn}
            onChange={(event) => {
              setResponseDueOn(event.currentTarget.value);
            }}
          />
          <Field className="max-w-none">
            <label htmlFor="inward-file">Letter PDF or scan</label>
            {/* The mock's dashed dropzone, as a label for the real input:
                clicking it opens the picker and the input itself stays
                `sr-only` but focusable, so the keyboard reaches it. */}
            <label
              htmlFor="inward-file"
              className="flex cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60"
            >
              <FileUp className="size-8 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium">
                {file === null ? 'Choose the scanned PDF' : file.name}
              </span>
              <span className="text-xs text-muted-foreground">PDF · up to 25 MB</span>
            </label>
            <input
              id="inward-file"
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
              }}
            />
          </Field>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <h2 className="text-base font-semibold">Register inward letter</h2>
            <p className="m-0 text-sm text-muted-foreground">
              The uploaded file and its facts are linked to the selected Work and become
              part of the correspondence trail.
            </p>
          </CardHeader>
          {failure !== null && <FormError>{failure}</FormError>}
          <Actions className="flex-col items-stretch">
            <Button disabled={!ready || registering} onClick={register}>
              <Upload data-icon="inline-start" aria-hidden="true" />
              {registering ? 'Uploading…' : 'Upload and register'}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </Actions>
        </Card>
      </div>
    </>
  );
}
