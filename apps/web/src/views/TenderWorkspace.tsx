import { useCallback, useEffect, useState } from 'react';
import { Download, FileUp, Plus, ShieldCheck } from 'lucide-react';
import type {
  CompanyDocument,
  TenderChecklistItem,
  TenderDetail,
  TenderStatus,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import {
  formatDate,
  formatInr,
  formatLocalDateTime,
  formatTimestamp,
} from '../format.js';
import { cn } from '../lib/cn.js';
import { openPdf } from '../lib/openPdf.js';
import { navigateOnClick, workHash } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The tender workspace.
 *
 * Replicates `app/tenders/[id]/page.tsx` and
 * `components/tender-workspace.tsx` of the frozen mock at fdfe5ef: the
 * summary card with the mono tender number, the outline authority badge,
 * the balanced title and the closing line, over a section rail and its
 * panels — Overview's `md:grid-cols-3` metadata cards, the bid checklist
 * as `rounded-xl border p-4` rows (not a table; the mock has none here),
 * and the iREPS panel's `lg:grid-cols-[1.2fr_.8fr]` readiness/adapter
 * pair with its "Simulation mode" badge.
 *
 * Four divergences, each `docs/UX.md` § Approved divergences 4 —
 * behaviour the mock fakes, rebuilt in its own grammar:
 *
 *   1. **The rail has three sections, not four.** The mock's "Railway
 *      documents" tab is a per-tender file store; the application has no
 *      server capability for one and does not invent a third place to
 *      keep documents beside the Work's and the company library's.
 *   2. **The checklist attaches library credentials only.** The mock
 *      offers three source modes — Generate, Reusable, Upload — of which
 *      two are `useState` fictions (there is no declaration generator and
 *      no per-tender store). Reusable is the one that is real, and it is
 *      the one the pack is for: a checklist line points at a credential
 *      in the company document library (migration 0079).
 *   3. **Validity is read against the CLOSING DATE.** The mock compares a
 *      certificate's expiry to today. A bid is opened on the closing day,
 *      so today is the wrong question — a certificate lapsing in three
 *      weeks is green in the library and useless for a tender closing in
 *      four. The chip is the library's own vocabulary
 *      (`ui/chip.tsx`: valid / expiring / expired), read against a
 *      different date.
 *   4. **The iREPS panel records, it does not simulate.** The mock's
 *      "Run upload simulation" writes four lines into an `alert()`. This
 *      one records what a human says they did on the portal, and says in
 *      the panel's own copy why that is the honest ceiling.
 *
 * The mock's `DscSigningGate` is absent throughout for the reason
 * `views/CompanyDocuments.tsx` gives: these are documents somebody else
 * issued, so there is nothing here for this organisation to sign.
 */

const SECTIONS = [
  ['overview', 'Overview'],
  ['checklist', 'Bid checklist'],
  ['submission', 'iREPS submission'],
] as const;

type Section = (typeof SECTIONS)[number][0];

/** What the register calls each derived validity reading, against this
 * tender's closing date rather than against today. */
const VALIDITY_LABELS = {
  none: 'No expiry',
  valid: 'Valid at close',
  expiring: 'Lapses soon after',
  expired: 'Expired by close',
} as const;

/** The transitions the trail offers from where a bid stands. The same
 * moves the 0083 trigger allows; a button the server would refuse is a
 * button that should not be drawn. */
const NEXT_STATUSES: Record<TenderStatus, readonly TenderStatus[]> = {
  drafted: ['submitted', 'lost'],
  submitted: ['opened', 'awarded', 'lost'],
  opened: ['awarded', 'lost'],
  awarded: [],
  lost: [],
};

const STATUS_ACTIONS: Record<TenderStatus, string> = {
  drafted: 'Back to drafting',
  submitted: 'Record submission',
  opened: 'Record bid opening',
  awarded: 'Record award',
  lost: 'Record as not won',
};

interface TenderWorkspaceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly tenderId: string;
  readonly canModify: boolean;
  readonly onOpenWork: (workId: string) => void;
  readonly onUploadAwardLetter: (tenderId: string) => void;
}

export function TenderWorkspace({
  api,
  organisationId,
  tenderId,
  canModify,
  onOpenWork,
  onUploadAwardLetter,
}: TenderWorkspaceProps) {
  const [tender, setTender] = useState<TenderDetail | null>(null);
  const [credentials, setCredentials] = useState<readonly CompanyDocument[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [section, setSection] = useState<Section>('overview');
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTender(null);
    setLoadError(null);
    Promise.all([
      api.getTender(organisationId, tenderId),
      api.listCompanyDocuments(organisationId),
    ])
      .then(([loaded, library]) => {
        if (cancelled) return;
        setTender(loaded);
        setCredentials(
          library.documents.filter((credential) => credential.archivedAt === null),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The tender could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, tenderId, loadVersion]);

  /** Answers whether the server took it. A form that clears itself on the
   * way out loses what the operator typed the moment a 409 comes back —
   * and the two refusals this screen produces most, a blocking checklist
   * line and an illegal transition, both arrive after the iREPS
   * acknowledgement has been entered. */
  const act = useCallback(
    async (work: () => Promise<TenderDetail>, done: string): Promise<boolean> => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        setTender(await work());
        setNotice(done);
        return true;
      } catch (cause) {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The action failed; nothing was changed.',
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  const header = (
    <PageHeader
      title="Tender workspace"
      titleId="tender-workspace-title"
      description="Prepare the bid package, attach the credentials the tender asks for, and record what happened on iREPS."
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
          retryLabel="Retry tender"
        >
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (tender === null) {
    return (
      <>
        {header}
        <LoadingState label="the tender" rows={4} columns={2} />
      </>
    );
  }

  const blocking = tender.checklist.filter((line) => line.blocking).length;
  const attached = tender.checklist.filter(
    (line) => line.companyDocumentId !== null,
  ).length;

  return (
    <>
      {header}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}

      <div className="flex flex-col gap-5">
        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm tabular-nums text-primary">
                  {tender.tenderNumber}
                </span>
                <Badge variant="outline">{tender.authority}</Badge>
                <StatusChip status={tender.status}>{tender.status}</StatusChip>
              </div>
              <h2 className="mt-2 text-xl font-semibold text-balance">
                {tender.title}
              </h2>
              <p className="mt-2 m-0 text-sm text-muted-foreground">
                Closes{' '}
                <span className="font-mono tabular-nums">
                  {formatLocalDateTime(tender.bidClosesAtLocal)}
                </span>{' '}
                ·{' '}
                <span className="font-mono tabular-nums">
                  {Math.abs(tender.daysToClose)}
                </span>{' '}
                {tender.daysToClose < 0 ? 'days ago' : 'days away'}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge variant="neutral">
                {attached}/{tender.checklistTotal} attached
              </Badge>
              <Badge variant={blocking === 0 ? 'success' : 'destructive'}>
                {blocking} blocking
              </Badge>
            </div>
          </div>
        </Card>

        {/* The section rail, in the grammar `views/WorkDetail.tsx` already
            carries for the mock's `components/work-section-nav`: a 44px
            underline tab on a scrollable rule, weight rather than colour
            carrying the active state.
            ponytail: duplicated rather than extracted into a shared tabs
            primitive. WorkDetail's rail is wired to hash routing and count
            pills this one does not want, so the primitive would have to
            grow options for both — a bigger, riskier diff than twenty
            lines buys. Extract it when a third rail appears. */}
        <nav
          className="-mb-1 flex max-w-full items-center gap-1 overflow-x-auto border-b border-border"
          aria-label="Tender sections"
        >
          {SECTIONS.map(([key, label]) => {
            const current = section === key;
            return (
              <button
                key={key}
                type="button"
                className={cn(
                  '-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3',
                  'text-sm whitespace-nowrap transition-colors',
                  current
                    ? 'border-primary font-medium text-foreground'
                    : 'font-normal text-muted-foreground hover:text-foreground',
                )}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  setSection(key);
                }}
              >
                {label}
              </button>
            );
          })}
        </nav>

        {section === 'overview' && (
          <Overview
            tender={tender}
            canModify={canModify}
            onOpenNotice={() => {
              const noticeId = tender.noticeId;
              if (noticeId === null) return;
              // A download, not a mutation: nothing to put back into
              // `tender`, so it does not go through `act` and does not
              // raise the pending flag on every other control.
              setActionError(null);
              void openPdf(() =>
                api.downloadTenderNotice(organisationId, noticeId),
              ).catch((cause: unknown) => {
                setActionError(
                  cause instanceof RequestFailedError
                    ? cause.message
                    : 'The notice could not be opened.',
                );
              });
            }}
            onOpenWork={onOpenWork}
            onUploadAwardLetter={() => {
              onUploadAwardLetter(tender.id);
            }}
          />
        )}

        {section === 'checklist' && (
          <Checklist
            tender={tender}
            credentials={credentials}
            canModify={canModify}
            pending={pending}
            onAdd={(title) =>
              act(
                () => api.addTenderChecklistItem(organisationId, tender.id, { title }),
                `"${title}" added to the checklist.`,
              )
            }
            onAttach={(itemId, companyDocumentId) =>
              void act(
                () =>
                  api.attachTenderChecklistDocument(
                    organisationId,
                    tender.id,
                    itemId,
                    companyDocumentId,
                  ),
                companyDocumentId === null
                  ? 'Credential detached from the line.'
                  : 'Credential attached to the line.',
              )
            }
            onRemove={(itemId, title) =>
              void act(
                () => api.removeTenderChecklistItem(organisationId, tender.id, itemId),
                `"${title}" removed from the checklist.`,
              )
            }
          />
        )}

        {section === 'submission' && (
          <Submission
            tender={tender}
            blocking={blocking}
            canModify={canModify}
            pending={pending}
            onTransition={(status, note, irepsReference) =>
              act(
                () =>
                  api.updateTenderStatus(organisationId, tender.id, {
                    status,
                    ...(note === '' ? {} : { note }),
                    ...(irepsReference === '' ? {} : { irepsReference }),
                  }),
                `Recorded: ${STATUS_ACTIONS[status].toLowerCase()}.`,
              )
            }
          />
        )}
      </div>
    </>
  );
}

function Overview({
  tender,
  canModify,
  onOpenNotice,
  onOpenWork,
  onUploadAwardLetter,
}: {
  readonly tender: TenderDetail;
  readonly canModify: boolean;
  readonly onOpenNotice: () => void;
  readonly onOpenWork: (workId: string) => void;
  readonly onUploadAwardLetter: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <h3 className="m-0 text-sm font-semibold">NIT record</h3>
          </CardHeader>
          {tender.noticeFilename === null ? (
            <p className="m-0 text-sm text-muted-foreground">
              Recorded by hand — no notice was uploaded.
            </p>
          ) : (
            <>
              <p className="m-0 truncate text-sm font-medium">
                {tender.noticeFilename}
              </p>
              <p className="mt-2 m-0 text-xs text-muted-foreground">
                Confirmed extraction · original retained
              </p>
              <Actions>
                <Button variant="outline" size="sm" onClick={onOpenNotice}>
                  Open notice
                </Button>
              </Actions>
            </>
          )}
        </Card>
        <Card>
          <CardHeader>
            <h3 className="m-0 text-sm font-semibold">Estimated value</h3>
          </CardHeader>
          <p className="metric-value m-0">
            {tender.estimatedValue === null ? '—' : formatInr(tender.estimatedValue)}
          </p>
          <p className="mt-2 m-0 text-xs text-muted-foreground">
            EMD{' '}
            <span className="font-mono tabular-nums">
              {tender.emdAmount === null ? '—' : formatInr(tender.emdAmount)}
            </span>
          </p>
        </Card>
        <Card>
          <CardHeader>
            <h3 className="m-0 text-sm font-semibold">Eligibility</h3>
          </CardHeader>
          <p className="m-0 text-sm">
            {tender.eligibilitySummary ?? 'Not recorded from the notice.'}
          </p>
        </Card>
      </div>

      {/* Award conversion. Deliberately a deep link into the ordinary LOA
          intake, carrying this tender so the letter that comes back is
          recorded against it — `docs/UX.md` § Contract-source intake owns
          Work creation, and this pack does not open a second door to it. */}
      {tender.status === 'awarded' && (
        <Card>
          <CardHeader>
            <h3 className="m-0 text-sm font-semibold">Convert to Work</h3>
          </CardHeader>
          {tender.award === null ? (
            <>
              <p className="m-0 text-sm text-muted-foreground">
                This tender was won. The Work is created from the Letter of Acceptance,
                through the ordinary contract intake — upload the LOA and Auto-MB will
                record it against this tender.
              </p>
              {canModify && (
                <Actions>
                  <Button onClick={onUploadAwardLetter}>
                    <FileUp data-icon="inline-start" aria-hidden="true" />
                    Upload the Letter of Acceptance
                  </Button>
                </Actions>
              )}
            </>
          ) : tender.award.workId === null ? (
            <p className="m-0 text-sm text-muted-foreground">
              <span className="font-medium">{tender.award.loaFilename}</span> is
              recorded against this tender and is waiting to be reviewed. The Work
              appears here once the letter is confirmed.
            </p>
          ) : (
            <>
              <p className="m-0 text-sm text-muted-foreground">
                Confirmed into Work{' '}
                <span className="font-mono tabular-nums">{tender.award.workCode}</span>{' '}
                from <span className="font-medium">{tender.award.loaFilename}</span>.
              </p>
              <Actions>
                <a
                  href={workHash(tender.award.workId)}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  onClick={navigateOnClick(() => {
                    onOpenWork(tender.award?.workId ?? '');
                  })}
                >
                  Open Work {tender.award.workCode}
                </a>
              </Actions>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function Checklist({
  tender,
  credentials,
  canModify,
  pending,
  onAdd,
  onAttach,
  onRemove,
}: {
  readonly tender: TenderDetail;
  readonly credentials: readonly CompanyDocument[];
  readonly canModify: boolean;
  readonly pending: boolean;
  readonly onAdd: (title: string) => Promise<boolean>;
  readonly onAttach: (itemId: string, companyDocumentId: string | null) => void;
  readonly onRemove: (itemId: string, title: string) => void;
}) {
  const [title, setTitle] = useState('');
  const locked = tender.status !== 'drafted';
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Tender document checklist</h2>
      </CardHeader>
      {locked ? (
        <Hint>
          This bid has been submitted, so the checklist is now the record of what went
          out and no longer changes.
        </Hint>
      ) : (
        canModify && (
          <form
            className="mb-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = title.trim();
              if (trimmed === '') return;
              void onAdd(trimmed).then((added) => {
                if (added) setTitle('');
              });
            }}
          >
            <Field className="my-0 min-w-60 flex-1">
              <label htmlFor="tender-checklist-title">
                Add a document the tender asks for
              </label>
              <input
                id="tender-checklist-title"
                value={title}
                maxLength={200}
                placeholder="Bank solvency certificate"
                onChange={(event) => {
                  setTitle(event.currentTarget.value);
                }}
              />
            </Field>
            <Button type="submit" disabled={pending}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add
            </Button>
          </form>
        )
      )}
      {tender.checklist.length === 0 ? (
        <EmptyState>
          Nothing on the checklist yet. Add each document the tender asks for, then
          attach the company credential that answers it.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {tender.checklist.map((line) => (
            <li key={line.id}>
              <ChecklistRow
                line={line}
                credentials={credentials}
                canModify={canModify && !locked}
                pending={pending}
                onAttach={onAttach}
                onRemove={onRemove}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChecklistRow({
  line,
  credentials,
  canModify,
  pending,
  onAttach,
  onRemove,
}: {
  readonly line: TenderChecklistItem;
  readonly credentials: readonly CompanyDocument[];
  readonly canModify: boolean;
  readonly pending: boolean;
  readonly onAttach: (itemId: string, companyDocumentId: string | null) => void;
  readonly onRemove: (itemId: string, title: string) => void;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 lg:flex-row lg:items-center lg:justify-between',
        line.blocking ? 'border-destructive/40' : 'border-border',
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 font-medium">{line.title}</p>
          {line.mandatory && <Badge variant="outline">Mandatory</Badge>}
          {/* Archived is its own chip beside the validity reading, not
              instead of it: "retired from the library" and "lapses before
              the bid opens" are different problems, and an operator told
              only "Expired" would go and renew a certificate that does
              not need renewing. */}
          {line.companyDocumentArchived && (
            <StatusChip status="archived">Archived</StatusChip>
          )}
          {line.validity !== null && (
            <StatusChip status={line.validity}>
              {VALIDITY_LABELS[line.validity]}
            </StatusChip>
          )}
        </div>
        <p className="mt-1 m-0 text-xs text-muted-foreground">
          {line.restricted ? (
            /* A credential IS attached; this reader may not be told which
               one. The line keeps its validity chip and its blocking
               state, so the counts are the same ones a writer sees. */
            'Restricted credential attached — financial documents are readable by owner or office members only'
          ) : line.companyDocumentTitle === null ? (
            'Document pending — nothing attached'
          ) : (
            <>
              {line.companyDocumentTitle}
              {line.companyDocumentVersionNumber !== null && (
                <>
                  {' '}
                  ·{' '}
                  <span className="font-mono tabular-nums">
                    v{line.companyDocumentVersionNumber}
                  </span>
                </>
              )}
              {line.expiresOn !== null && (
                <>
                  {' '}
                  · valid until{' '}
                  <span className="font-mono tabular-nums">
                    {formatDate(line.expiresOn)}
                  </span>
                  {line.expiresInDaysAtClose !== null && (
                    <>
                      {' '}
                      (
                      <span className="font-mono tabular-nums">
                        {Math.abs(line.expiresInDaysAtClose)}
                      </span>{' '}
                      days {line.expiresInDaysAtClose < 0 ? 'before' : 'after'} the bid
                      closes)
                    </>
                  )}
                </>
              )}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {canModify ? (
          <>
            <label className="sr-only" htmlFor={`attach-${line.id}`}>
              Company credential for {line.title}
            </label>
            <select
              id={`attach-${line.id}`}
              className="h-8 max-w-56 text-sm"
              value={line.companyDocumentId ?? ''}
              disabled={pending}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onAttach(line.id, value === '' ? null : value);
              }}
            >
              <option value="">Not attached</option>
              {/* The attached credential may have been archived since,
                  and the option list holds only live ones. Without this
                  the select would fall back to "Not attached" and read as
                  though nothing were attached at all — the opposite of
                  what the row above says. It is present so the control
                  tells the truth, and disabled so it cannot be re-chosen. */}
              {line.companyDocumentArchived &&
                line.companyDocumentId !== null &&
                line.companyDocumentTitle !== null && (
                  <option value={line.companyDocumentId} disabled>
                    {line.companyDocumentTitle} (archived)
                  </option>
                )}
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.title}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                onRemove(line.id, line.title);
              }}
            >
              Remove
            </Button>
          </>
        ) : line.companyDocumentTitle !== null ? (
          <Badge variant="neutral">
            <ShieldCheck className="size-3" aria-hidden="true" /> Attached
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function Submission({
  tender,
  blocking,
  canModify,
  pending,
  onTransition,
}: {
  readonly tender: TenderDetail;
  readonly blocking: number;
  readonly canModify: boolean;
  readonly pending: boolean;
  readonly onTransition: (
    status: TenderStatus,
    note: string,
    irepsReference: string,
  ) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const next = NEXT_STATUSES[tender.status];
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Package readiness</h2>
        </CardHeader>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <span className="text-sm">Confirmed NIT metadata</span>
          <Badge variant={tender.noticeId === null ? 'neutral' : 'success'}>
            {tender.noticeId === null ? 'Entered by hand' : 'From the notice'}
          </Badge>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg border border-border p-3">
          <span className="text-sm">Mandatory credentials, valid at close</span>
          <Badge variant={blocking === 0 ? 'success' : 'destructive'}>
            {tender.checklistTotal - blocking}/{tender.checklistTotal}
          </Badge>
        </div>
        <Hint>
          A credential that lapses before the closing date counts as missing here, not
          as attached. That is the whole reason the checklist points at the library
          rather than holding its own copies.
        </Hint>

        <h3 className="mt-4 text-sm font-semibold">Status trail</h3>
        <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {tender.statusEvents.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
              <StatusChip status={event.toStatus}>{event.toStatus}</StatusChip>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatTimestamp(event.occurredAt)}
              </span>
              {event.note !== null && (
                <span className="text-muted-foreground">{event.note}</span>
              )}
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Record an iREPS step</h2>
        </CardHeader>
        <Badge variant="warning" className="w-fit">
          Tracking only
        </Badge>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          iREPS has no interface a program may use, and a live upload stops for a
          CAPTCHA, an OTP and a local DSC. Auto-MB therefore records what you did on the
          portal — it never files on your behalf, and nothing here has been verified
          against iREPS.
        </p>
        {next.length === 0 ? (
          <Hint>This tender is {tender.status}, which is where its trail ends.</Hint>
        ) : (
          canModify && (
            <>
              <Field className="max-w-none">
                <label htmlFor="tender-ireps-reference">
                  iREPS acknowledgement (optional)
                </label>
                <input
                  id="tender-ireps-reference"
                  className="font-mono tabular-nums"
                  value={reference}
                  maxLength={120}
                  placeholder="What the portal printed back"
                  onChange={(event) => {
                    setReference(event.currentTarget.value);
                  }}
                />
              </Field>
              <Field className="max-w-none">
                <label htmlFor="tender-status-note">Note (optional)</label>
                <input
                  id="tender-status-note"
                  value={note}
                  maxLength={1000}
                  onChange={(event) => {
                    setNote(event.currentTarget.value);
                  }}
                />
              </Field>
              {blocking > 0 && (
                <Hint>
                  {blocking} mandatory line{blocking === 1 ? '' : 's'} still
                  {blocking === 1 ? ' has' : ' have'} no valid credential, so the
                  submission cannot be recorded yet.
                </Hint>
              )}
              <Actions>
                {next.map((status) => (
                  <Button
                    key={status}
                    variant={status === 'lost' ? 'outline' : 'default'}
                    disabled={pending || (status === 'submitted' && blocking > 0)}
                    onClick={() => {
                      void onTransition(status, note.trim(), reference.trim()).then(
                        (recorded) => {
                          if (!recorded) return;
                          setNote('');
                          setReference('');
                        },
                      );
                    }}
                  >
                    {status === 'submitted' && (
                      <Download data-icon="inline-start" aria-hidden="true" />
                    )}
                    {STATUS_ACTIONS[status]}
                  </Button>
                ))}
              </Actions>
            </>
          )
        )}
        {tender.irepsReference !== null && (
          <p className="mt-3 m-0 text-xs text-muted-foreground">
            Acknowledgement{' '}
            <span className="font-mono tabular-nums">{tender.irepsReference}</span>
          </p>
        )}
      </Card>
    </div>
  );
}
