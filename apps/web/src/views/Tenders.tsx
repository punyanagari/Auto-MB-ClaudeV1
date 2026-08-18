import { useEffect, useState } from 'react';
import { Archive, CalendarClock, FilePlus2, Search, ShieldCheck } from 'lucide-react';
import type { TenderSummary } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatLocalDateTime } from '../format.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { navigateOnClick, tenderHash } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The tender register.
 *
 * Replicates `app/tenders/page.tsx` and `components/tender-dashboard.tsx`
 * of the frozen mock at fdfe5ef: three stat cards over a search row with
 * two actions, then an Upcoming/Expired tab pair whose panels hold a card
 * of `rounded-xl border p-4` rows — tender number in mono primary, the
 * authority as an outline badge, the title, the closing line, and a
 * days-left badge that turns destructive inside three days.
 *
 * Two things the mock's row cannot express, both built with its own
 * components rather than beside them:
 *
 *   * **The tender's own status chip.** The mock's dashboard has one
 *     status value (`draft`) and never renders it. A real pipeline has
 *     five, and `docs/DESIGN.md` § Status badge semantics makes the
 *     dot-plus-label chip the single vocabulary for record state.
 *   * **The blocking-lines count.** A mandatory checklist line with
 *     nothing attached — or attached to a credential that will have
 *     lapsed by the closing date — is the thing this register exists to
 *     surface. It reads as the mock's own `destructive` badge.
 *
 * The mock's "Company documents" toolbar button is absent: the library
 * has its own rail entry in this build (`shell/navigation.ts` explains
 * why), so a second door from here would be a duplicate rather than the
 * mock's only way in.
 */

interface TendersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Uploading a notice and confirming it are owner/office work, exactly
   * as the server gates them. A viewer reads the pipeline. */
  readonly canModify: boolean;
  readonly onOpenTender: (tenderId: string) => void;
  readonly onUploadNotice: () => void;
}

export function Tenders({
  api,
  organisationId,
  canModify,
  onOpenTender,
  onUploadNotice,
}: TendersProps) {
  const [tenders, setTenders] = useState<readonly TenderSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'upcoming' | 'expired'>('upcoming');
  /* Sampled once per render rather than per row, so every row on one
     paint is judged against one clock and the split cannot straddle a
     tender that closes mid-loop. */
  const now = Date.now();
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setTenders(null);
    setLoadError(null);
    api
      .listTenders(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setTenders(loaded.tenders);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The tenders could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const header = (
    <PageHeader
      title="Tenders"
      titleId="tenders-title"
      description="Track NITs, bid deadlines, document readiness, and iREPS submissions. Auto-MB records what was filed; it cannot file on the portal's behalf."
      action={
        canModify ? (
          <Button onClick={onUploadNotice}>
            <FilePlus2 data-icon="inline-start" aria-hidden="true" />
            Upload NIT
          </Button>
        ) : undefined
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry tenders">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (tenders === null) {
    return (
      <>
        {header}
        <LoadingState label="the tenders" rows={4} columns={3} />
      </>
    );
  }

  // The mock's own split, taken on the MOMENT rather than the day. A
  // tender closing at 15:00 is open at 14:59 and shut at 15:01 of the
  // same date, so `daysToClose >= 0` kept it in Upcoming for the rest of
  // the afternoon after the bid could no longer be filed — on exactly the
  // screen an operator opens to ask what is still open.
  const closed = (tender: TenderSummary): boolean =>
    Date.parse(tender.bidClosesAt) <= now;
  const upcoming = tenders.filter((tender) => !closed(tender));
  const expired = tenders.filter(closed);
  const ready = upcoming.filter(
    (tender) => tender.checklistTotal > 0 && tender.checklistBlocking === 0,
  );
  const shown = (tab === 'upcoming' ? upcoming : expired).filter((tender) =>
    `${tender.tenderNumber} ${tender.authority} ${tender.title}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {/* The mock's three stat cards, in its order and with its icons.
            The figure is the shared `ui/stat` — `.section-label` over
            `.metric-value`, mono and tabular — rather than a second stat
            anatomy written here, so a row of tiles on this screen keeps
            its digits in the same columns as every other. */}
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [
                <CalendarClock
                  key="upcoming"
                  className="size-5 text-primary"
                  aria-hidden="true"
                />,
                'Upcoming tenders',
                upcoming.length,
              ],
              [
                <ShieldCheck
                  key="ready"
                  className="size-5 text-success"
                  aria-hidden="true"
                />,
                'Bid packages complete',
                ready.length,
              ],
              [
                <Archive
                  key="closed"
                  className="size-5 text-muted-foreground"
                  aria-hidden="true"
                />,
                'Closed tenders',
                expired.length,
              ],
            ] as const
          ).map(([icon, label, value]) => (
            <Card key={label}>
              {icon}
              <Stat className="mt-3" label={label} value={String(value)} />
            </Card>
          ))}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-md flex-1">
            <Search
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <label className="sr-only" htmlFor="tender-search">
              Search tenders
            </label>
            <input
              id="tender-search"
              className="pl-9"
              placeholder="Search tender, authority, or scope"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          </div>
        </div>

        {/* The mock's boxed tab pair with counts. Two panels, so the rail
            is two buttons rather than a component nothing else needs. */}
        <div>
          <div
            className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
            role="group"
            aria-label="Tender pipeline"
          >
            {(
              [
                ['upcoming', `Upcoming (${String(upcoming.length)})`],
                ['expired', `Expired (${String(expired.length)})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                className={cn(
                  'h-8 rounded-md px-3 text-sm font-medium transition-colors',
                  tab === key
                    ? 'bg-card text-foreground shadow-[0_1px_2px_0_rgb(15_23_42/0.05)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => {
                  setTab(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <Card className="mt-4">
            <CardHeader>
              <h2 className="text-base font-semibold">
                {tab === 'upcoming' ? 'Open opportunities' : 'Expired tenders'}
              </h2>
            </CardHeader>
            {shown.length === 0 ? (
              <EmptyState>
                {tenders.length === 0
                  ? 'Upload an NIT to create the first tender. Auto-MB reads the number, the authority, the closing date and the money off it, and you confirm what it read.'
                  : 'No tender here matches that search.'}
              </EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {shown.map((tender) => (
                  <li key={tender.id}>
                    <TenderRow tender={tender} onOpen={onOpenTender} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** What the badge says about how long is left.
 *
 * `daysToClose` is a whole-day count and stays the display figure, but 0
 * means "closes today", which is true both before and after the closing
 * hour. So the day the tender closes reads as the TIME it closes, which
 * is the only thing an operator can act on that morning. */
function closingLabel(tender: TenderSummary): string {
  const remaining = tender.daysToClose;
  if (remaining === 0) {
    return Date.parse(tender.bidClosesAt) <= Date.now()
      ? `closed today ${tender.bidClosesAtLocal.slice(11, 16)}`
      : `closes today ${tender.bidClosesAtLocal.slice(11, 16)}`;
  }
  return remaining < 0
    ? `closed ${String(-remaining)} days ago`
    : `${String(remaining)} days left`;
}

function closingBadgeTone(tender: TenderSummary): 'destructive' | 'neutral' {
  return tender.daysToClose <= 3 ? 'destructive' : 'neutral';
}

function TenderRow({
  tender,
  onOpen,
}: {
  readonly tender: TenderSummary;
  readonly onOpen: (tenderId: string) => void;
}) {
  return (
    /* A real anchor with a hash href, not a div with a click handler:
       middle-click and open-in-new-tab have to work on a register row. */
    <a
      href={tenderHash(tender.id)}
      onClick={navigateOnClick(() => {
        onOpen(tender.id);
      })}
      className="flex flex-col gap-3 rounded-xl border border-border p-4 no-underline transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs tabular-nums text-primary">
            {tender.tenderNumber}
          </span>
          <Badge variant="outline">{tender.authority}</Badge>
          <StatusChip status={tender.status}>{tender.status}</StatusChip>
        </div>
        <h3 className="mt-2 text-base font-medium text-foreground">{tender.title}</h3>
        <p className="mt-1 m-0 text-sm text-muted-foreground">
          Bid closes{' '}
          <span className="font-mono tabular-nums">
            {formatLocalDateTime(tender.bidClosesAtLocal)}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {tender.checklistBlocking > 0 && (
          <Badge variant="destructive">{tender.checklistBlocking} blocking</Badge>
        )}
        <Badge variant={closingBadgeTone(tender)}>{closingLabel(tender)}</Badge>
      </div>
    </a>
  );
}
