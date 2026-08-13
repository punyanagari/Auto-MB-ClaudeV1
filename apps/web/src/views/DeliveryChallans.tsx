import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChallanDetailResponse,
  Contact,
  DeliveryChallanMovement,
  DeliveryChallanRegisterEntry,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatInr, formatRate, todayIso } from '../format.js';
import { cn } from '../lib/cn.js';
import { challanHash, navigateOnClick } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

/**
 * The Delivery Challan register — the movement document's own screen.
 *
 * The Delivery Challan is what accompanies goods when they move, and it
 * covers three cases that used to have only one home:
 *
 *   LOA supply       a Work challan whose lines are all schedule items;
 *   Work material    a Work challan that also carries non-LOA lines —
 *                    poles, bolts, installation consumables;
 *   Standalone       no Work at all: factory to a private customer, a
 *                    vendor, or a job worker.
 *
 * Work challans are still created and opened on their Work's Deliveries
 * tab; this register lists them so the operator can see every movement in
 * one place, and it is the only home the other two cases have.
 *
 * The screen never says which lines count towards the quantity ledger by
 * implication: the movement column names the case outright, and the
 * standalone editor only offers manual lines because that is all a
 * standalone challan may carry.
 */

interface DeliveryChallansProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Drafting a standalone challan is an owner/office action, exactly as
   * drafting a Work challan is. */
  readonly canModify: boolean;
  /** The per-member issue authority; issuing mints the gap-free number. */
  readonly canIssue: boolean;
  /** The per-member cancel authority. */
  readonly canCancel: boolean;
  /** The register row the hash names (`#/delivery-challans/<id>`), or null
   * for the plain register. */
  readonly openChallanId: string | null;
  /** Push a hash so the opened record is linkable and the back button
   * works; the workspace shell owns the actual navigation. */
  readonly onOpenChallan: (challanId: string | null) => void;
  /** Opening a Work challan leaves this module for the Work's own screen. */
  readonly onOpenWorkChallan: (workId: string, challanId: string) => void;
}

type Filter = 'all' | DeliveryChallanMovement;

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'All movements' },
  { id: 'loa_supply', label: 'LOA supply' },
  { id: 'work_material', label: 'Work material' },
  { id: 'standalone', label: 'Standalone' },
];

const MOVEMENT_LABELS: Readonly<Record<DeliveryChallanMovement, string>> = {
  loa_supply: 'LOA supply',
  work_material: 'Work material',
  standalone: 'Standalone',
};

/** One manual line as typed. Nothing is computed here — the server answers
 * with the exact line amount in decimal arithmetic (engineering rule 5). */
interface LineDraft {
  description: string;
  unit: string;
  quantity: string;
  rate: string;
}

const EMPTY_LINE: LineDraft = { description: '', unit: '', quantity: '', rate: '' };

const PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9_/-]{0,24}$/;
// The two alternations are the repo's decimal shape (ReviewLoa,
// IssueChallanEditor): each branch is anchored and linear, where one
// pattern with an optional fraction group is a backtracking hazard on
// operator-typed text.
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$|^(?:0|[1-9]\d*)\.\d{1,3}$/;
const RATE_PATTERN = /^(?:0|[1-9]\d*)$|^(?:0|[1-9]\d*)\.\d{1,6}$/;

/** Names the field a draft line is missing, so the operator is told before
 * the round trip. The server stays authoritative — these mirror its
 * refusals (MANUAL_LINE_INCOMPLETE, QUANTITY_INVALID, RATE_INVALID). */
function lineProblem(line: LineDraft): string | null {
  if (line.description.trim().length === 0) return 'Every line needs a description.';
  if (line.unit.trim().length === 0) return 'Every line needs a unit.';
  if (!DECIMAL_PATTERN.test(line.quantity)) {
    return 'Every quantity is a number with up to three decimals.';
  }
  if (!/[1-9]/.test(line.quantity)) {
    return 'Every quantity must be greater than zero.';
  }
  if (!RATE_PATTERN.test(line.rate)) {
    return 'Every rate is a number that is not negative.';
  }
  return null;
}

export function DeliveryChallans({
  api,
  organisationId,
  canModify,
  canIssue,
  canCancel,
  openChallanId,
  onOpenChallan,
  onOpenWorkChallan,
}: DeliveryChallansProps) {
  const [challans, setChallans] = useState<
    readonly DeliveryChallanRegisterEntry[] | null
  >(null);
  const [contacts, setContacts] = useState<readonly Contact[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [detail, setDetail] = useState<ChallanDetailResponse | null>(null);

  const [challanDate, setChallanDate] = useState(todayIso);
  const [prefix, setPrefix] = useState('DC');
  const [consigneeContactId, setConsigneeContactId] = useState('');
  const [lines, setLines] = useState<readonly LineDraft[]>([{ ...EMPTY_LINE }]);

  const refreshList = useCallback(async () => {
    setChallans(await api.listDeliveryChallans(organisationId));
  }, [api, organisationId]);

  useEffect(() => {
    let cancelled = false;
    setChallans(null);
    setLoadError(null);
    Promise.all([
      api.listDeliveryChallans(organisationId),
      // The consignee picker must never block the register: a caller who
      // may read challans but not contacts still gets the list.
      api.listContacts(organisationId).catch((): readonly Contact[] => []),
    ])
      .then(([register, contactList]) => {
        if (cancelled) return;
        setChallans(register);
        setContacts(contactList.filter((contact) => contact.active));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof RequestFailedError
            ? error.message
            : 'The delivery challans could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  const act = useCallback(async (run: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
    } catch (cause: unknown) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'That action could not be completed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

  // The hash is the source of truth for which record is open, so a
  // pasted `#/delivery-challans/<id>` loads it and the back button
  // closes it. A work challan is never opened here — its screen lives on
  // its Work — so only standalone details are fetched.
  useEffect(() => {
    let cancelled = false;
    if (openChallanId === null) {
      setDetail(null);
      return;
    }
    api
      .getChallan(organisationId, openChallanId)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setActionError(
          error instanceof RequestFailedError
            ? error.message
            : 'That delivery challan could not be opened.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, openChallanId]);

  const counts = useMemo(() => {
    const list = challans ?? [];
    return {
      all: list.length,
      loa_supply: list.filter((row) => row.movement === 'loa_supply').length,
      work_material: list.filter((row) => row.movement === 'work_material').length,
      standalone: list.filter((row) => row.movement === 'standalone').length,
    };
  }, [challans]);

  const rows = useMemo(() => {
    const list = challans ?? [];
    return filter === 'all' ? list : list.filter((row) => row.movement === filter);
  }, [challans, filter]);

  const headerProblem = useMemo(() => {
    if (!PREFIX_PATTERN.test(prefix)) {
      return 'The prefix is up to 25 characters: capitals, digits, and - _ /.';
    }
    if (consigneeContactId === '') return 'Choose the consignee this movement goes to.';
    if (challanDate === '') return 'The challan needs a date.';
    return null;
  }, [prefix, consigneeContactId, challanDate]);

  const linesProblem = useMemo(() => {
    for (const line of lines) {
      const problem = lineProblem(line);
      if (problem !== null) return problem;
    }
    return null;
  }, [lines]);

  function updateLine(index: number, next: Partial<LineDraft>) {
    setLines((current) =>
      current.map((line, position) =>
        position === index ? { ...line, ...next } : line,
      ),
    );
  }

  function resetForm() {
    setChallanDate(todayIso());
    setPrefix('DC');
    setConsigneeContactId('');
    setLines([{ ...EMPTY_LINE }]);
  }

  const standaloneDetail =
    detail !== null && detail.challan.kind === 'standalone' ? detail : null;

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">
            Movement
          </p>
          <h1 id="delivery-challans-title" tabIndex={-1}>
            Delivery Challans
          </h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Every document that accompanies goods on the move: LOA supply and
            installation material against a Work, and standalone despatches to a
            customer, vendor, or job worker.
          </p>
        </div>
      </header>

      <section
        aria-labelledby="delivery-challans-title"
        className="flex flex-col gap-4"
      >
        {loadError !== null && <FormError>{loadError}</FormError>}
        {loadError === null && challans === null && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading delivery challans…
          </p>
        )}
        {actionError !== null && <FormError>{actionError}</FormError>}
        {notice !== null && (
          <p className="text-muted-foreground" role="status">
            {notice}
          </p>
        )}

        {challans !== null && challans.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 self-start rounded-lg border border-border bg-card p-1">
            {FILTERS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={filter === candidate.id}
                onClick={() => {
                  setFilter(candidate.id);
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === candidate.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {candidate.label}
                <span
                  className={cn(
                    'rounded px-1.5 text-xs tnum',
                    filter === candidate.id
                      ? 'bg-foreground/10'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {counts[candidate.id]}
                </span>
              </button>
            ))}
          </div>
        )}

        {challans !== null &&
          (rows.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
                Delivery challans with movement, consignee, Work, date, value, and
                status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Movement</th>
                  <th scope="col">Consignee</th>
                  <th scope="col">Work</th>
                  <th scope="col">Date</th>
                  <th scope="col" className={numericCell}>
                    Value
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const href =
                    row.workId !== null
                      ? challanHash(row.workId, row.id)
                      : `#/delivery-challans/${row.id}`;
                  return (
                    <tr key={row.id}>
                      <th scope="row">
                        <a
                          href={href}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={navigateOnClick(() => {
                            if (row.workId !== null) {
                              onOpenWorkChallan(row.workId, row.id);
                              return;
                            }
                            onOpenChallan(row.id);
                          })}
                        >
                          {row.challanNumber ?? 'Draft'}
                        </a>
                      </th>
                      <td>{MOVEMENT_LABELS[row.movement]}</td>
                      <td className={wrapCell}>{row.consigneeName}</td>
                      <td>{row.workCode ?? '—'}</td>
                      <td>{formatDate(row.challanDate)}</td>
                      <td className={numericCell}>{formatInr(row.totalAmount)}</td>
                      <td>
                        <StatusChip status={row.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          ) : challans.length > 0 ? (
            <p className="text-muted-foreground">No challans of this kind yet.</p>
          ) : (
            <p className="text-muted-foreground">No delivery challans yet.</p>
          ))}

        {challans !== null && canModify && (
          <Disclosure
            label="New standalone challan"
            variant="default"
            startOpen={counts.standalone === 0}
          >
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (headerProblem !== null || linesProblem !== null) return;
                void act(async () => {
                  const created = await api.createStandaloneChallan(organisationId, {
                    challanDate,
                    prefix,
                    consigneeContactId,
                    items: lines.map((line) => ({
                      description: line.description.trim(),
                      unit: line.unit.trim(),
                      quantity: line.quantity,
                      rate: line.rate,
                    })),
                  });
                  resetForm();
                  await refreshList();
                  onOpenChallan(created.challan.id);
                }, 'Standalone challan drafted.');
              }}
            >
              <Hint>
                A standalone challan belongs to no Work: it records goods leaving the
                premises for a customer, a vendor, or a job worker. Its lines are
                entered by hand and never touch a Work&rsquo;s quantity ledger.
              </Hint>
              <FieldRow>
                <Field>
                  <label htmlFor="standalone-consignee">Consignee</label>
                  <select
                    id="standalone-consignee"
                    value={consigneeContactId}
                    onChange={(event) => {
                      setConsigneeContactId(event.target.value);
                    }}
                  >
                    <option value="">Choose a contact…</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.designation}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <label htmlFor="standalone-date">Challan date</label>
                  <input
                    id="standalone-date"
                    type="date"
                    value={challanDate}
                    onChange={(event) => {
                      setChallanDate(event.target.value);
                    }}
                  />
                </Field>
                <Field>
                  <label htmlFor="standalone-prefix">Prefix</label>
                  <input
                    id="standalone-prefix"
                    value={prefix}
                    onChange={(event) => {
                      setPrefix(event.target.value.toUpperCase());
                    }}
                  />
                </Field>
              </FieldRow>

              <DataTable>
                <caption className="sr-only">Lines on this standalone challan</caption>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Rate</th>
                    <th scope="col">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    // The index is the identity here: these rows have no id
                    // until the server has them, and reordering is not offered.
                    <tr key={index}>
                      <td>
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-description`}
                        >
                          Line {index + 1} description
                        </label>
                        <input
                          id={`standalone-line-${String(index)}-description`}
                          value={line.description}
                          onChange={(event) => {
                            updateLine(index, { description: event.target.value });
                          }}
                        />
                      </td>
                      <td>
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-unit`}
                        >
                          Line {index + 1} unit
                        </label>
                        <input
                          id={`standalone-line-${String(index)}-unit`}
                          value={line.unit}
                          onChange={(event) => {
                            updateLine(index, { unit: event.target.value });
                          }}
                        />
                      </td>
                      <td>
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-quantity`}
                        >
                          Line {index + 1} quantity
                        </label>
                        <input
                          id={`standalone-line-${String(index)}-quantity`}
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => {
                            updateLine(index, { quantity: event.target.value });
                          }}
                        />
                      </td>
                      <td>
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-rate`}
                        >
                          Line {index + 1} rate
                        </label>
                        <input
                          id={`standalone-line-${String(index)}-rate`}
                          inputMode="decimal"
                          value={line.rate}
                          onChange={(event) => {
                            updateLine(index, { rate: event.target.value });
                          }}
                        />
                      </td>
                      <td>
                        {lines.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="inline"
                            onClick={() => {
                              setLines((current) =>
                                current.filter((_, position) => position !== index),
                              );
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>

              <Actions>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setLines((current) => [...current, { ...EMPTY_LINE }]);
                  }}
                >
                  Add line
                </Button>
                <Button
                  type="submit"
                  disabled={pending || headerProblem !== null || linesProblem !== null}
                >
                  Create standalone challan
                </Button>
              </Actions>
              {headerProblem !== null && <FormError>{headerProblem}</FormError>}
              {headerProblem === null && linesProblem !== null && (
                <FormError>{linesProblem}</FormError>
              )}
            </form>
          </Disclosure>
        )}

        {standaloneDetail !== null && (
          <section
            aria-labelledby="standalone-detail-title"
            className="rounded-xl border border-border bg-card p-5"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="standalone-detail-title" tabIndex={-1}>
                {standaloneDetail.challan.challanNumber ?? 'Draft standalone challan'}
              </h2>
              <StatusChip status={standaloneDetail.challan.status} />
            </header>
            <p className="mt-1 text-sm text-muted-foreground">
              {standaloneDetail.challan.consignee.name} ·{' '}
              {formatDate(standaloneDetail.challan.challanDate)}
              {standaloneDetail.challan.fyLabel !== null &&
                ` · FY ${standaloneDetail.challan.fyLabel}`}
            </p>

            <DataTable className="mt-4">
              <caption className="sr-only">
                Lines on this standalone delivery challan
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className={numericCell}>
                    Quantity
                  </th>
                  <th scope="col" className={numericCell}>
                    Rate
                  </th>
                  <th scope="col" className={numericCell}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {standaloneDetail.items.map((item) => (
                  <tr key={item.id}>
                    <td className={numericCell}>{item.position}</td>
                    <td className={wrapCell}>{item.description}</td>
                    <td>{item.unit}</td>
                    <td className={numericCell}>{item.quantity}</td>
                    <td className={numericCell}>{formatRate(item.rate)}</td>
                    <td className={numericCell}>{formatInr(item.lineAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            <Actions>
              {standaloneDetail.challan.status === 'draft' && canIssue && (
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    void act(async () => {
                      const issued = await api.issueChallan(
                        organisationId,
                        standaloneDetail.challan.id,
                      );
                      setDetail(issued);
                      await refreshList();
                    }, 'Standalone challan issued.');
                  }}
                >
                  Issue challan
                </Button>
              )}
              {standaloneDetail.challan.status === 'draft' && canModify && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    void act(async () => {
                      await api.deleteChallan(
                        organisationId,
                        standaloneDetail.challan.id,
                      );
                      onOpenChallan(null);
                      await refreshList();
                    }, 'Draft deleted.');
                  }}
                >
                  Delete draft
                </Button>
              )}
              {standaloneDetail.challan.status === 'issued' && canCancel && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    const note = window.prompt(
                      'Why is this challan being cancelled? The reason stays on the record.',
                    );
                    if (note === null) return;
                    void act(async () => {
                      const cancelled = await api.cancelChallan(
                        organisationId,
                        standaloneDetail.challan.id,
                        { note },
                      );
                      setDetail(cancelled);
                      await refreshList();
                    }, 'Standalone challan cancelled.');
                  }}
                >
                  Cancel challan
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onOpenChallan(null);
                }}
              >
                Close
              </Button>
            </Actions>
          </section>
        )}
      </section>
    </>
  );
}
