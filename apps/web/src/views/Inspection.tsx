import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileUp, ShieldCheck } from 'lucide-react';
import {
  INSPECTION_AGENCIES,
  type InspectionAgency,
  type InspectionCall,
  type InspectionCallDocument,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { openPdf } from '../lib/openPdf.js';
import { workHash } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The Inspection workspace.
 *
 * Replicates `app/inspection/page.tsx` and
 * `components/inspection-lifecycle-workspace.tsx` of the frozen mock at
 * fdfe5ef: the `Quality operations` eyebrow over three stat cards, an
 * RDSO/RITES tab pair, and one card per call carrying its document
 * compliance list, its result control and the close gate with the mock's
 * "Cannot close: …" sentence.
 *
 * Three deliberate differences from the mock, each of them behaviour the
 * mock could not express (`docs/UX.md` § Approved divergences 4), and all
 * three flagged to the owner in the pull request:
 *
 *   * **A call is raised from the Work, not from here.** The mock's
 *     workspace lists items across works from module-scope seed data and
 *     issues the request inline. In the application the items, their
 *     agency mapping and their quantities live on the Work's Inspection
 *     clause tab, which is where the raise action sits — and where the
 *     mock's own "Open Inspection" button already links from. This screen
 *     runs the lifecycle of calls that exist.
 *   * **No signing gate.** The mock hands the call letter and the routine
 *     test report to `DscSigningGate`. Outbound signing is ADR-0012's
 *     hybrid model and is not procured yet, so nothing here pretends to
 *     sign.
 *   * **Nothing is generated.** The mock's checklist offers "Generate" for
 *     a datasheet or an undertaking and fakes a filename. There is no
 *     template behind it, so every paper is an upload.
 */

/** `closed` is this screen's own word for a finished, successful call, so
 * the tone is named here rather than added to the shared chip map — that
 * map is a product vocabulary and has no idea which register is asking. */
const CALL_TONES = {
  requested: 'neutral',
  scheduled: 'info',
  closed: 'success',
  cancelled: 'destructive',
} as const;

/** One screenful of calls; the rest arrive on demand. */
const PAGE_SIZE = 25;

const STATUS_LABELS = {
  requested: 'Request issued',
  scheduled: 'Awaiting inspection',
  closed: 'Certified',
  cancelled: 'Withdrawn',
} as const;

interface InspectionProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Attaching evidence, recording the result and uploading the
   * certificate are site and QA work — owner, office or site, exactly as
   * the server gates them. A viewer reads the register and downloads
   * from it. */
  readonly canRecord: boolean;
  /** Closing a call is an owner/office act. */
  readonly canModify: boolean;
  /** Withdrawing one carries the cancel authority, like every other
   * withdrawal of a numbered record. */
  readonly canCancel: boolean;
}

export function Inspection({
  api,
  organisationId,
  canRecord,
  canModify,
  canCancel,
}: InspectionProps) {
  const [calls, setCalls] = useState<readonly InspectionCall[] | null>(null);
  const [awaiting, setAwaiting] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [agency, setAgency] = useState<InspectionAgency>('RDSO');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCalls(null);
    setLoadError(null);
    api
      .listInspectionCalls(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (cancelled) return;
        setCalls(loaded.calls);
        setAwaiting(loaded.awaitingCertificate);
        setNextCursor(loaded.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The inspection calls could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const retry = useCallback(() => {
    setLoadVersion((version) => version + 1);
  }, []);

  /** The register pages the way Installations does: the first request asks
   * for a page, and the button appends the next one. A workspace whose
   * lead number is "how many items are blocked" cannot afford to serialise
   * every call an organisation has ever raised to answer it. */
  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    setPending(true);
    setActionError(null);
    try {
      const page = await api.listInspectionCalls(organisationId, {
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setCalls((current) => [...(current ?? []), ...page.calls]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The next page could not be loaded.',
      );
    } finally {
      setPending(false);
    }
  }, [api, organisationId, nextCursor]);

  /** Every mutation answers the call it changed, so the register replaces
   * that one card instead of re-reading the whole list. */
  const act = useCallback(async (work: () => Promise<InspectionCall>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await work();
      setCalls((current) =>
        (current ?? []).map((call) => (call.id === updated.id ? updated : call)),
      );
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

  const header = (
    <PageHeader
      eyebrow="Quality operations"
      title="Inspection"
      titleId="inspection-title"
      description="Place RDSO and RITES inspection calls, track inward call letters, routine tests, job cards, and certificates by work."
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry inspection calls">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (calls === null) {
    return (
      <>
        {header}
        <LoadingState label="the inspection calls" rows={3} columns={3} />
      </>
    );
  }

  const forAgency = calls.filter((call) => call.agency === agency);
  const countOf = (status: InspectionCall['status']) =>
    forAgency.filter((call) => call.status === status).length;

  return (
    <>
      {header}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}

      {/* The mock's three stat cards, scoped to the selected agency —
          except the last, which counts across both because an item behind
          the dispatch gate is behind it whoever inspects. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Request issued" value={countOf('requested')} />
        <StatCard label="Awaiting inspection" value={countOf('scheduled')} />
        <StatCard
          label="Items blocked from despatch"
          value={awaiting}
          tone={awaiting > 0 ? 'warning' : 'success'}
        />
      </div>

      {/* The mock's agency `TabsList`, drawn as a toggle group rather than
          an ARIA tablist: it filters the list below in place instead of
          swapping panels, and `test/a11y-invariants` rightly refuses a
          `role="tablist"` without the roving-tabindex pattern to match. */}
      <div
        role="group"
        aria-label="Inspecting agency"
        className="mt-5 flex h-11 items-center gap-1"
      >
        {INSPECTION_AGENCIES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={agency === option}
            onClick={() => {
              setAgency(option);
            }}
            className={
              agency === option
                ? 'h-9 rounded-md bg-accent px-3 text-sm font-semibold'
                : 'h-9 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent/35'
            }
          >
            {option}
          </button>
        ))}
      </div>

      {forAgency.length === 0 ? (
        <EmptyState>
          No {agency} inspection call has been raised. Map the items to {agency} on the
          Work&rsquo;s Inspection clause tab and raise the call from there.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {forAgency.map((call) => (
            <CallCard
              key={call.id}
              api={api}
              organisationId={organisationId}
              call={call}
              pending={pending}
              canRecord={canRecord}
              canModify={canModify}
              canCancel={canCancel}
              act={act}
            />
          ))}
          {nextCursor !== null && (
            <div>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void loadMore()}
              >
                Load more inspection calls
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'warning' | 'success';
}) {
  return (
    <div className="data-surface bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'warning'
            ? 'metric-value text-warning'
            : tone === 'success'
              ? 'metric-value text-success'
              : 'metric-value'
        }
      >
        {value}
      </p>
    </div>
  );
}

/** One call: the mock's job card. */
function CallCard({
  api,
  organisationId,
  call,
  pending,
  canRecord,
  canModify,
  canCancel,
  act,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly call: InspectionCall;
  readonly pending: boolean;
  readonly canRecord: boolean;
  readonly canModify: boolean;
  readonly canCancel: boolean;
  readonly act: (work: () => Promise<InspectionCall>, done: string) => Promise<void>;
}) {
  const [agencyCallNumber, setAgencyCallNumber] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [certificateNumber, setCertificateNumber] = useState('');
  const [certificateDate, setCertificateDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');

  const mandatory = call.documents.filter((document) => document.mandatory);
  const filled = mandatory.filter(
    (document) => document.originalFilename !== null,
  ).length;
  const hasCertificate = call.documents.some(
    (document) => document.kind === 'certificate' && document.originalFilename !== null,
  );
  const outstanding = mandatory.length - filled;
  // The mock's own close-gate sentence, assembled from the same two
  // conditions the server refuses on. There is no third: the certificate
  // IS the result.
  const blockers = [
    ...(outstanding > 0 ? ['mandatory documents pending'] : []),
    ...(hasCertificate ? [] : ['inspection certificate required']),
  ];
  const open = call.status === 'requested' || call.status === 'scheduled';

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-semibold">
            {call.callReference} &middot; Document compliance
          </h2>
          <p className="text-xs text-muted-foreground">
            <a className="underline" href={workHash(call.workId, 'overview')}>
              {call.workCode}
            </a>{' '}
            &middot; {call.agency}
            {call.agencyCallNumber === null
              ? ' · request placed'
              : ` · inward ${call.agencyCallNumber}`}
            {call.vendorPremises === null ? '' : ` · ${call.vendorPremises}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Requested {formatDate(call.requestedOn)}
            {call.items.length === 0
              ? ''
              : ` · ${call.items.map((item) => item.itemNumber).join(', ')}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {call.certificateLive && <Badge variant="success">Certificate live</Badge>}
          <Badge variant="outline">
            {filled}/{mandatory.length} documents
          </Badge>
          <StatusChip status={call.status} tone={CALL_TONES[call.status]}>
            {STATUS_LABELS[call.status]}
          </StatusChip>
        </div>
      </CardHeader>

      {call.documents.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          This call carries no document checklist. Configure one on the Work&rsquo;s
          Inspection clause tab before the next call is raised.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 pb-4">
          {call.documents.map((document) => (
            <DocumentRow
              key={document.id}
              api={api}
              organisationId={organisationId}
              document={document}
              disabled={pending || !open || !canRecord}
              canDownload={document.originalFilename !== null}
              act={act}
            />
          ))}
        </ul>
      )}

      {open && canRecord && (
        <div className="grid gap-3 border-t px-4 py-4 md:grid-cols-2">
          {call.status === 'requested' && (
            <UploadForm
              legend="Inward call letter"
              hint="The agency's own letter and the number it carries."
              disabled={pending}
              fields={
                <>
                  <Field>
                    <label htmlFor={`call-number-${call.id}`}>Agency call number</label>
                    <input
                      id={`call-number-${call.id}`}
                      value={agencyCallNumber}
                      onChange={(event) => {
                        setAgencyCallNumber(event.target.value);
                      }}
                      required
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`received-on-${call.id}`}>Received on</label>
                    <input
                      id={`received-on-${call.id}`}
                      type="date"
                      value={receivedOn}
                      onChange={(event) => {
                        setReceivedOn(event.target.value);
                      }}
                      required
                    />
                    <Hint>DD/MM/YYYY.</Hint>
                  </Field>
                </>
              }
              label="Receive call letter"
              onFile={(file) =>
                void act(
                  () =>
                    api.receiveInspectionCallLetter(organisationId, call.id, file, {
                      filename: file.name,
                      agencyCallNumber,
                      receivedOn,
                    }),
                  `Inward call letter recorded against ${call.callReference}.`,
                )
              }
            />
          )}

          {call.status === 'scheduled' && (
            <>
              <UploadForm
                legend="Inspection certificate"
                hint="The certificate is the result: uploading it records the pass."
                disabled={pending}
                fields={
                  <>
                    <Field>
                      <label htmlFor={`cert-number-${call.id}`}>
                        Certificate number
                      </label>
                      <input
                        id={`cert-number-${call.id}`}
                        value={certificateNumber}
                        onChange={(event) => {
                          setCertificateNumber(event.target.value);
                        }}
                        required
                      />
                    </Field>
                    <Field>
                      <label htmlFor={`cert-date-${call.id}`}>Certificate date</label>
                      <input
                        id={`cert-date-${call.id}`}
                        type="date"
                        value={certificateDate}
                        onChange={(event) => {
                          setCertificateDate(event.target.value);
                        }}
                        required
                      />
                      <Hint>DD/MM/YYYY.</Hint>
                    </Field>
                    <Field>
                      <label htmlFor={`cert-until-${call.id}`}>
                        Valid until (optional)
                      </label>
                      <input
                        id={`cert-until-${call.id}`}
                        type="date"
                        value={validUntil}
                        onChange={(event) => {
                          setValidUntil(event.target.value);
                        }}
                      />
                      <Hint>
                        DD/MM/YYYY. Left empty, the certificate does not lapse.
                      </Hint>
                    </Field>
                  </>
                }
                label="Upload certificate"
                onFile={(file) =>
                  void act(
                    () =>
                      api.uploadInspectionCertificate(organisationId, call.id, file, {
                        filename: file.name,
                        certificateNumber,
                        certificateDate,
                        ...(validUntil === '' ? {} : { validUntil }),
                      }),
                    `Certificate recorded against ${call.callReference}.`,
                  )
                }
              />
            </>
          )}
        </div>
      )}

      {call.status === 'cancelled' && call.cancellationReason !== null && (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          Withdrawn: {call.cancellationReason}
        </p>
      )}

      {call.status === 'closed' && (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          Certificate {call.certificateNumber} dated{' '}
          {call.certificateDate === null ? '—' : formatDate(call.certificateDate)}
          {call.certificateValidUntil === null
            ? ', no expiry.'
            : `, valid until ${formatDate(call.certificateValidUntil)}.`}
        </p>
      )}

      {open && canModify && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {blockers.length === 0
              ? 'All mandatory evidence is complete.'
              : `Cannot close: ${blockers.join('; ')}.`}
          </p>
          <Button
            type="button"
            disabled={pending || blockers.length > 0}
            onClick={() =>
              void act(
                () => api.closeInspectionCall(organisationId, call.id),
                `${call.callReference} closed; its items may now be despatched.`,
              )
            }
          >
            <ShieldCheck data-icon="inline-start" />
            Close inspection
          </Button>
        </div>
      )}

      {/* WITHDRAWAL, and it renders for a CLOSED call too — that is the
          whole point of it. An agency revokes a certificate after the
          material has gone out, and withdrawing the call is what puts its
          items back behind the dispatch gate. Gated on the cancel
          authority rather than on write access, like every other
          withdrawal of a numbered record. */}
      {call.status !== 'cancelled' && canCancel && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          {call.advisoryIssuedChallans.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4" />
                {call.advisoryIssuedChallans.length} despatch
                {call.advisoryIssuedChallans.length === 1 ? '' : 'es'} went out while
                this certificate was live
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {call.advisoryIssuedChallans.map((challan) => (
                  <li
                    key={`${challan.challanId}-${challan.itemNumber}`}
                    className="font-mono text-xs tabular-nums"
                  >
                    {challan.challanNumber} &middot; {formatDate(challan.challanDate)}{' '}
                    &middot; {challan.itemNumber} &middot; {challan.quantity}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Advisory: matched by item and despatch date, because a challan records
                no link to the certificate that permitted it. Withdrawing does not
                recall them — they keep their numbers and their snapshots — but somebody
                has to be told which they are.
              </p>
            </div>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                () => api.cancelInspectionCall(organisationId, call.id, { reason }),
                `${call.callReference} withdrawn.`,
              );
            }}
          >
            <Field className="min-w-64 flex-1">
              <label htmlFor={`reason-${call.id}`}>
                {call.status === 'closed'
                  ? 'Withdraw the certificate because'
                  : 'Withdraw the call because'}
              </label>
              <input
                id={`reason-${call.id}`}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                required
              />
            </Field>
            <Button type="submit" variant="ghost" disabled={pending}>
              Withdraw
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}

function DocumentRow({
  api,
  organisationId,
  document,
  disabled,
  canDownload,
  act,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly document: InspectionCallDocument;
  readonly disabled: boolean;
  readonly canDownload: boolean;
  readonly act: (work: () => Promise<InspectionCall>, done: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {document.label}
          {document.mandatory && (
            <span className="text-destructive" aria-label="mandatory">
              {' '}
              *
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {document.originalFilename === null
            ? 'Pending'
            : `${document.originalFilename}${document.uploadedAt === null ? '' : ` · ${formatDate(document.uploadedAt.slice(0, 10))}`}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canDownload && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              void openPdf(() =>
                api.downloadInspectionDocument(organisationId, document.id),
              )
            }
          >
            Open
          </Button>
        )}
        {document.kind === 'evidence' && (
          <>
            <input
              ref={input}
              type="file"
              accept="application/pdf"
              className="sr-only"
              aria-label={`Upload ${document.label}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file === undefined) return;
                void act(
                  () =>
                    api.uploadInspectionEvidence(organisationId, document.id, file, {
                      filename: file.name,
                    }),
                  `${document.label} attached.`,
                );
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              <FileUp data-icon="inline-start" />
              Upload
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** A small metadata form whose submit is choosing a PDF: the shape both
 * the call letter and the certificate need, so it is written once. */
function UploadForm({
  legend,
  hint,
  fields,
  label,
  disabled,
  onFile,
}: {
  readonly legend: string;
  readonly hint: string;
  readonly fields: React.ReactNode;
  readonly label: string;
  readonly disabled: boolean;
  readonly onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
      <legend className="section-label">{legend}</legend>
      {fields}
      <Hint>{hint}</Hint>
      <input
        ref={input}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) onFile(file);
        }}
      />
      <Button type="button" disabled={disabled} onClick={() => input.current?.click()}>
        <FileUp data-icon="inline-start" />
        {label}
      </Button>
    </fieldset>
  );
}
