import { useEffect, useState } from 'react';
import { CalendarClock, ClipboardCheck, Plus, Upload } from 'lucide-react';
import type {
  CorrespondenceEntry,
  CorrespondenceListResponse,
  CorrespondenceTab,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { cn } from '../lib/cn.js';
import { openPdf } from '../lib/openPdf.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The correspondence register.
 *
 * Replicates `app/correspondence/page.tsx` of the frozen mock at
 * `fdfe5ef`: the page header with its two actions, the amber
 * extension-request banner, a four-tab rail carrying counts, and the
 * mock's `LettersTable` — Letter (number over date), Contact, Subject,
 * Reference (Work code over the counterparty's own reference), an
 * Extension-until column that appears on one tab only, and the status
 * chip.
 *
 * Three things the mock's screen cannot express, each built from its own
 * components rather than beside them, and each recorded in `docs/UX.md`:
 *
 *   * **The tabs read three different modules.** Extension requests live
 *     in `extension_requests` and inspection call letters in
 *     `inspection_calls`; this screen projects both and writes neither.
 *     The mock's own seed makes them rows of one array, which is the one
 *     shape a real product cannot have.
 *   * **The letter number is a link** where the paper behind it can be
 *     produced. The mock's cell is inert text because its rows have no
 *     files; here an outward letter renders on demand and an inward one
 *     is the stored scan, and a register with no way to reach either is a
 *     register nobody can work from.
 *   * **The inspection tab lists every call**, using the mock's own
 *     two-row card markup mapped over real data rather than the two
 *     hard-coded rows it draws.
 */

interface CorrespondenceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Writing and registering letters is owner/office work, exactly as the
   * server gates it. A viewer reads the register. */
  readonly canModify: boolean;
  readonly onWriteLetter: () => void;
  readonly onUploadInward: () => void;
}

const TABS: readonly (readonly [CorrespondenceTab, string])[] = [
  ['outward', 'Outward'],
  ['inward', 'Inward'],
  ['extensions', 'Extension requests'],
  ['inspection', 'Inspection letters'],
];

export function Correspondence({
  api,
  organisationId,
  canModify,
  onWriteLetter,
  onUploadInward,
}: CorrespondenceProps) {
  const [tab, setTab] = useState<CorrespondenceTab>('outward');
  const [answer, setAnswer] = useState<CorrespondenceListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAnswer(null);
    setLoadError(null);
    api
      .listCorrespondence(organisationId, { tab })
      .then((loaded) => {
        if (cancelled) return;
        setAnswer(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The correspondence register could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, tab, loadVersion]);

  const header = (
    <PageHeader
      eyebrow="Documents"
      title="Correspondence"
      titleId="correspondence-title"
      description="Write and track letters linked to Works, contacts, or earlier correspondence."
      action={
        canModify ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onUploadInward}>
              <Upload data-icon="inline-start" aria-hidden="true" />
              Upload inward
            </Button>
            <Button onClick={onWriteLetter}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              New letter
            </Button>
          </div>
        ) : undefined
      }
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
          retryLabel="Retry correspondence"
        >
          {loadError}
        </ErrorState>
      </>
    );
  }

  const counts = answer?.counts;
  const awaiting = answer?.awaitingExtensionResponses ?? 0;

  return (
    <>
      {header}

      {awaiting > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <CalendarClock className="text-warning-foreground" aria-hidden="true" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {/* Pluralised, which the mock's literal is not. A textual
                  change may land application-first (AGENTS.md § Design
                  contract 2). */}
              {awaiting} extension {awaiting === 1 ? 'request' : 'requests'} awaiting
              response
            </span>
            <span className="text-xs text-muted-foreground">
              Track due dates separately from routine correspondence.
            </span>
          </div>
        </div>
      )}

      {/* The mock's boxed tab list. `aria-pressed` toggles rather than a
          `role="tablist"`, for the reason `docs/UX.md` § 9 gives for the
          inspection agency pills: these filter one panel in place, and
          `test/a11y-invariants` refuses a tablist without the roving
          tabindex pattern to match. */}
      <div className="overflow-x-auto pb-1">
        <div
          className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
          role="group"
          aria-label="Correspondence register"
        >
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              className={cn(
                'h-8 shrink-0 rounded-md px-3 text-sm font-medium transition-colors',
                tab === key
                  ? 'bg-card text-foreground shadow-[0_1px_2px_0_rgb(15_23_42/0.05)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => {
                setTab(key);
              }}
            >
              {label}
              {counts === undefined ? '' : ` (${String(counts[key])})`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {answer === null ? (
          <LoadingState label="the correspondence register" rows={5} columns={5} />
        ) : tab === 'inspection' ? (
          <InspectionLetters entries={answer.entries} />
        ) : (
          <LettersTable
            api={api}
            organisationId={organisationId}
            tab={tab}
            entries={answer.entries}
          />
        )}
      </div>
    </>
  );
}

const TAB_EMPTY: Readonly<Record<CorrespondenceTab, string>> = {
  outward: 'No outward letter has been dispatched yet. Write one to open the series.',
  inward: 'No inward letter has been registered yet. Upload one with its scan.',
  extensions:
    "No extension of time has been requested. Raise one from the Work's completion dates.",
  inspection:
    "No inspection call has been raised. Raise one from the Work's Inspection clause tab.",
};

function LettersTable({
  api,
  organisationId,
  tab,
  entries,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly tab: CorrespondenceTab;
  readonly entries: readonly CorrespondenceEntry[];
}) {
  const extension = tab === 'extensions';
  if (entries.length === 0) return <EmptyState>{TAB_EMPTY[tab]}</EmptyState>;
  return (
    <DataTable>
      <caption className="sr-only">
        {extension ? 'Extension request letters' : `${tab} correspondence`}
      </caption>
      <thead>
        <tr>
          <th scope="col">Letter</th>
          <th scope="col">Contact</th>
          <th className="hidden md:table-cell" scope="col">
            Subject
          </th>
          <th className="hidden lg:table-cell" scope="col">
            Reference
          </th>
          {extension && <th scope="col">Extension until</th>}
          <th className="hidden sm:table-cell" scope="col">
            Status
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={`${entry.source}-${entry.id}-${entry.direction}`}>
            <td>
              <div className="flex flex-col gap-0.5">
                <LetterNumber api={api} organisationId={organisationId} entry={entry} />
                <span className="text-xs text-muted-foreground">
                  {formatDate(entry.date)}
                </span>
              </div>
            </td>
            <td className="max-w-44 truncate text-sm">{entry.counterparty}</td>
            <td className="hidden max-w-52 text-sm text-muted-foreground md:table-cell">
              {entry.subject}
            </td>
            <td className="hidden lg:table-cell">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs tabular-nums">
                  {entry.workCode ?? 'General'}
                </span>
                <span className="max-w-44 truncate text-xs text-muted-foreground">
                  {entry.reference ?? 'No reference'}
                </span>
              </div>
            </td>
            {extension && (
              <td className="font-mono text-sm tabular-nums">
                {entry.extensionUntil === null ? '—' : formatDate(entry.extensionUntil)}
              </td>
            )}
            <td className="hidden sm:table-cell">
              <StatusChip status={entry.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/** The number, and the letter behind it where there is one.
 *
 * Only a `letter` row has a document this route can serve: an extension
 * letter's PDF belongs to the extensions module and an inspection call
 * letter's scan to the inspection module, both of which have their own
 * screens. Those read as plain text here rather than as links that would
 * fetch from an endpoint that does not own them. */
function LetterNumber({
  api,
  organisationId,
  entry,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly entry: CorrespondenceEntry;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const className = 'font-mono text-sm font-medium tabular-nums';
  if (entry.source !== 'letter' || !entry.documentAvailable) {
    return <span className={className}>{entry.number}</span>;
  }
  return (
    <>
      <button
        type="button"
        className={cn(
          className,
          'w-fit text-left text-primary underline-offset-4 hover:underline',
        )}
        onClick={() => {
          setFailure(null);
          openPdf(() =>
            api.downloadCorrespondenceLetter(organisationId, entry.id),
          ).catch((cause: unknown) => {
            setFailure(
              cause instanceof RequestFailedError
                ? cause.message
                : 'The letter could not be opened.',
            );
          });
        }}
      >
        {entry.number}
      </button>
      {failure !== null && (
        <span className="text-xs text-destructive" role="alert">
          {failure}
        </span>
      )}
    </>
  );
}

/**
 * The inspection tab: the mock's two-row card, mapped over every call.
 *
 * The mock draws exactly two rows because they are literals. One call
 * produces an outward request and, once the agency answers, an inward
 * call letter, so the same anatomy repeats per call — an outward row with
 * the primary clipboard icon and an inward row with the muted upload
 * icon, both carrying the Work code and the agency in the detail line the
 * mock writes.
 */
function InspectionLetters({
  entries,
}: {
  readonly entries: readonly CorrespondenceEntry[];
}) {
  if (entries.length === 0) return <EmptyState>{TAB_EMPTY.inspection}</EmptyState>;
  return (
    <Card>
      <CardHeader className="sr-only">
        <h2>Inspection call letters</h2>
      </CardHeader>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.map((entry, index) => (
          <li
            key={`${entry.id}-${entry.direction}`}
            className={cn(
              'flex items-center gap-3',
              index < entries.length - 1 && 'border-b border-border pb-3',
            )}
          >
            {entry.direction === 'outward' ? (
              <ClipboardCheck
                className="size-5 shrink-0 text-primary"
                aria-hidden="true"
              />
            ) : (
              <Upload
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="m-0 font-mono text-sm font-medium tabular-nums">
                {entry.number}
              </p>
              <p className="m-0 truncate text-xs text-muted-foreground">
                {entry.workCode ?? 'General'} · {entry.subject}
              </p>
            </div>
            <StatusChip status={entry.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
