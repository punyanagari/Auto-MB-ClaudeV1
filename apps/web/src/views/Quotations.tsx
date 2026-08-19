import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BudgetaryQuotation,
  BudgetaryQuotationDetailResponse,
  BudgetaryQuotationLineInput,
  Contact,
  CreateBudgetaryQuotationRequest,
  GstRateMaster,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate, formatInr, formatRate, todayIso } from '../format.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, Hint } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';

interface QuotationsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Draft lifecycle (create, edit, delete) and recording that an issued
   * offer lapsed or won run under owner/office. */
  readonly canModify: boolean;
  /** Issuing assigns the next gapless BQ number — the per-member issue
   * authority, exactly as on the challans. */
  readonly canIssue: boolean;
  /** Withdrawing an issued offer is the contractor taking back a document
   * that left the building, so the server puts it under the cancel
   * authority; this only decides what to offer. */
  readonly canCancel: boolean;
}

type Filter = 'all' | BudgetaryQuotation['status'];

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'All quotations' },
  { id: 'draft', label: 'Draft' },
  { id: 'issued', label: 'Issued' },
  { id: 'converted', label: 'Converted' },
  { id: 'expired', label: 'Expired' },
  { id: 'withdrawn', label: 'Withdrawn' },
];

/** The header fields a draft carries; the same body serves create and the
 * draft PUT (contracts: CreateBudgetaryQuotationRequest). */
interface HeaderState {
  /** '' when the offer is addressed to someone who is not (yet) a contact. */
  customerContactId: string;
  addressedTo: string;
  subject: string;
  bqDate: string;
  validUntil: string;
  notes: string;
}

/** One editable line, everything as typed. Money is never computed here —
 * the server answers each save with exact line amounts and the preview
 * total (engineering rule 5). */
interface LineDraft {
  /** Stable React key: line numbers renumber on remove, keys must not. */
  readonly key: number;
  description: string;
  hsnCode: string;
  unitCode: string;
  quantity: string;
  rate: string;
  gstRate: string;
}

const EMPTY_HEADER: HeaderState = {
  customerContactId: '',
  addressedTo: '',
  subject: '',
  bqDate: '',
  validUntil: '',
  notes: '',
};

/** An untouched create form, dated today.
 *
 * A function rather than a constant with the date baked in: the module is
 * evaluated once when its chunk loads, and a quotation screen left open
 * across midnight would otherwise keep offering yesterday. `validUntil`
 * stays empty — it is a deadline the operator decides, not an event that
 * has happened. */
function freshHeader(): HeaderState {
  return { ...EMPTY_HEADER, bqDate: todayIso() };
}

/** Legal dates are date-only text and stay that way (engineering rule 6):
 * shape-checked without ever constructing a Date. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** HsnCodeSchema: HSN (goods) or SAC (services), 6 to 8 digits. */
const HSN_PATTERN = /^[0-9]{6,8}$/;

/** The plain decimal shape the contract's decimal strings share: digits,
 * an optional dot carrying one to `maxFraction` digits, no sign, and no
 * leading zero on a multi-digit whole part. Checked by splitting on the
 * dot rather than by mirroring the contract regexes — their bounded
 * repetitions trip the lint's ReDoS heuristic — and the server stays
 * authoritative for the real check. */
function isPlainDecimal(text: string, maxWhole: number, maxFraction: number): boolean {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (whole.length === 0 || whole.length > maxWhole) return false;
  if (dot !== -1 && (fraction.length === 0 || fraction.length > maxFraction)) {
    return false;
  }
  for (const character of whole + fraction) {
    if (character < '0' || character > '9') return false;
  }
  return !(whole.length > 1 && whole.startsWith('0'));
}

/** PositiveDecimalStringSchema: numeric(18,3), strictly positive. */
function isQuantity(text: string): boolean {
  return isPlainDecimal(text, 15, 3) && /[1-9]/.test(text);
}

/** NonNegativeRateStringSchema: numeric(18,6) — a nil-rate line is real. */
function isRate(text: string): boolean {
  return isPlainDecimal(text, 12, 6);
}

/** GstRateSchema: 0 to 100 inclusive, up to two fraction digits. The
 * float comparison is guidance only, and exact at this size anyway. */
function isGstRate(text: string): boolean {
  return isPlainDecimal(text, 3, 2) && Number(text) <= 100;
}

let lineKeyCounter = 0;
function newLine(): LineDraft {
  lineKeyCounter += 1;
  return {
    key: lineKeyCounter,
    description: '',
    hsnCode: '',
    unitCode: '',
    quantity: '',
    rate: '',
    gstRate: '',
  };
}

/** Every rule here mirrors one the server already enforces; checking first
 * only lets the answer name the field to fix. The server stays
 * authoritative. */
function headerProblem(state: HeaderState): string | null {
  if (state.addressedTo.trim().length < 2) {
    return 'Name who the quotation is addressed to, in at least 2 characters.';
  }
  if (state.subject.trim().length < 3) {
    return 'Enter a subject, in at least 3 characters.';
  }
  if (!DATE_ONLY_PATTERN.test(state.bqDate)) {
    return 'Enter the quotation date.';
  }
  // ISO dates compare correctly as strings — no timezone round-trip.
  if (state.validUntil !== '' && state.validUntil < state.bqDate) {
    return 'The offer cannot expire before it is dated — move the validity date on or after the quotation date.';
  }
  const notes = state.notes.trim();
  if (notes.length > 0 && notes.length < 3) {
    return 'Notes need at least 3 characters, or leave the field empty.';
  }
  return null;
}

function lineProblem(line: LineDraft, lineNumber: number): string | null {
  if (line.description.trim().length < 3) {
    return `Line ${String(lineNumber)}: describe the item in at least 3 characters.`;
  }
  if (line.unitCode.trim().length === 0 || line.unitCode.length > 20) {
    return `Line ${String(lineNumber)}: enter a unit code of up to 20 characters.`;
  }
  if (!isQuantity(line.quantity.trim())) {
    return `Line ${String(lineNumber)}: enter a quantity greater than zero, with up to three decimals.`;
  }
  if (!isRate(line.rate.trim())) {
    return `Line ${String(lineNumber)}: enter a rate of zero or more, with up to six decimals.`;
  }
  const hsn = line.hsnCode.trim();
  if (hsn.length > 0 && !HSN_PATTERN.test(hsn)) {
    return `Line ${String(lineNumber)}: an HSN/SAC code is 6 to 8 digits, or leave it empty.`;
  }
  const gst = line.gstRate.trim();
  if (gst.length > 0 && !isGstRate(gst)) {
    return `Line ${String(lineNumber)}: enter a GST rate between 0 and 100 with up to two decimals, or leave it empty.`;
  }
  return null;
}

function headerBody(state: HeaderState): CreateBudgetaryQuotationRequest {
  const notes = state.notes.trim();
  return {
    ...(state.customerContactId !== ''
      ? { customerContactId: state.customerContactId }
      : {}),
    addressedTo: state.addressedTo.trim(),
    subject: state.subject.trim(),
    bqDate: state.bqDate,
    ...(state.validUntil !== '' ? { validUntil: state.validUntil } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function linesBody(lines: readonly LineDraft[]): BudgetaryQuotationLineInput[] {
  return lines.map((line) => {
    const hsn = line.hsnCode.trim();
    const gst = line.gstRate.trim();
    return {
      description: line.description.trim(),
      ...(hsn.length > 0 ? { hsnCode: hsn } : {}),
      unitCode: line.unitCode.trim(),
      quantity: line.quantity.trim(),
      rate: line.rate.trim(),
      ...(gst.length > 0 ? { gstRate: gst } : {}),
    };
  });
}

/** The shared header fields, used by the create form and the draft's
 * editor: a client-contact picker that PREFILLS the free-text addressee —
 * a quotation is often the first thing sent to a stranger, so the text
 * stands on its own and the contact link is optional. */
function HeaderFields({
  idPrefix,
  clients,
  state,
  onChange,
}: {
  readonly idPrefix: string;
  readonly clients: readonly Contact[];
  readonly state: HeaderState;
  readonly onChange: (next: HeaderState) => void;
}) {
  return (
    <>
      {clients.length > 0 && (
        <Field>
          <label htmlFor={`${idPrefix}-contact`}>Client contact (optional)</label>
          <select
            id={`${idPrefix}-contact`}
            value={state.customerContactId}
            onChange={(event) => {
              const chosen = clients.find(
                (candidate) => candidate.id === event.target.value,
              );
              onChange({
                ...state,
                customerContactId: event.target.value,
                // Picking prefills the addressee; clearing keeps the text —
                // the free-text copy is the record either way.
                ...(chosen !== undefined ? { addressedTo: chosen.designation } : {}),
              });
            }}
          >
            <option value="">Free-text addressee</option>
            {clients.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.designation}
                {candidate.gstin !== null ? ` — ${candidate.gstin}` : ''}
              </option>
            ))}
          </select>
          <Hint>
            Picking a client links and prefills the addressee below; the text stays
            editable, and a stranger can be quoted with no contact at all.
          </Hint>
        </Field>
      )}
      <Field>
        <label htmlFor={`${idPrefix}-addressed-to`}>Addressed to</label>
        <input
          id={`${idPrefix}-addressed-to`}
          value={state.addressedTo}
          onChange={(event) => {
            onChange({ ...state, addressedTo: event.target.value });
          }}
          required
          minLength={2}
          maxLength={200}
        />
      </Field>
      <Field>
        <label htmlFor={`${idPrefix}-subject`}>Subject</label>
        <input
          id={`${idPrefix}-subject`}
          value={state.subject}
          onChange={(event) => {
            onChange({ ...state, subject: event.target.value });
          }}
          required
          minLength={3}
          maxLength={500}
        />
      </Field>
      <FieldRow>
        <Field>
          <label htmlFor={`${idPrefix}-date`}>Quotation date</label>
          <input
            id={`${idPrefix}-date`}
            type="date"
            value={state.bqDate}
            onChange={(event) => {
              onChange({ ...state, bqDate: event.target.value });
            }}
            required
          />
        </Field>
        <Field>
          <label htmlFor={`${idPrefix}-valid-until`}>Valid until (optional)</label>
          <input
            id={`${idPrefix}-valid-until`}
            type="date"
            value={state.validUntil}
            onChange={(event) => {
              onChange({ ...state, validUntil: event.target.value });
            }}
          />
        </Field>
      </FieldRow>
      <Field>
        <label htmlFor={`${idPrefix}-notes`}>Notes (optional)</label>
        <textarea
          id={`${idPrefix}-notes`}
          rows={2}
          value={state.notes}
          onChange={(event) => {
            onChange({ ...state, notes: event.target.value });
          }}
          maxLength={4000}
        />
      </Field>
    </>
  );
}

/**
 * Budgetary Quotations (migration 0033; legacy spec §5.8): priced offers
 * made OUTWARD — to a private customer, or to a railway officer assembling
 * a tender's item list — so they carry no Work. Draft freely; issuing
 * assigns the next gapless BQ number per organisation and freezes the
 * total; an issued offer then converts, expires, or is withdrawn, and
 * keeps its number forever.
 */
export function Quotations({
  api,
  organisationId,
  canModify,
  canIssue,
  canCancel,
}: QuotationsProps) {
  const [quotations, setQuotations] = useState<readonly BudgetaryQuotation[] | null>(
    null,
  );
  const [clients, setClients] = useState<readonly Contact[]>([]);
  const [gstRates, setGstRates] = useState<readonly GstRateMaster[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<BudgetaryQuotationDetailResponse | null>(null);
  const [createState, setCreateState] = useState<HeaderState>(freshHeader);
  const [headerState, setHeaderState] = useState<HeaderState>(EMPTY_HEADER);
  const [lines, setLines] = useState<readonly LineDraft[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, notice, actionError, act, setNotice, setActionError } = useAction();
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setQuotations(null);
    setDetail(null);
    setLoadError(null);
    Promise.all([
      api.listBudgetaryQuotations(organisationId),
      // The pickers are conveniences: an unavailable master list must not
      // block free-text quoting, and the rate picker degrades to a plain
      // input (the server refuses off-master rates either way).
      api.listContacts(organisationId).catch((): readonly Contact[] => []),
      api.listGstRates(organisationId).catch((): readonly GstRateMaster[] => []),
    ])
      .then(([loadedQuotations, contacts, rates]) => {
        if (cancelled) return;
        setQuotations(loadedQuotations);
        setClients(
          contacts.filter((candidate) => candidate.isClient && candidate.active),
        );
        setGstRates(rates);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The quotations could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const refreshList = useCallback(async () => {
    setQuotations(await api.listBudgetaryQuotations(organisationId));
  }, [api, organisationId]);

  /** Loads a quotation into the panel below the list, priming the editor
   * state when it is still a draft. */
  const openQuotation = useCallback(
    async (quotationId: string) => {
      const loaded = await api.getBudgetaryQuotation(organisationId, quotationId);
      setDetail(loaded);
      setConfirmingDelete(false);
      setConfirmingWithdraw(false);
      const quotation = loaded.budgetaryQuotation;
      setHeaderState({
        customerContactId: quotation.customerContactId ?? '',
        addressedTo: quotation.addressedTo,
        subject: quotation.subject,
        bqDate: quotation.bqDate,
        validUntil: quotation.validUntil ?? '',
        notes: quotation.notes ?? '',
      });
      setLines(
        loaded.lines.length > 0
          ? loaded.lines.map((line) => ({
              ...newLine(),
              description: line.description,
              hsnCode: line.hsnCode ?? '',
              unitCode: line.unitCode,
              quantity: line.quantity,
              rate: line.rate,
              gstRate: line.gstRate ?? '',
            }))
          : [newLine()],
      );
    },
    [api, organisationId],
  );

  const counts = useMemo(() => {
    const list = quotations ?? [];
    return {
      all: list.length,
      draft: list.filter((row) => row.status === 'draft').length,
      issued: list.filter((row) => row.status === 'issued').length,
      converted: list.filter((row) => row.status === 'converted').length,
      expired: list.filter((row) => row.status === 'expired').length,
      withdrawn: list.filter((row) => row.status === 'withdrawn').length,
    };
  }, [quotations]);

  const rows = useMemo(() => {
    const list = quotations ?? [];
    return filter === 'all' ? list : list.filter((row) => row.status === filter);
  }, [quotations, filter]);

  const quotation = detail?.budgetaryQuotation ?? null;
  const numberLabel = quotation?.bqNumber ?? 'this draft';

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">
            Outward offers
          </p>
          <h1 id="quotations-title" tabIndex={-1}>
            Quotations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Budgetary quotations to customers and tender-assembling officers — no Work
            attached, numbered BQ-NN when issued.
          </p>
        </div>
      </header>

      <section aria-labelledby="quotations-title" className="flex flex-col gap-4">
        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry quotations">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && quotations === null && (
          <LoadingState label="the quotations" rows={5} columns={4} />
        )}
        {actionError !== null && <FormError>{actionError}</FormError>}
        {notice !== null && (
          <p className="text-muted-foreground" role="status">
            {notice}
          </p>
        )}

        {quotations !== null && quotations.length > 0 && (
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

        {quotations !== null &&
          (rows.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
                Budgetary quotations with addressee, dates, value, and status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Addressed to</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Date</th>
                  <th scope="col">Valid until</th>
                  <th scope="col" className={numericCell}>
                    Total
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <Button
                        variant="link"
                        size="inline"
                        className="font-medium"
                        onClick={() => {
                          void act(
                            async () => {
                              await openQuotation(row.id);
                            },
                            `Quotation ${row.bqNumber ?? 'draft'} opened below.`,
                          );
                        }}
                      >
                        {row.bqNumber ?? 'Draft'}
                      </Button>
                    </th>
                    <td className={wrapCell}>{row.addressedTo}</td>
                    <td className={wrapCell}>{row.subject}</td>
                    <td>{row.bqDate}</td>
                    <td>{row.validUntil ?? '—'}</td>
                    <td className={numericCell}>
                      {row.totalAmount !== null ? formatInr(row.totalAmount) : '—'}
                    </td>
                    <td>
                      <StatusChip status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : quotations.length > 0 ? (
            <EmptyState
              action={{
                label: 'Show all quotations',
                onClick: () => {
                  setFilter('all');
                },
              }}
            >
              No quotations with this status yet.
            </EmptyState>
          ) : (
            <EmptyState>
              No quotations yet. A budgetary quotation is raised below and numbered only
              when it is issued.
            </EmptyState>
          ))}

        {/* The register's primary action, and distinct from the submit
            inside it: the opener names what will exist ("New quotation"),
            the submit commits it ("Create quotation"). They used to carry
            the same words, so on an empty register — where the panel is
            already open — pressing the header looked inert. */}
        {quotations !== null && canModify && (
          <Disclosure
            label="New quotation"
            variant="default"
            startOpen={quotations.length === 0}
          >
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const problem = headerProblem(createState);
                if (problem !== null) {
                  setNotice(null);
                  setActionError(problem);
                  return;
                }
                void act(async () => {
                  const created = await api.createBudgetaryQuotation(
                    organisationId,
                    headerBody(createState),
                  );
                  await refreshList();
                  await openQuotation(created.budgetaryQuotation.id);
                  setCreateState(freshHeader());
                }, 'Draft quotation created — price its lines below.');
              }}
            >
              <HeaderFields
                idPrefix="bq-create"
                clients={clients}
                state={createState}
                onChange={setCreateState}
              />
              <Actions>
                <Button type="submit" disabled={pending}>
                  Create quotation
                </Button>
              </Actions>
            </form>
          </Disclosure>
        )}

        {detail !== null && quotation !== null && (
          <div className="my-3">
            <h2>
              Quotation {quotation.bqNumber ?? 'draft'} · {quotation.bqDate}{' '}
              <StatusChip status={quotation.status} />
            </h2>

            {quotation.status === 'draft' && canModify ? (
              /* The draft's editor, deliberately not behind a Disclosure:
                 the operator reached it by asking for the draft by name,
                 and it disappears the moment the offer is issued into a
                 record worth reading. */
              <>
                <form
                  noValidate
                  aria-label="Quotation details"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const problem = headerProblem(headerState);
                    if (problem !== null) {
                      setNotice(null);
                      setActionError(problem);
                      return;
                    }
                    void act(async () => {
                      setDetail(
                        await api.updateBudgetaryQuotation(
                          organisationId,
                          quotation.id,
                          headerBody(headerState),
                        ),
                      );
                      await refreshList();
                    }, 'Quotation details saved.');
                  }}
                >
                  <HeaderFields
                    idPrefix="bq-edit"
                    clients={clients}
                    state={headerState}
                    onChange={setHeaderState}
                  />
                  <Actions>
                    <Button type="submit" disabled={pending}>
                      Save details
                    </Button>
                  </Actions>
                </form>

                <h3>Lines</h3>
                <form
                  noValidate
                  aria-label="Quotation lines"
                  onSubmit={(event) => {
                    event.preventDefault();
                    for (const [index, line] of lines.entries()) {
                      const problem = lineProblem(line, index + 1);
                      if (problem !== null) {
                        setNotice(null);
                        setActionError(problem);
                        return;
                      }
                    }
                    void act(async () => {
                      setDetail(
                        await api.saveBudgetaryQuotationLines(
                          organisationId,
                          quotation.id,
                          { lines: linesBody(lines) },
                        ),
                      );
                    }, 'Lines saved; the total below recomputed.');
                  }}
                >
                  <DataTable scroll className="[&_input]:w-24 [&_input]:min-w-0">
                    <caption className="sr-only">
                      Editable quotation lines: description, HSN/SAC, unit, quantity,
                      rate, and GST rate
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Description</th>
                        <th scope="col">HSN/SAC</th>
                        <th scope="col">Unit</th>
                        <th scope="col">Quantity</th>
                        <th scope="col">Rate (₹)</th>
                        <th scope="col">GST %</th>
                        <th scope="col">
                          <span className="sr-only">Remove</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, index) => {
                        const lineNumber = index + 1;
                        const set = (patch: Partial<LineDraft>) => {
                          setLines((current) =>
                            current.map((candidate) =>
                              candidate.key === line.key
                                ? { ...candidate, ...patch }
                                : candidate,
                            ),
                          );
                        };
                        return (
                          <tr key={line.key}>
                            <th scope="row">{lineNumber}</th>
                            <td>
                              <input
                                aria-label={`Line ${String(lineNumber)} description`}
                                className="w-56!"
                                value={line.description}
                                onChange={(event) => {
                                  set({ description: event.target.value });
                                }}
                                required
                                minLength={3}
                                maxLength={1000}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`Line ${String(lineNumber)} HSN or SAC code (optional)`}
                                inputMode="numeric"
                                value={line.hsnCode}
                                onChange={(event) => {
                                  set({ hsnCode: event.target.value });
                                }}
                                maxLength={8}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`Line ${String(lineNumber)} unit`}
                                value={line.unitCode}
                                onChange={(event) => {
                                  set({ unitCode: event.target.value });
                                }}
                                required
                                maxLength={20}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`Line ${String(lineNumber)} quantity`}
                                inputMode="decimal"
                                value={line.quantity}
                                onChange={(event) => {
                                  set({ quantity: event.target.value });
                                }}
                                required
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`Line ${String(lineNumber)} rate`}
                                inputMode="decimal"
                                value={line.rate}
                                onChange={(event) => {
                                  set({ rate: event.target.value });
                                }}
                                required
                              />
                            </td>
                            <td>
                              {gstRates.length > 0 ? (
                                <select
                                  aria-label={`Line ${String(lineNumber)} GST rate (optional)`}
                                  value={line.gstRate}
                                  onChange={(event) => {
                                    set({ gstRate: event.target.value });
                                  }}
                                >
                                  <option value="">No GST rate</option>
                                  {gstRates.map((row) => (
                                    <option key={row.id} value={row.rate}>
                                      {row.rate}%
                                      {row.effectiveTo === null
                                        ? ''
                                        : ` (until ${formatDate(row.effectiveTo)})`}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  aria-label={`Line ${String(lineNumber)} GST rate (optional)`}
                                  inputMode="decimal"
                                  value={line.gstRate}
                                  onChange={(event) => {
                                    set({ gstRate: event.target.value });
                                  }}
                                />
                              )}
                            </td>
                            <td>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={lines.length === 1}
                                onClick={() => {
                                  setLines((current) =>
                                    current.filter(
                                      (candidate) => candidate.key !== line.key,
                                    ),
                                  );
                                }}
                              >
                                Remove line {lineNumber}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={5}>
                          Preview total
                        </th>
                        <td className={numericCell}>
                          <strong>{formatInr(detail.previewTotal)}</strong>
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </DataTable>
                  <Hint>
                    HSN/SAC and GST rate are optional. Amounts and the total are
                    computed server-side when the lines are saved; issuing freezes them.
                  </Hint>
                  <Actions>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setLines((current) => [...current, newLine()]);
                      }}
                    >
                      Add line
                    </Button>
                    <Button type="submit" disabled={pending}>
                      Save lines
                    </Button>
                  </Actions>
                </form>

                <Actions>
                  {canIssue && (
                    <Button
                      disabled={pending}
                      onClick={() => {
                        void act(async () => {
                          const issued = await api.issueBudgetaryQuotation(
                            organisationId,
                            quotation.id,
                          );
                          setDetail(issued);
                          await refreshList();
                        }, 'Quotation issued — its number and total are now frozen.');
                      }}
                    >
                      Issue quotation
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={pending}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setConfirmingDelete(true);
                    }}
                  >
                    Delete draft…
                  </Button>
                </Actions>
                {confirmingDelete && (
                  <ConfirmDialog
                    title="Confirm delete"
                    description="Deleting discards this draft and its lines for good. Only drafts can be deleted — an issued quotation keeps its number forever. Continue?"
                    cancelLabel="Keep drafting"
                    confirmLabel="Delete draft now"
                    pending={pending}
                    onCancel={() => {
                      setConfirmingDelete(false);
                    }}
                    onConfirm={() => {
                      void act(async () => {
                        await api.deleteBudgetaryQuotation(
                          organisationId,
                          quotation.id,
                        );
                        setDetail(null);
                        setConfirmingDelete(false);
                        await refreshList();
                      }, 'Draft quotation deleted.');
                    }}
                  />
                )}
              </>
            ) : (
              /* Issued and settled quotations are read-only records: the
                 number, the lines, and the total stay exactly as issued. */
              <>
                <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
                  <div>
                    <dt>Addressed to</dt>
                    <dd>{quotation.addressedTo}</dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{quotation.subject}</dd>
                  </div>
                  <div>
                    <dt>Valid until</dt>
                    <dd>{quotation.validUntil ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>
                      {quotation.totalAmount !== null
                        ? formatInr(quotation.totalAmount)
                        : formatInr(detail.previewTotal)}
                    </dd>
                  </div>
                </dl>
                {quotation.notes !== null && (
                  <p className="text-muted-foreground">{quotation.notes}</p>
                )}
                {detail.lines.length > 0 && (
                  <DataTable>
                    <caption className="sr-only">
                      The quotation&apos;s lines as issued
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Description</th>
                        <th scope="col">HSN/SAC</th>
                        <th scope="col">Unit</th>
                        <th scope="col" className={numericCell}>
                          Quantity
                        </th>
                        <th scope="col" className={numericCell}>
                          Rate
                        </th>
                        <th scope="col" className={numericCell}>
                          GST %
                        </th>
                        <th scope="col" className={numericCell}>
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((line) => (
                        <tr key={line.id}>
                          <th scope="row">{line.lineNumber}</th>
                          <td className={wrapCell}>{line.description}</td>
                          <td>{line.hsnCode ?? '—'}</td>
                          <td>{line.unitCode}</td>
                          <td className={numericCell}>{line.quantity}</td>
                          <td className={numericCell}>{formatRate(line.rate)}</td>
                          <td className={numericCell}>{line.gstRate ?? '—'}</td>
                          <td className={numericCell}>{formatInr(line.lineAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={7}>
                          Total
                        </th>
                        <td className={numericCell}>
                          <strong>
                            {quotation.totalAmount !== null
                              ? formatInr(quotation.totalAmount)
                              : formatInr(detail.previewTotal)}
                          </strong>
                        </td>
                      </tr>
                    </tfoot>
                  </DataTable>
                )}

                {quotation.status === 'issued' && (
                  <>
                    <Actions>
                      {canModify && (
                        <>
                          <Button
                            disabled={pending}
                            onClick={() => {
                              void act(async () => {
                                setDetail(
                                  await api.setBudgetaryQuotationOutcome(
                                    organisationId,
                                    quotation.id,
                                    { outcome: 'converted' },
                                  ),
                                );
                                await refreshList();
                              }, `Quotation ${numberLabel} marked converted — the offer won.`);
                            }}
                          >
                            Mark converted
                          </Button>
                          <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              void act(async () => {
                                setDetail(
                                  await api.setBudgetaryQuotationOutcome(
                                    organisationId,
                                    quotation.id,
                                    { outcome: 'expired' },
                                  ),
                                );
                                await refreshList();
                              }, `Quotation ${numberLabel} marked expired — the offer lapsed.`);
                            }}
                          >
                            Mark expired
                          </Button>
                        </>
                      )}
                      {canCancel && (
                        <Button
                          variant="outline"
                          disabled={pending}
                          aria-haspopup="dialog"
                          onClick={() => {
                            setConfirmingWithdraw(true);
                          }}
                        >
                          Withdraw quotation…
                        </Button>
                      )}
                    </Actions>
                    {canCancel && confirmingWithdraw && (
                      <ConfirmDialog
                        title="Confirm withdrawal"
                        description={`Withdrawing takes back an offer that has left the building — it is the cancel act, not a lapse. Quotation ${numberLabel} keeps its number forever, its lines and total stay exactly as issued, and the status never moves again. Continue?`}
                        cancelLabel="Keep it issued"
                        confirmLabel={`Withdraw ${numberLabel} now`}
                        pending={pending}
                        onCancel={() => {
                          setConfirmingWithdraw(false);
                        }}
                        onConfirm={() => {
                          void act(async () => {
                            setDetail(
                              await api.setBudgetaryQuotationOutcome(
                                organisationId,
                                quotation.id,
                                { outcome: 'withdrawn' },
                              ),
                            );
                            setConfirmingWithdraw(false);
                            await refreshList();
                          }, `Quotation ${numberLabel} withdrawn; its number is retained forever.`);
                        }}
                      />
                    )}
                  </>
                )}
                {(quotation.status === 'converted' ||
                  quotation.status === 'expired' ||
                  quotation.status === 'withdrawn') && (
                  <p className="text-muted-foreground">
                    This quotation is {quotation.status}; the record and its number{' '}
                    {numberLabel !== 'this draft' ? `${numberLabel} ` : ''}are retained
                    forever.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
