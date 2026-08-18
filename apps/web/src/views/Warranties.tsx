import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Warranty, WarrantyStanding } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { warrantyCountdown } from '../lib/warranty.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { Field } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { WorkLink } from '../ui/work-link.js';

/**
 * The warranty register — every defect liability period, across Works,
 * soonest expiry first.
 *
 * The Work's own Instruments tab answers "what is this contract still on
 * the hook for". It cannot answer the question an office actually asks
 * once a month, which crosses contracts: what comes out of warranty this
 * quarter, and which bank guarantees can therefore be asked back. That
 * question is an ORDER and a horizon, which is why the register is sorted
 * by expiry and filtered by one.
 *
 * Reading only. Starting, extending, discharging and voiding a period all
 * stay on the Work, because each of them is decided against that Work's
 * contract term and its installations — an act with no Work in front of it
 * would be a form that has to ask which Work first, which is the Work
 * page. Every row links to its Work's Instruments tab, where the period is
 * read in full and acted on.
 *
 * Two readings, one screen (the mock's `?work=` deep link,
 * `components/document-register` at fdfd610):
 *
 * - **Across Works** — the register endpoint, paged, narrowed by a
 *   standing and an expiry horizon.
 * - **One Work** — the Work's own warranty read, named by a dismissible
 *   chip whose clear control returns to the register. The filters are not
 *   offered there: they exist to bound a cross-Work list, and one Work's
 *   periods are already bounded by the Work.
 */

/** One request's worth of rows. Large enough that a quarter's worth of
 * expiries arrives whole, small enough to be a bounded read. */
const PAGE_SIZE = 100;

/** The filter's vocabulary, in the order an office works through it. The
 * words are the chip's own, so the filter and the column agree. */
const STANDING_OPTIONS: readonly { value: WarrantyStanding; label: string }[] = [
  { value: 'elapsed', label: 'Elapsed — ready to discharge' },
  { value: 'expiring', label: 'Expiring soon' },
  { value: 'active', label: 'Running' },
  { value: 'closed', label: 'Discharged' },
  { value: 'voided', label: 'Voided' },
];

interface WarrantiesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `?work=` deep link. Null reads across every Work in reach. */
  readonly workId: string | null;
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenWorks: () => void;
  /** The filter chip's clear control: back to the unfiltered register. */
  readonly onClearWorkFilter: () => void;
}

interface WorkFilter {
  readonly workCode: string;
  readonly workTitle: string;
}

interface RegisterFilter {
  readonly standing: string;
  readonly expiresBefore: string;
}

export function Warranties({
  api,
  organisationId,
  workId,
  onOpenWork,
  onOpenWorks,
  onClearWorkFilter,
}: WarrantiesProps) {
  const [warranties, setWarranties] = useState<readonly Warranty[] | null>(null);
  const [workFilter, setWorkFilter] = useState<WorkFilter | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /* What the operator has actually asked for, as opposed to what they are
     still typing: the controls are uncontrolled and applied on submit, so
     a half-typed year never fires a request. */
  const [filter, setFilter] = useState<RegisterFilter>({
    standing: '',
    expiresBefore: '',
  });
  const [loadVersion, retry] = useReload();

  const fetchPage = useCallback(
    (cursor?: string) =>
      api.listWarranties(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(filter.standing !== ''
          ? { standing: filter.standing as WarrantyStanding }
          : {}),
        ...(filter.expiresBefore !== '' ? { expiresBefore: filter.expiresBefore } : {}),
      }),
    [api, organisationId, filter],
  );

  useEffect(() => {
    let cancelled = false;
    setWarranties(null);
    setWorkFilter(null);
    setNextCursor(null);
    setLoadError(null);

    if (workId === null) {
      fetchPage()
        .then((page) => {
          if (cancelled) return;
          setWarranties(page.warranties);
          setNextCursor(page.nextCursor);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setLoadError(
            errorMessage(cause, 'The defect liability periods could not be loaded.'),
          );
        });
      return () => {
        cancelled = true;
      };
    }

    /* One failure state, because these are not independent reads: a chip
       with no Work to name and rows with no chip over them are each half
       of the narrowed reading, and neither is worth rendering alone. */
    Promise.all([
      api.getWork(organisationId, workId),
      api.getWorkWarranty(organisationId, workId, { limit: PAGE_SIZE }),
    ])
      .then(([detail, page]) => {
        if (cancelled) return;
        setWorkFilter({ workCode: detail.work.workCode, workTitle: detail.work.title });
        setWarranties(page.warranties);
        setNextCursor(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(
            cause,
            'This Work’s defect liability periods could not be loaded.',
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, fetchPage, loadVersion]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    setPending(true);
    setLoadError(null);
    try {
      const page = await fetchPage(nextCursor);
      setWarranties((current) => [...(current ?? []), ...page.warranties]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(
        errorMessage(
          cause,
          'The next page of defect liability periods could not be loaded.',
        ),
      );
    } finally {
      setPending(false);
    }
  }

  const narrowed = workId !== null;
  const filtered = filter.standing !== '' || filter.expiresBefore !== '';

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        titleId="warranties-title"
        title="Warranties"
        description="Every defect liability period across the Works you can reach, soonest expiry first. A period is started, extended and discharged on its Work, which is what holds the contract term it runs under."
      />

      <section aria-labelledby="warranties-title" className="flex flex-col gap-4">
        {narrowed && workFilter !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filtered to</span>
            <span className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 py-0.5 pr-1 pl-2 text-[13px] text-primary">
              <span className="font-mono font-semibold">{workFilter.workCode}</span>
              <span className="max-w-64 truncate text-primary/80">
                {workFilter.workTitle}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onClearWorkFilter}
                aria-label={`Clear the ${workFilter.workCode} filter and read the whole register`}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        )}

        {!narrowed && (
          <form
            className="flex flex-wrap items-end gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setFilter({
                standing: formValue(data, 'warranty-standing'),
                expiresBefore: formValue(data, 'warranty-expires-before'),
              });
            }}
          >
            <Field className="my-0">
              <label htmlFor="warranty-standing">Standing</label>
              <select id="warranty-standing" name="warranty-standing">
                <option value="">Every period</option>
                {STANDING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <DateField
              id="warranty-expires-before"
              name="warranty-expires-before"
              label="Runs out on or before"
              fieldClassName="my-0"
            />
            <Button type="submit" variant="outline">
              Apply filters
            </Button>
          </form>
        )}

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry warranties">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && warranties === null && (
          <LoadingState label="the defect liability periods" rows={5} columns={5} />
        )}

        {warranties !== null &&
          (warranties.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Defect liability periods with Work, item, quantity, the dates they run
                  between, their standing and the time left
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Work</th>
                    <th scope="col">Item</th>
                    <th scope="col" className={numericCell}>
                      Quantity
                    </th>
                    <th scope="col">Starts</th>
                    <th scope="col">Runs to</th>
                    <th scope="col">Standing</th>
                    <th scope="col">Countdown</th>
                    <th scope="col">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {warranties.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <WorkLink
                          workId={row.workId}
                          workCode={row.workCode}
                          workTitle={row.workTitle}
                          tab="instruments"
                          onOpenWork={onOpenWork}
                        />
                      </th>
                      <td>{row.itemNumber}</td>
                      <td className={numericCell}>{row.quantity}</td>
                      {/* Left-aligned, as the installation register's date
                          column is: the two registers read the same records
                          from different ends, and a date that changes side
                          between them reads as a different kind of column. */}
                      <td>{formatDate(row.dlpStartOn)}</td>
                      <td>{formatDate(row.dlpExpiresOn)}</td>
                      <td>
                        <StatusChip status={row.standing} />
                      </td>
                      <td>{warrantyCountdown(row.daysToExpiry)}</td>
                      <td className={wrapCell}>{row.locationName}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {nextCursor !== null && (
                <div>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void loadMore()}
                  >
                    Load more periods
                  </Button>
                </div>
              )}
            </>
          ) : narrowed ? (
            <EmptyState
              action={{
                label: 'Read the whole register',
                onClick: onClearWorkFilter,
              }}
            >
              No defect liability period has been started against this Work. Periods
              start on the Work&rsquo;s own Instruments tab.
            </EmptyState>
          ) : filtered ? (
            <EmptyState>
              No period matches these filters. Widen the horizon, or clear both to read
              the whole register.
            </EmptyState>
          ) : (
            <EmptyState action={{ label: 'Open Works', onClick: onOpenWorks }}>
              No defect liability period has been started yet. A period runs on a
              recorded installation and is started on that installation&rsquo;s Work,
              under the warranty term its contract states.
            </EmptyState>
          ))}
      </section>
    </>
  );
}
