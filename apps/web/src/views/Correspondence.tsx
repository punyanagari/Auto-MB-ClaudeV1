import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ClipboardCheck, Plus, Upload } from 'lucide-react';
import type {
  CorrespondenceCounts,
  CorrespondenceEntry,
  CorrespondenceTab,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { openPdf } from '../lib/openPdf.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable } from '../ui/table.js';
import { TabRail } from '../ui/tab-rail.js';
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
 * Five things the mock's screen cannot express, each built from its own
 * components rather than beside them, and each recorded in `docs/UX.md`:
 *
 *   * **The tabs read three different modules.** Extension requests live
 *     in `extension_requests` and inspection call letters in
 *     `inspection_calls`; this screen projects both and writes neither.
 *     Each produces up to two rows — the letter that went out and the
 *     answer that came back — which the mock's single seed array cannot
 *     model.
 *   * **The letter number is a link** where the paper behind it can be
 *     produced. The mock's cell is inert text because its rows have no
 *     files; here an outward letter renders on demand and an inward one
 *     is the stored scan, and a register with no way to reach either is a
 *     register nobody can work from.
 *   * **A Reply due column on the Inward tab**, the way the Extensions
 *     tab carries Extension until. The banner above promises due-date
 *     tracking, and the mock's own inward form captures the date; showing
 *     it is what makes the promise true.
 *   * **A cancel action**, for owner/office members holding the cancel
 *     authority. A misrecorded letter is otherwise permanent — there is
 *     no DELETE grant on the table — and the retained number needs the
 *     reason beside it to explain what it stands for.
 *   * **Load more.** The mock's register is fifteen literals; a real one
 *     is a financial year of letters, so the tabs page.
 */

/** Rows per page. The mock draws no paging control at all, so the size is
 * this build's: large enough that a first screen of correspondence is one
 * request, small enough that a year of it is not. */
const PAGE_SIZE = 50;

interface CorrespondenceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Writing and registering letters is owner/office work, exactly as the
   * server gates it. A viewer reads the register. */
  readonly canModify: boolean;
  /** The cancel authority, which the server checks on the same route. */
  readonly canCancel: boolean;
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
  canCancel,
  onWriteLetter,
  onUploadInward,
}: CorrespondenceProps) {
  const [tab, setTab] = useState<CorrespondenceTab>('outward');
  const [entries, setEntries] = useState<readonly CorrespondenceEntry[] | null>(null);
  const [counts, setCounts] = useState<CorrespondenceCounts | null>(null);
  const [awaiting, setAwaiting] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const [cancelling, setCancelling] = useState<CorrespondenceEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setLoadError(null);
    api
      .listCorrespondence(organisationId, { tab, limit: PAGE_SIZE })
      .then((loaded) => {
        if (cancelled) return;
        setEntries(loaded.entries);
        setCounts(loaded.counts);
        setAwaiting(loaded.awaitingExtensionResponses);
        setNextCursor(loaded.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The correspondence register could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, tab, loadVersion]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setLoadError(null);
    api
      .listCorrespondence(organisationId, { tab, limit: PAGE_SIZE, cursor: nextCursor })
      .then((page) => {
        setEntries((current) => [...(current ?? []), ...page.entries]);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        setLoadError(errorMessage(cause, 'The next page could not be loaded.'));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [api, organisationId, tab, nextCursor]);

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

  if (loadError !== null && entries === null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry correspondence">
          {loadError}
        </ErrorState>
      </>
    );
  }

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

      <TabRail
        label="Correspondence register"
        tabs={TABS.map(([key, label]) => [
          key,
          counts === null ? label : `${label} (${String(counts[key])})`,
        ])}
        active={tab}
        onSelect={setTab}
      />

      <div className="mt-4">
        {entries === null ? (
          <LoadingState label="the correspondence register" rows={5} columns={5} />
        ) : tab === 'inspection' ? (
          <InspectionLetters entries={entries} />
        ) : (
          <LettersTable
            api={api}
            organisationId={organisationId}
            tab={tab}
            entries={entries}
            canCancel={canCancel}
            onCancel={setCancelling}
          />
        )}

        {loadError !== null && entries !== null && (
          <p className="alert error" role="alert">
            {loadError}
          </p>
        )}

        {nextCursor !== null && entries !== null && (
          <div className="mt-3">
            <Button variant="outline" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more letters'}
            </Button>
          </div>
        )}
      </div>

      {cancelling !== null && (
        <CancelLetterDialog
          api={api}
          organisationId={organisationId}
          entry={cancelling}
          onClose={() => {
            setCancelling(null);
          }}
          onCancelled={() => {
            setCancelling(null);
            reload();
          }}
        />
      )}
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
  canCancel,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly tab: CorrespondenceTab;
  readonly entries: readonly CorrespondenceEntry[];
  readonly canCancel: boolean;
  readonly onCancel: (entry: CorrespondenceEntry) => void;
}) {
  const extension = tab === 'extensions';
  const inward = tab === 'inward';
  // Only this module's own letters cancel here; the projections cancel in
  // the module that owns them, and an extensions tab is never cancellable
  // from this screen at all.
  const cancellable =
    canCancel && !extension && entries.some((entry) => entry.source === 'letter');
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
          {inward && <th scope="col">Reply due</th>}
          <th className="hidden sm:table-cell" scope="col">
            Status
          </th>
          {cancellable && (
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          )}
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
            {inward && (
              <td className="font-mono text-sm tabular-nums">
                {entry.replyDueOn === null ? '—' : formatDate(entry.replyDueOn)}
              </td>
            )}
            <td className="hidden sm:table-cell">
              <StatusChip status={entry.status} />
            </td>
            {cancellable && (
              <td>
                {entry.source === 'letter' && entry.status !== 'cancelled' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onCancel(entry);
                    }}
                  >
                    Cancel…
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/** The number, and the letter behind it where there is one.
 *
 * Only a `letter` row has a document this module's route can serve: an
 * extension letter's PDF belongs to the extensions module and an
 * inspection call letter's scan to the inspection module, both of which
 * have their own screens. Those read as plain text here rather than as
 * links that would fetch from an endpoint that does not own them. */
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
  if (entry.source !== 'letter') {
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
            setFailure(errorMessage(cause, 'The letter could not be opened.'));
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

/** Cancelling a letter, in the product's one confirmation shape.
 *
 * The reason is required and the confirm button is held until it is
 * given, which is what `ui/confirm.tsx`'s `confirmDisabled` is for: the
 * server refuses a blank reason, and a button that presses and then does
 * nothing is worse than one that says what is missing. */
function CancelLetterDialog({
  api,
  organisationId,
  entry,
  onClose,
  onCancelled,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly entry: CorrespondenceEntry;
  readonly onClose: () => void;
  readonly onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <ConfirmDialog
      title={`Cancel letter ${entry.number}?`}
      description="The letter keeps its number forever — the series is gap-free, so a cancelled number is never handed out again. File the corrected letter as a new one."
      confirmLabel="Cancel letter"
      cancelLabel="Keep the letter"
      tone="destructive"
      pending={pending}
      confirmDisabled={reason.trim().length < 3}
      onCancel={onClose}
      onConfirm={() => {
        setPending(true);
        setFailure(null);
        api
          .cancelCorrespondenceLetter(organisationId, entry.id, reason.trim())
          .then(onCancelled)
          .catch((cause: unknown) => {
            setPending(false);
            setFailure(errorMessage(cause, 'The letter could not be cancelled.'));
          });
      }}
    >
      <label className="text-sm font-medium" htmlFor="cancel-letter-reason">
        Why is it being cancelled?
      </label>
      <textarea
        id="cancel-letter-reason"
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(event) => {
          setReason(event.currentTarget.value);
        }}
      />
      {failure !== null && (
        <p className="alert error" role="alert">
          {failure}
        </p>
      )}
    </ConfirmDialog>
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
