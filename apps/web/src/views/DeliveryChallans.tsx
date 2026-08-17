import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, LockKeyhole } from 'lucide-react';
import type {
  ChallanDetailResponse,
  Contact,
  DeliveryChallanMovement,
  DeliveryChallanRegisterEntry,
  EwayBill,
  MovementReason,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatInr, formatRate, todayIso } from '../format.js';
import { cn } from '../lib/cn.js';
import { challanHash, navigateOnClick } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, Hint } from '../ui/form.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';
import { EwayBillsPanel } from './EwayBillsPanel.js';

/**
 * The delivery tab of the Challans module — the movement document's
 * register.
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
 *
 * Ports the delivery half of `components/document-register` at
 * `a8e1fde`: the register card, the number cell with its issued padlock,
 * the Work-over-consignee identity cell, and the open-draft warning. The
 * page header, the tab rail and the `?work=` chip that wrap it belong to
 * `Challans.tsx`, exactly as `challans-workspace` wraps the mock's.
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
  /** The compliance authority (migration 0061). Gates the NIC portal
   * controls on a challan's e-way bill; the challan's own lifecycle is
   * untouched by it. */
  readonly canManageStatutory: boolean;
  /** The register row the hash names (`#/delivery-challans/<id>`), or null
   * for the plain register. */
  readonly openChallanId: string | null;
  /** The mock's `?work=` deep link. When a Work is named the register
   * reads only its movements and the module draws the filter chip; the
   * one-open-draft rule is a per-Work rule, so the draft warning and the
   * held New button only mean anything here. */
  readonly workId: string | null;
  /** Push a hash so the opened record is linkable and the back button
   * works; the workspace shell owns the actual navigation. */
  readonly onOpenChallan: (challanId: string | null) => void;
  /** Opening a Work challan leaves this module for the Work's own screen. */
  readonly onOpenWorkChallan: (workId: string, challanId: string) => void;
  /** The id of this Work's one open draft, or null when it has none.
   * Reported upwards because the module's New-challan action lives in
   * the page header — the mock's placement — while the rows that decide
   * whether a draft is open are read down here. */
  readonly onOpenDraftChange?: (draftChallanId: string | null) => void;
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
  /** The statutory classification (ADR-0013). Optional on the document:
   * a challan is a valid movement record without it, and it is required
   * only before an e-way bill can be raised. Blank means "not
   * classified"; `kind` is what says which of the two the code is. */
  hsnSacCode: string;
  kind: '' | 'goods' | 'service';
}

const EMPTY_LINE: LineDraft = {
  description: '',
  unit: '',
  quantity: '',
  rate: '',
  hsnSacCode: '',
  kind: '',
};

const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  supply: 'Supply',
  job_work: 'Job work',
  for_own_use: 'For own use',
  others: 'Others',
};

const HSN_PATTERN = /^[0-9]{6,8}$/;
const SAC_PATTERN = /^[0-9]{6}$/;

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
  // The pair travels together or not at all: the marker is what says
  // which of the two the code is, and the server refuses the half-stated
  // pair by name (LINE_SHAPE_INVALID). Said here so the operator is told
  // before the round trip.
  const classified = line.hsnSacCode.trim() !== '' || line.kind !== '';
  if (classified) {
    if (line.kind === '') {
      return 'A classified line says whether it is goods or a service.';
    }
    if (line.kind === 'goods' && !HSN_PATTERN.test(line.hsnSacCode.trim())) {
      return 'A goods line carries a six-to-eight-digit HSN code.';
    }
    if (line.kind === 'service' && !SAC_PATTERN.test(line.hsnSacCode.trim())) {
      return 'A service line carries a six-digit SAC code.';
    }
  }
  return null;
}

/** Why this challan cannot raise an e-way bill, or null when it can.
 *
 * The screen never decides eligibility — `challan.ewayBillEligible` is
 * the server's answer and the only one that counts. This function only
 * turns a false into a sentence that names the fix. */
function ewayBillRefusal(detail: ChallanDetailResponse): string | null {
  if (detail.challan.ewayBillEligible === true) return null;
  if (detail.challan.status === 'cancelled') {
    return 'This challan is cancelled, so nothing moves under it.';
  }
  if ((detail.challan.movementReason ?? null) === null) {
    return 'This challan records no reason for the movement, and an issued challan is immutable — the facts belong on the draft. An e-way bill cannot be raised from it.';
  }
  if (!detail.items.some((item) => item.isService === false)) {
    return 'No line of this challan is classified as goods. An e-way bill moves goods, so NIC refuses one for a service-only document.';
  }
  return 'This challan cannot raise an e-way bill.';
}

export function DeliveryChallans({
  api,
  organisationId,
  canModify,
  canIssue,
  canCancel,
  canManageStatutory,
  openChallanId,
  workId,
  onOpenChallan,
  onOpenWorkChallan,
  onOpenDraftChange,
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
  /** The cancel confirmation, and the reason it insists on. */
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  const [challanDate, setChallanDate] = useState(todayIso);
  const [prefix, setPrefix] = useState('DC');
  const [consigneeContactId, setConsigneeContactId] = useState('');
  const [lines, setLines] = useState<readonly LineDraft[]>([{ ...EMPTY_LINE }]);
  const [movementReason, setMovementReason] = useState<'' | MovementReason>('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [transporterName, setTransporterName] = useState('');
  const [transportDistanceKm, setTransportDistanceKm] = useState('');
  const [ewayBills, setEwayBills] = useState<readonly EwayBill[]>([]);

  const refreshList = useCallback(async () => {
    setChallans(await api.listDeliveryChallans(organisationId, workId));
  }, [api, organisationId, workId]);

  useEffect(() => {
    let cancelled = false;
    setChallans(null);
    setLoadError(null);
    Promise.all([
      api.listDeliveryChallans(organisationId, workId),
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
  }, [api, organisationId, workId, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

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
    // Reset both the detail and its e-way bills the moment the open id
    // changes, so navigating A -> B never shows A's bills against B while
    // B loads (the panel's state is otherwise only written after an action).
    setEwayBills([]);
    if (openChallanId === null) {
      setDetail(null);
      return;
    }
    api
      .getChallan(organisationId, openChallanId)
      .then(async (response) => {
        if (cancelled) return;
        setDetail(response);
        // The panel renders only for a non-draft standalone challan; match
        // that here so a draft or a (pasted) work challan issues no needless
        // or refused list request. Fetch on open, mirroring the invoice
        // workspace's mount, so a challan with an existing bill shows it
        // immediately rather than only after the first panel action.
        if (
          response.challan.kind === 'standalone' &&
          response.challan.status !== 'draft'
        ) {
          const bills = await api.listChallanEwayBills(organisationId, openChallanId);
          if (!cancelled) setEwayBills(bills);
        }
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

  /* The `?work=` deep link is a request parameter, not a filter over the
   * page: `GET /api/delivery-challans?work=` narrows in SQL, so the
   * register reads THAT Work's movements rather than whichever of them
   * happened to land on the loaded page. The movement filter below stays
   * client-side, and correctly so — it partitions the rows already read
   * and its counts describe exactly those rows. */
  const scoped = challans ?? [];

  const counts = useMemo(
    () => ({
      all: scoped.length,
      loa_supply: scoped.filter((row) => row.movement === 'loa_supply').length,
      work_material: scoped.filter((row) => row.movement === 'work_material').length,
      standalone: scoped.filter((row) => row.movement === 'standalone').length,
    }),
    [scoped],
  );

  const rows = useMemo(
    () => (filter === 'all' ? scoped : scoped.filter((row) => row.movement === filter)),
    [scoped, filter],
  );

  /* One open draft per Work is the rule the server enforces; here it is
   * only reported, so the module can hold its New-challan action and say
   * why (`components/document-register` at `a8e1fde`). */
  const openDraftId = useMemo(
    () =>
      workId === null
        ? null
        : (scoped.find((row) => row.status === 'draft')?.id ?? null),
    [scoped, workId],
  );
  useEffect(() => {
    onOpenDraftChange?.(openDraftId);
  }, [onOpenDraftChange, openDraftId]);

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
    setMovementReason('');
    setVehicleNumber('');
    setTransporterName('');
    setTransportDistanceKm('');
  }

  const standaloneDetail =
    detail !== null && detail.challan.kind === 'standalone' ? detail : null;

  return (
    <>
      <section aria-label="Delivery challans" className="flex flex-col gap-4">
        {openDraftId !== null && (
          /* The mock's open-draft warning, verbatim in shape
             (`components/document-register` at `a8e1fde`): a
             warning-tinted panel at `p-3`, the icon nudged onto the
             first line's baseline. Only one delivery-challan draft is
             allowed per Work, so this is the register saying where the
             held New-challan action went. */
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0 text-warning-foreground"
              aria-hidden="true"
            />
            <span>
              <strong className="font-semibold">Open draft:</strong> its number is
              assigned on issue. Only one delivery-challan draft is allowed per Work.
            </span>
          </div>
        )}
        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry delivery challans">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && challans === null && (
          <LoadingState label="the delivery challans" rows={5} columns={4} />
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
                Delivery challans with movement, Work and consignee, date, value, and
                status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Movement</th>
                  <th scope="col">Work / consignee</th>
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
                          {row.challanNumber ?? 'Number assigned on issue'}
                        </a>
                        {/* The mock marks an issued document with a
                            padlock beside its number: the content is
                            frozen, and the register says so before the
                            record is opened. Decorative — `Issued` is
                            spelled out in the status column. */}
                        {row.status === 'issued' && (
                          <LockKeyhole
                            className="ml-2 inline size-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </th>
                      <td>{MOVEMENT_LABELS[row.movement]}</td>
                      <td className={wrapCell}>
                        <span className="font-mono text-xs">
                          {row.workCode ?? 'Standalone'}
                        </span>
                        <span className="block text-muted-foreground">
                          {row.consigneeName}
                        </span>
                      </td>
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
          ) : scoped.length > 0 ? (
            <EmptyState
              action={{
                label: 'Show all challans',
                onClick: () => {
                  setFilter('all');
                },
              }}
            >
              No challans of this kind yet.
            </EmptyState>
          ) : challans.length > 0 ? (
            // Scoped to a Work that has no movements yet. Clearing the
            // filter is the chip's own control, so this state names the
            // fact and leaves the action where it already is.
            <EmptyState>No delivery challans for this Work yet.</EmptyState>
          ) : (
            <EmptyState>
              No delivery challans yet. A challan is raised from a Work, or as a
              standalone despatch below.
            </EmptyState>
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
                      ...(line.kind === ''
                        ? {}
                        : {
                            hsnSacCode: line.hsnSacCode.trim(),
                            isService: line.kind === 'service',
                          }),
                    })),
                    ...(movementReason === '' ? {} : { movementReason }),
                    ...(vehicleNumber.trim() === ''
                      ? {}
                      : { vehicleNumber: vehicleNumber.trim().toUpperCase() }),
                    ...(transporterName.trim() === ''
                      ? {}
                      : { transporterName: transporterName.trim() }),
                    ...(transportDistanceKm.trim() === ''
                      ? {}
                      : { transportDistanceKm: Number(transportDistanceKm) }),
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

              <Disclosure label="Statutory movement facts (for an e-way bill)">
                <Hint>
                  Optional on the document, and required before this challan can raise
                  an e-way bill. They are frozen when the challan is issued, like
                  everything else printed on it, so record them here rather than
                  afterwards. The consignee&rsquo;s GSTIN is taken from the contact.
                </Hint>
                <FieldRow>
                  <Field>
                    <label htmlFor="standalone-movement-reason">
                      Reason for the movement
                    </label>
                    <select
                      id="standalone-movement-reason"
                      value={movementReason}
                      onChange={(event) => {
                        setMovementReason(event.target.value as '' | MovementReason);
                      }}
                    >
                      <option value="">Not recorded</option>
                      <option value="supply">Supply</option>
                      <option value="job_work">Job work</option>
                      <option value="for_own_use">For own use</option>
                      <option value="others">Others</option>
                    </select>
                  </Field>
                  <Field>
                    <label htmlFor="standalone-vehicle">Vehicle number</label>
                    <input
                      id="standalone-vehicle"
                      value={vehicleNumber}
                      onChange={(event) => {
                        setVehicleNumber(event.target.value.toUpperCase());
                      }}
                    />
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field>
                    <label htmlFor="standalone-transporter">Transporter</label>
                    <input
                      id="standalone-transporter"
                      value={transporterName}
                      onChange={(event) => {
                        setTransporterName(event.target.value);
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor="standalone-distance">Distance (km)</label>
                    <input
                      id="standalone-distance"
                      inputMode="numeric"
                      value={transportDistanceKm}
                      onChange={(event) => {
                        setTransportDistanceKm(event.target.value);
                      }}
                    />
                  </Field>
                </FieldRow>
              </Disclosure>

              <DataTable>
                <caption className="sr-only">Lines on this standalone challan</caption>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Rate</th>
                    <th scope="col">HSN/SAC</th>
                    <th scope="col">Goods or service</th>
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
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-hsn`}
                        >
                          Line {index + 1} HSN or SAC code
                        </label>
                        <input
                          id={`standalone-line-${String(index)}-hsn`}
                          inputMode="numeric"
                          value={line.hsnSacCode}
                          onChange={(event) => {
                            updateLine(index, { hsnSacCode: event.target.value });
                          }}
                        />
                      </td>
                      <td>
                        <label
                          className="sr-only"
                          htmlFor={`standalone-line-${String(index)}-kind`}
                        >
                          Line {index + 1} goods or service
                        </label>
                        <select
                          id={`standalone-line-${String(index)}-kind`}
                          value={line.kind}
                          onChange={(event) => {
                            updateLine(index, {
                              kind: event.target.value as LineDraft['kind'],
                            });
                          }}
                        >
                          <option value="">Not classified</option>
                          <option value="goods">Goods (HSN)</option>
                          <option value="service">Service (SAC)</option>
                        </select>
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
                  <th scope="col">HSN/SAC</th>
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
                    <td>
                      {item.hsnSacCode ?? '—'}
                      {item.isService === true
                        ? ' · service'
                        : item.isService === false
                          ? ' · goods'
                          : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            {(standaloneDetail.challan.movementReason ?? null) !== null && (
              <p className="mt-3 text-sm text-muted-foreground">
                Movement:{' '}
                {
                  MOVEMENT_REASON_LABELS[
                    standaloneDetail.challan.movementReason ?? 'supply'
                  ]
                }
                {(standaloneDetail.challan.vehicleNumber ?? null) !== null &&
                  ` · vehicle ${standaloneDetail.challan.vehicleNumber ?? ''}`}
                {(standaloneDetail.challan.transportDistanceKm ?? null) !== null &&
                  ` · ${String(standaloneDetail.challan.transportDistanceKm)} km`}
                {(standaloneDetail.challan.consigneeGstin ?? null) !== null &&
                  ` · consignee GSTIN ${standaloneDetail.challan.consigneeGstin ?? ''}`}
              </p>
            )}

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
                    setCancelNote('');
                    setCancelling(true);
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

            {standaloneDetail.challan.status !== 'draft' && (
              <EwayBillsPanel
                api={api}
                organisationId={organisationId}
                source={{
                  kind: 'delivery_challan',
                  id: standaloneDetail.challan.id,
                  number: standaloneDetail.challan.challanNumber,
                  // The server's own answer (ADR-0013), not a second copy
                  // of the rule: it is true only for an issued standalone
                  // challan that records its movement reason and carries
                  // at least one goods line.
                  eligible: standaloneDetail.challan.ewayBillEligible === true,
                  refusal: ewayBillRefusal(standaloneDetail),
                }}
                ewayBills={ewayBills}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
                canManageStatutory={canManageStatutory}
                pending={pending}
                act={act}
                onEwayBillsChanged={setEwayBills}
              />
            )}
          </section>
        )}
      </section>

      {cancelling && standaloneDetail !== null && (
        /* The mock's `components/cancel-document-dialog` at
           `a8e1fde`, in this build's confirmation primitive. Its two
           facts are the ones the operator has to hear before answering:
           the document stays in the register, and the number it holds is
           spent forever. The reason is required because the server
           requires it (three characters, `CancelChallanRequest`), so a
           blank one would only buy a refused round trip. */
        <ConfirmDialog
          title={`Cancel ${standaloneDetail.challan.challanNumber ?? 'this challan'}?`}
          description="The document stays in the register and its number will never be reused."
          confirmLabel="Confirm cancellation"
          cancelLabel="Keep document"
          pending={pending}
          confirmDisabled={cancelNote.trim().length < 3}
          onCancel={() => {
            setCancelling(false);
          }}
          onConfirm={() => {
            const challanId = standaloneDetail.challan.id;
            const note = cancelNote;
            setCancelling(false);
            void act(async () => {
              const cancelled = await api.cancelChallan(organisationId, challanId, {
                note,
              });
              setDetail(cancelled);
              await refreshList();
            }, 'Standalone challan cancelled.');
          }}
        >
          <Field>
            <label htmlFor="standalone-cancel-note">Reason</label>
            <input
              id="standalone-cancel-note"
              value={cancelNote}
              onChange={(event) => {
                setCancelNote(event.target.value);
              }}
              minLength={3}
              autoComplete="off"
            />
            <Hint>
              The reason stays on the cancelled record, which anyone reading the
              register later will see.
            </Hint>
          </Field>
        </ConfirmDialog>
      )}
    </>
  );
}
