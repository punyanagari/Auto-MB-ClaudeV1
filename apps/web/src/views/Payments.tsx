import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Contact,
  PaymentRequest,
  CreatablePaymentRequestCategory,
  CreatablePaymentRequestKind,
  PaymentRequestCategory,
  PaymentRequestKind,
  TdsPreviewResponse,
  VendorInvoice,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import {
  navigateOnClick,
  paymentsHash,
  type PaymentsRegisterTab,
} from '../lib/workspace-routes.js';
import { formatDate, formatInr, todayIso } from '../format.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FormError, FormNotice } from '../ui/form.js';
import { DownloadButton } from '../ui/download-button.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { errorMessage, describeLoadFailure } from '../lib/load-failure.js';
import { NumericInput } from '../ui/numeric-input.js';

/**
 * Money going out: employee advances and reimbursements, and the vendor
 * liability ledger.
 *
 * The mock draws this as one screen with two register tabs
 * (`components/payment-requests-workspace.tsx` at `fdfe5ef`), and that
 * is the structure kept here. Two of the mock's surfaces are
 * deliberately absent because the behaviour behind them does not exist
 * yet: the bank-statement Reconciliation tab and the Tally import card
 * ride with the importer infrastructure, and a tab that cannot do
 * anything is worse than a tab that is not drawn.
 *
 * ponytail: the register is a plain two-tab table rather than the mock's
 * nested tab set and floating batch bar. Batching several approved
 * requests into one bank summary is the piece left out; add it when the
 * owner's v0 round for this screen lands, since that round is expected
 * to change how the batch surface looks anyway.
 *
 * No figure on this page is computed here. Outstanding balances, due
 * dates, TDS splits and register totals all arrive as decimal strings
 * the server produced in SQL.
 */

interface PaymentsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly currentUserId: string;
  /** Holds `can_manage_payments` — gates approving a request and every
   * vendor write. Without it the screen is a read-only register. */
  readonly canManagePayments: boolean;
  readonly canCancel: boolean;
  /** Which register is showing. It is a route, not local state, so the
   * strip below is a nav of real links. */
  readonly tab: PaymentsRegisterTab;
  readonly onOpenRegister: (tab: PaymentsRegisterTab) => void;
}

const KIND_LABELS: Record<PaymentRequestKind, string> = {
  advance: 'Advance',
  reimbursement: 'Reimbursement',
  // Raised only by a finalised payroll run (migration 0090), so it is
  // rendered on rows here and never offered in the composer below.
  salary: 'Salary',
};

const STATUS_LABELS: Record<PaymentRequest['status'], string> = {
  submitted: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
  settled: 'Settled',
};

const CATEGORY_LABELS: Record<PaymentRequestCategory, string> = {
  travel: 'Travel',
  materials: 'Materials',
  labour: 'Labour',
  site_expenses: 'Site expenses',
  general: 'General',
  payroll: 'Payroll',
};

/**
 * The categories the composer offers, which is not the same list.
 *
 * `payroll` is reachable only through a finalised payroll run. Offering
 * it here would let somebody file a salary with no payslip behind it —
 * money out of the bank with nothing to reconcile against the provident
 * fund and tax actually remitted — and the server refuses it anyway, so
 * the option would be a control that cannot work.
 */
const CREATABLE_CATEGORY_LABELS: Record<CreatablePaymentRequestCategory, string> = {
  travel: CATEGORY_LABELS.travel,
  materials: CATEGORY_LABELS.materials,
  labour: CATEGORY_LABELS.labour,
  site_expenses: CATEGORY_LABELS.site_expenses,
  general: CATEGORY_LABELS.general,
};

const REGISTER_TABS: readonly {
  readonly id: PaymentsRegisterTab;
  readonly label: string;
}[] = [
  { id: 'employee', label: 'Employee' },
  { id: 'vendors', label: 'Vendors' },
];

export function Payments({
  api,
  organisationId,
  currentUserId,
  canManagePayments,
  canCancel,
  tab,
  onOpenRegister,
}: PaymentsProps) {
  const [requests, setRequests] = useState<readonly PaymentRequest[] | null>(null);
  const [invoices, setInvoices] = useState<readonly VendorInvoice[] | null>(null);
  const [totals, setTotals] = useState<{
    outstanding: string;
    overdue: number;
  } | null>(null);
  const [contacts, setContacts] = useState<readonly Contact[]>([]);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [vendorsError, setVendorsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /* Each register loads only when it is the one on screen. Both used to
     load on mount, so opening Payments cost two round trips to render
     one table and a work-scoped member saw an error for a register they
     were not looking at. */
  const employeeTab = tab === 'employee';

  const loadRequests = useCallback(async () => {
    setRequestsError(null);
    try {
      const payload = await api.listPaymentRequests(organisationId);
      setRequests(payload.requests);
    } catch (error) {
      setRequests(null);
      setRequestsError(describeLoadFailure(error, 'Payment requests').message);
    }
  }, [api, organisationId]);

  const loadVendors = useCallback(async () => {
    setVendorsError(null);
    try {
      const payload = await api.listVendorInvoices(organisationId);
      setInvoices(payload.invoices);
      setTotals({
        outstanding: payload.totalOutstanding,
        overdue: payload.overdueCount,
      });
    } catch (error) {
      setInvoices(null);
      setVendorsError(describeLoadFailure(error, 'Vendor invoices').message);
    }
  }, [api, organisationId]);

  useEffect(() => {
    if (employeeTab) void loadRequests();
    else void loadVendors();
  }, [employeeTab, loadRequests, loadVendors]);

  /* The party master, for the two pickers. A failure here is not a
     failed register: the tables still render, only the create forms lose
     their options, so it deliberately does not set a load error. */
  useEffect(() => {
    if (!canManagePayments) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.listContacts(organisationId, {});
        if (!cancelled) setContacts(rows);
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, canManagePayments]);

  const act = useCallback(async (run: () => Promise<void>, success: string) => {
    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      await run();
      setNotice(success);
    } catch (error) {
      setFormError(errorMessage(error, 'The action could not be completed.'));
    } finally {
      setPending(false);
    }
  }, []);

  /* Mutation responses are spliced into the list rather than triggering
     a reload that blanks it: a register that empties itself for a moment
     after every approval reads as a failure, and the server already
     returned the row it changed. */
  const spliceRequest = useCallback((updated: PaymentRequest) => {
    setRequests((all) =>
      all === null ? all : all.map((row) => (row.id === updated.id ? updated : row)),
    );
  }, []);

  const awaitingDecision = (requests ?? []).filter(
    (request) => request.status === 'submitted',
  );
  const openAdvances = (requests ?? []).filter((request) => request.billsDue);

  return (
    <>
      <PageHeader
        eyebrow="Finance operations"
        title="Payments"
        description="Employee advances and reimbursements, and what this organisation owes its vendors."
        action={
          /* Vendor payments, with their TDS facts as they were
             snapshotted. Organisation-wide, so the server refuses a
             member whose scope is limited to assigned Works — the button
             prints that refusal rather than an empty file. */
          <DownloadButton
            label="Export .xlsx"
            filename="vendor-payments.xlsx"
            fetchBlob={() => api.downloadRegisterWorkbook(organisationId, 'payments')}
          />
        }
      />

      {/* The tiles belong to the register on screen. Only that register
          is loaded — the other's figures are genuinely unknown — and a
          row of em-dashes reads as broken rather than as unloaded. */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {employeeTab ? (
          <>
            <Stat
              label="Awaiting approval"
              value={requests === null ? '—' : String(awaitingDecision.length)}
              hint="Employee requests"
            />
            <Stat
              label="Advances open"
              value={requests === null ? '—' : String(openAdvances.length)}
              hint="Final bills due"
              {...(openAdvances.length > 0 ? { tone: 'warning' as const } : {})}
            />
          </>
        ) : (
          <>
            <Stat
              label="Vendor outstanding"
              value={totals === null ? '—' : formatInr(totals.outstanding)}
              hint="Live invoices"
            />
            <Stat
              label="Overdue"
              value={totals === null ? '—' : String(totals.overdue)}
              hint="Past credit terms"
              {...(totals !== null && totals.overdue > 0
                ? { tone: 'warning' as const }
                : {})}
            />
          </>
        )}
      </div>

      {formError !== null && <FormError>{formError}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}

      {/* The mock's `TabsList`, as real anchors: each register is its own
          address, so a middle click opens it in a browser tab and Back
          walks between the two. This is also why there is no `tablist`
          role here — a nav with `aria-current` already has the keyboard
          behaviour the role would only promise. */}
      <nav aria-label="Payments registers" className="mb-4">
        <ul className="flex w-full list-none justify-start gap-1 rounded-xl border border-border bg-card p-1 sm:w-fit">
          {REGISTER_TABS.map((candidate) => {
            const current = candidate.id === tab;
            return (
              <li key={candidate.id}>
                <a
                  href={paymentsHash(candidate.id)}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors',
                    current
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent/35',
                  )}
                  onClick={navigateOnClick(() => {
                    onOpenRegister(candidate.id);
                  })}
                >
                  {candidate.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {employeeTab ? (
        <section aria-label="Employee payment requests">
          <EmployeeRegister
            api={api}
            organisationId={organisationId}
            currentUserId={currentUserId}
            canManagePayments={canManagePayments}
            contacts={contacts}
            requests={requests}
            error={requestsError}
            pending={pending}
            onRetry={() => {
              void loadRequests();
            }}
            onAct={act}
            onSpliced={spliceRequest}
            onCreated={(created) => {
              setRequests((all) => (all === null ? [created] : [created, ...all]));
            }}
          />
        </section>
      ) : (
        <section aria-label="Vendor ledger">
          <VendorRegister
            api={api}
            organisationId={organisationId}
            canManagePayments={canManagePayments}
            canCancel={canCancel}
            contacts={contacts}
            invoices={invoices}
            error={vendorsError}
            pending={pending}
            onRetry={() => {
              void loadVendors();
            }}
            onAct={act}
            onReload={loadVendors}
          />
        </section>
      )}
    </>
  );
}

// ── Employee register ────────────────────────────────────────────────

function EmployeeRegister({
  api,
  organisationId,
  currentUserId,
  canManagePayments,
  contacts,
  requests,
  error,
  pending,
  onRetry,
  onAct,
  onSpliced,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly currentUserId: string;
  readonly canManagePayments: boolean;
  readonly contacts: readonly Contact[];
  readonly requests: readonly PaymentRequest[] | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onSpliced: (updated: PaymentRequest) => void;
  readonly onCreated: (created: PaymentRequest) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<PaymentRequest | null>(null);

  if (error !== null) {
    return (
      <ErrorState onRetry={onRetry} retryLabel="Retry payment requests">
        {error}
      </ErrorState>
    );
  }
  if (requests === null) return <LoadingState label="Loading payment requests" />;

  const openAdvances = requests.filter((request) => request.billsDue);
  const blockedBeneficiaries = new Set(
    openAdvances.map((request) => request.beneficiaryContactId),
  );

  return (
    <div className="flex flex-col gap-4">
      {openAdvances.length > 0 && (
        <Card>
          <p className="m-0 font-medium">New advances are blocked</p>
          <p className="m-0 text-sm text-muted-foreground">
            {openAdvances
              .map(
                (request) =>
                  `${request.requestNumber} (${request.beneficiaryName}, ${formatInr(request.amount)})`,
              )
              .join(', ')}{' '}
            {openAdvances.length === 1 ? 'is a paid advance' : 'are paid advances'}{' '}
            whose final bills have not been recorded. Record them before drawing another
            advance for {openAdvances.length === 1 ? 'that' : 'those'}{' '}
            {openAdvances.length === 1 ? 'beneficiary' : 'beneficiaries'}.
          </p>
        </Card>
      )}

      {canManagePayments && (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setCreating((open) => !open);
            }}
            aria-expanded={creating}
            aria-controls="payment-request-form"
          >
            New request
          </Button>
        </div>
      )}

      {creating && (
        <NewRequestForm
          api={api}
          organisationId={organisationId}
          contacts={contacts}
          blockedBeneficiaries={blockedBeneficiaries}
          pending={pending}
          onAct={onAct}
          onCancel={() => {
            setCreating(false);
          }}
          onCreated={(created) => {
            setCreating(false);
            onCreated(created);
          }}
        />
      )}

      {requests.length === 0 ? (
        <EmptyState>No advance or reimbursement has been raised yet.</EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">Employee advances and reimbursements</caption>
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Type</th>
              <th scope="col">Beneficiary</th>
              <th scope="col">Purpose</th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td className={numericCell}>
                  {request.requestNumber}
                  <span className="block text-xs text-muted-foreground">
                    {formatDate(request.createdAt.slice(0, 10))}
                    {request.workCode !== null && ` · ${request.workCode}`}
                  </span>
                </td>
                <td>{KIND_LABELS[request.kind]}</td>
                <td className={wrapCell}>{request.beneficiaryName}</td>
                <td className="max-w-60 truncate" title={request.purpose}>
                  {request.purpose}
                </td>
                <td className={numericCell}>{formatInr(request.amount)}</td>
                <td>
                  <StatusChip status={request.status}>
                    {STATUS_LABELS[request.status]}
                  </StatusChip>
                  {request.billsDue && (
                    <span className="block text-xs text-muted-foreground">
                      Final bills due
                    </span>
                  )}
                </td>
                <td>
                  {canManagePayments &&
                    request.status === 'submitted' &&
                    request.requestedByUserId !== currentUserId && (
                      <Button
                        variant="secondary"
                        disabled={pending}
                        onClick={() => {
                          void onAct(async () => {
                            onSpliced(
                              await api.decidePaymentRequest(
                                organisationId,
                                request.id,
                                { decision: 'approve' },
                              ),
                            );
                          }, `${request.requestNumber} approved.`);
                        }}
                      >
                        Approve
                      </Button>
                    )}
                  {canManagePayments && request.status === 'approved' && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        setPaying(request);
                      }}
                    >
                      Pay
                    </Button>
                  )}
                  {canManagePayments && request.billsDue && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void onAct(async () => {
                          onSpliced(
                            await api.recordAdvanceBills(
                              organisationId,
                              request.id,
                              {},
                            ),
                          );
                        }, `Final bills recorded for ${request.requestNumber}.`);
                      }}
                    >
                      Record bills
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {paying !== null && (
        <PayRequestForm
          api={api}
          organisationId={organisationId}
          request={paying}
          pending={pending}
          onAct={onAct}
          onCancel={() => {
            setPaying(null);
          }}
          onPaid={(updated) => {
            setPaying(null);
            onSpliced(updated);
          }}
        />
      )}
    </div>
  );
}

/** Raising an advance or a reimbursement. Proof is required to submit,
 * so the form refuses without it exactly as the server does. */
function NewRequestForm({
  api,
  organisationId,
  contacts,
  blockedBeneficiaries,
  pending,
  onAct,
  onCancel,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly contacts: readonly Contact[];
  readonly blockedBeneficiaries: ReadonlySet<string>;
  readonly pending: boolean;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly onCreated: (created: PaymentRequest) => void;
}) {
  const payable = useMemo(
    () => contacts.filter((contact) => contact.isEmployee || contact.isVendor),
    [contacts],
  );
  const [kind, setKind] = useState<CreatablePaymentRequestKind>('reimbursement');
  const [beneficiary, setBeneficiary] = useState('');
  const [purpose, setPurpose] = useState('');
  const [category, setCategory] = useState<CreatablePaymentRequestCategory>('travel');
  const [amount, setAmount] = useState('');
  const [proof, setProof] = useState('');

  /* The advance gate, in the form as well as on the server. The server
     refuses by name under a unique index; this stops the operator
     filling in a form that cannot be submitted. */
  const blocked = kind === 'advance' && blockedBeneficiaries.has(beneficiary);
  const ready =
    beneficiary !== '' &&
    purpose.trim() !== '' &&
    amount.trim() !== '' &&
    proof.trim() !== '' &&
    !blocked;

  return (
    <Card id="payment-request-form">
      <h3 className="m-0 text-sm font-medium text-muted-foreground">New request</h3>
      <Field>
        <label htmlFor="request-kind">Request type</label>
        <select
          id="request-kind"
          className="input"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as CreatablePaymentRequestKind);
          }}
        >
          <option value="reimbursement">Reimbursement</option>
          <option value="advance">Advance</option>
        </select>
      </Field>
      <Field>
        <label htmlFor="request-beneficiary">Beneficiary</label>
        <select
          id="request-beneficiary"
          className="input"
          value={beneficiary}
          onChange={(event) => {
            setBeneficiary(event.target.value);
          }}
        >
          <option value="">Choose a payee</option>
          {payable.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.designation}
            </option>
          ))}
        </select>
        {payable.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No contact carries the employee or vendor role yet. Mark one in Masters
            first.
          </p>
        )}
      </Field>
      <Field>
        <label htmlFor="request-purpose">Purpose</label>
        <input
          id="request-purpose"
          className="input"
          value={purpose}
          onChange={(event) => {
            setPurpose(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="request-category">Category</label>
        <select
          id="request-category"
          className="input"
          value={category}
          onChange={(event) => {
            setCategory(event.target.value as CreatablePaymentRequestCategory);
          }}
        >
          {Object.entries(CREATABLE_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <label htmlFor="request-amount">Amount</label>
        <NumericInput
          id="request-amount"
          className="input"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="request-proof">Proof reference</label>
        <input
          id="request-proof"
          className="input"
          value={proof}
          onChange={(event) => {
            setProof(event.target.value);
          }}
          aria-describedby="request-proof-hint"
        />
        {/* ponytail: the proof is a reference an operator types, not an
            upload. The mock attaches a file; wiring that needs the
            upload pipeline (`consumeUpload` plus a serve route) and is
            called out in the pull request rather than half-built. */}
        <p className="text-sm text-muted-foreground" id="request-proof-hint">
          Name the estimate, quotation or bill this request rests on. Every expense
          needs proof before it can be submitted.
        </p>
      </Field>

      {blocked && (
        <p role="alert" className="text-sm font-medium text-destructive">
          This beneficiary has a paid advance whose final bills are not recorded, so
          another advance cannot be drawn for them yet.
        </p>
      )}

      <Actions>
        <Button
          disabled={pending || !ready}
          onClick={() => {
            void onAct(async () => {
              onCreated(
                await api.createPaymentRequest(organisationId, {
                  kind,
                  beneficiaryContactId: beneficiary,
                  purpose: purpose.trim(),
                  category,
                  amount: amount.trim(),
                  proofReference: proof.trim(),
                  proofFilename: proof.trim(),
                }),
              );
            }, 'Payment request submitted for approval.');
          }}
        >
          Submit for approval
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </Actions>
    </Card>
  );
}

/** Recording that an approved request was paid. */
function PayRequestForm({
  api,
  organisationId,
  request,
  pending,
  onAct,
  onCancel,
  onPaid,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly request: PaymentRequest;
  readonly pending: boolean;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly onPaid: (updated: PaymentRequest) => void;
}) {
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso);

  return (
    <Card>
      <h3 className="m-0 text-sm font-medium text-muted-foreground">
        Pay {request.requestNumber} — {request.beneficiaryName}
      </h3>
      <p className="text-sm text-muted-foreground">{formatInr(request.amount)}</p>
      <Field>
        <label htmlFor="pay-reference">Bank reference</label>
        <input
          id="pay-reference"
          className="input"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="pay-date">Paid on</label>
        <input
          id="pay-date"
          className="input"
          type="date"
          value={paidOn}
          onChange={(event) => {
            setPaidOn(event.target.value);
          }}
        />
      </Field>
      <Actions>
        <Button
          disabled={pending || reference.trim().length < 2}
          onClick={() => {
            void onAct(async () => {
              onPaid(
                await api.payPaymentRequest(organisationId, request.id, {
                  reference: reference.trim(),
                  paidOn,
                }),
              );
            }, `${request.requestNumber} paid.`);
          }}
        >
          Record payment
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </Actions>
    </Card>
  );
}

// ── Vendor register ──────────────────────────────────────────────────

function VendorRegister({
  api,
  organisationId,
  canManagePayments,
  canCancel,
  contacts,
  invoices,
  error,
  pending,
  onRetry,
  onAct,
  onReload,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canManagePayments: boolean;
  readonly canCancel: boolean;
  readonly contacts: readonly Contact[];
  readonly invoices: readonly VendorInvoice[] | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onReload: () => Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  const [paying, setPaying] = useState<VendorInvoice | null>(null);

  if (error !== null) {
    return (
      <ErrorState onRetry={onRetry} retryLabel="Retry vendor ledger">
        {error}
      </ErrorState>
    );
  }
  if (invoices === null) return <LoadingState label="Loading vendor ledger" />;

  return (
    <div className="flex flex-col gap-4">
      {canManagePayments && (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setRecording((open) => !open);
            }}
            aria-expanded={recording}
            aria-controls="vendor-invoice-form"
          >
            Record invoice
          </Button>
        </div>
      )}

      {recording && (
        <NewVendorInvoiceForm
          api={api}
          organisationId={organisationId}
          contacts={contacts}
          pending={pending}
          onAct={onAct}
          onCancel={() => {
            setRecording(false);
          }}
          onRecorded={async () => {
            setRecording(false);
            await onReload();
          }}
        />
      )}

      {invoices.length === 0 ? (
        <EmptyState>No vendor invoice has been recorded yet.</EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">Vendor invoices and what is outstanding</caption>
          <thead>
            <tr>
              <th scope="col">Vendor / invoice</th>
              <th scope="col">Due</th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col" className="numeric">
                Outstanding
              </th>
              <th scope="col">TDS</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const livePayments = invoice.payments.filter(
                (payment) => payment.voidedAt === null,
              );
              return (
                <tr key={invoice.id}>
                  <td className={wrapCell}>
                    {invoice.vendorName}
                    <span className="block font-mono text-xs text-muted-foreground">
                      {invoice.invoiceNumber} · {formatDate(invoice.invoiceDate)}
                    </span>
                  </td>
                  <td>
                    {formatDate(invoice.dueOn)}
                    <span className="block text-xs text-muted-foreground">
                      {invoice.creditDays} day terms
                    </span>
                  </td>
                  <td className={numericCell}>{formatInr(invoice.amount)}</td>
                  <td className={numericCell}>
                    {formatInr(invoice.outstandingAmount)}
                  </td>
                  <td>
                    {invoice.tdsSection ?? '—'}
                    {livePayments.some((payment) => payment.panAbsent) && (
                      <span className="block text-xs text-muted-foreground">
                        206AA — no PAN
                      </span>
                    )}
                  </td>
                  <td>
                    {canManagePayments &&
                      invoice.cancelledAt === null &&
                      invoice.outstandingAmount !== '0.00' && (
                        <Button
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            setPaying(invoice);
                          }}
                        >
                          Record payment
                        </Button>
                      )}
                    {canCancel &&
                      invoice.cancelledAt === null &&
                      livePayments.length === 0 && (
                        <Button
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            void onAct(async () => {
                              await api.cancelVendorInvoice(
                                organisationId,
                                invoice.id,
                                { reason: 'Cancelled from the vendor ledger' },
                              );
                              await onReload();
                            }, `${invoice.invoiceNumber} cancelled.`);
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    {canCancel &&
                      livePayments.map((payment) => (
                        <Button
                          key={payment.id}
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            void onAct(
                              async () => {
                                await api.voidVendorPayment(
                                  organisationId,
                                  payment.id,
                                  { reason: 'Voided from the vendor ledger' },
                                );
                                await onReload();
                              },
                              `Payment of ${formatInr(payment.grossAmount)} voided.`,
                            );
                          }}
                        >
                          Void {formatInr(payment.grossAmount)}
                        </Button>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {paying !== null && (
        <VendorPaymentForm
          api={api}
          organisationId={organisationId}
          invoice={paying}
          pending={pending}
          onCancel={() => {
            setPaying(null);
          }}
          onRecorded={async () => {
            setPaying(null);
            await onReload();
          }}
          onAct={onAct}
        />
      )}
    </div>
  );
}

/** Recording what a vendor billed. */
function NewVendorInvoiceForm({
  api,
  organisationId,
  contacts,
  pending,
  onAct,
  onCancel,
  onRecorded,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly contacts: readonly Contact[];
  readonly pending: boolean;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly onRecorded: () => Promise<void>;
}) {
  const vendors = useMemo(
    () => contacts.filter((contact) => contact.isVendor),
    [contacts],
  );
  const [vendor, setVendor] = useState('');
  const [number, setNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIso);
  const [creditDays, setCreditDays] = useState('30');
  const [amount, setAmount] = useState('');
  const [section, setSection] = useState<'' | '194C' | '194J'>('');
  const [payeeClass, setPayeeClass] = useState<'individual_huf' | 'other'>('other');

  const ready = vendor !== '' && number.trim() !== '' && amount.trim() !== '';

  return (
    <Card id="vendor-invoice-form">
      <h3 className="m-0 text-sm font-medium text-muted-foreground">
        Record vendor invoice
      </h3>
      <Field>
        <label htmlFor="invoice-vendor">Vendor</label>
        <select
          id="invoice-vendor"
          className="input"
          value={vendor}
          onChange={(event) => {
            setVendor(event.target.value);
          }}
        >
          <option value="">Choose a vendor</option>
          {vendors.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.designation}
              {contact.pan === null ? ' (no PAN — 206AA applies)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <label htmlFor="invoice-number">Invoice number</label>
        <input
          id="invoice-number"
          className="input"
          value={number}
          onChange={(event) => {
            setNumber(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="invoice-date">Invoice date</label>
        <input
          id="invoice-date"
          className="input"
          type="date"
          value={invoiceDate}
          onChange={(event) => {
            setInvoiceDate(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="invoice-credit-days">Credit period (days)</label>
        <NumericInput
          integer
          id="invoice-credit-days"
          className="input"
          value={creditDays}
          onChange={(event) => {
            setCreditDays(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="invoice-amount">Amount</label>
        <NumericInput
          id="invoice-amount"
          className="input"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="invoice-tds-section">TDS section</label>
        <select
          id="invoice-tds-section"
          className="input"
          value={section}
          onChange={(event) => {
            setSection(event.target.value as '' | '194C' | '194J');
          }}
        >
          <option value="">No TDS</option>
          <option value="194C">194C — contractor</option>
          <option value="194J">194J — professional or technical</option>
        </select>
      </Field>
      {section !== '' && (
        <Field>
          <label htmlFor="invoice-payee-class">
            {section === '194C' ? 'Payee' : 'Service'}
          </label>
          <select
            id="invoice-payee-class"
            className="input"
            value={payeeClass}
            onChange={(event) => {
              setPayeeClass(event.target.value as 'individual_huf' | 'other');
            }}
          >
            {section === '194C' ? (
              <>
                <option value="individual_huf">Individual or HUF — 1%</option>
                <option value="other">Company, firm or LLP — 2%</option>
              </>
            ) : (
              <>
                <option value="individual_huf">Technical or call centre — 2%</option>
                <option value="other">Professional — 10%</option>
              </>
            )}
          </select>
        </Field>
      )}
      <Actions>
        <Button
          disabled={pending || !ready}
          onClick={() => {
            void onAct(async () => {
              await api.recordVendorInvoice(organisationId, {
                vendorContactId: vendor,
                invoiceNumber: number.trim(),
                invoiceDate,
                creditDays: Number(creditDays),
                amount: amount.trim(),
                ...(section === ''
                  ? {}
                  : { tdsSection: section, tdsPayeeClass: payeeClass }),
              });
              await onRecorded();
            }, `Invoice ${number.trim()} recorded.`);
          }}
        >
          Record invoice
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </Actions>
    </Card>
  );
}

/**
 * Recording one vendor payment.
 *
 * The TDS figure is previewed from the server before the payment is
 * written, and the preview and the write go through the same server code
 * path. Nothing here multiplies the rate by the amount — the browser
 * would do it in floating point, and it would be the one number on the
 * screen that a tax officer later disagrees with.
 */
function VendorPaymentForm({
  api,
  organisationId,
  invoice,
  pending,
  onCancel,
  onRecorded,
  onAct,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: VendorInvoice;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onRecorded: () => Promise<void>;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [gross, setGross] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso);
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<TdsPreviewResponse | null>(null);

  const invoiceId = invoice.id;

  /* Debounced: the preview is a server round trip keyed to a text field,
     so an undebounced effect asks the server once per keystroke and the
     answers can arrive out of order. 300ms is long enough to stop typing
     and short enough that the figure feels live. */
  useEffect(() => {
    const typed = gross.trim();
    if (typed === '') {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.previewVendorTds(organisationId, invoiceId, {
            grossAmount: typed,
            paidOn,
          });
          if (!cancelled) setPreview(result);
        } catch {
          // A failed preview is not a failed payment: the server computes
          // the authoritative split again when the payment is recorded,
          // so the form stays usable and simply shows no estimate.
          if (!cancelled) setPreview(null);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, organisationId, invoiceId, gross, paidOn]);

  return (
    <Card>
      <h3 className="m-0 text-sm font-medium text-muted-foreground">
        Record payment — {invoice.vendorName} · {invoice.invoiceNumber}
      </h3>
      <p className="text-sm text-muted-foreground">
        Outstanding {formatInr(invoice.outstandingAmount)}
      </p>
      <Field>
        <label htmlFor="vendor-payment-gross">Gross amount</label>
        <NumericInput
          id="vendor-payment-gross"
          className="input"
          value={gross}
          onChange={(event) => {
            setGross(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="vendor-payment-date">Paid on</label>
        <input
          id="vendor-payment-date"
          className="input"
          type="date"
          value={paidOn}
          onChange={(event) => {
            setPaidOn(event.target.value);
          }}
        />
      </Field>
      <Field>
        <label htmlFor="vendor-payment-reference">Bank reference</label>
        <input
          id="vendor-payment-reference"
          className="input"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
      </Field>

      {preview !== null && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>Tax deducted at source</dt>
          <dd className="font-mono tabular-nums">
            {formatInr(preview.tdsAmount)}
            {preview.deductible
              ? ` at ${preview.rate}%`
              : ' — no threshold crossed yet'}
          </dd>
          <dt>Net to the vendor</dt>
          <dd className="font-mono tabular-nums">{formatInr(preview.netAmount)}</dd>
          {preview.provisionCitation !== null && (
            <>
              <dt>Provision</dt>
              <dd>{preview.provisionCitation}</dd>
            </>
          )}
          {preview.taxableBasis === 'aggregate_catch_up' && (
            <>
              <dt>Taxed on</dt>
              <dd>
                {formatInr(preview.taxableAmount)} — this payment carries the financial
                year past its threshold, so tax falls due on the whole aggregate, not
                just on this payment.
              </dd>
            </>
          )}
          {preview.panAbsentUplift && (
            <>
              <dt>PAN</dt>
              <dd>
                No PAN on record — deducted at {preview.rate}% instead of{' '}
                {preview.ordinaryRate}% under section 206AA.
              </dd>
            </>
          )}
        </dl>
      )}

      <Actions>
        <Button
          disabled={pending || gross.trim() === ''}
          onClick={() => {
            void onAct(async () => {
              await api.recordVendorPayment(organisationId, invoice.id, {
                paidOn,
                grossAmount: gross.trim(),
                ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
              });
              await onRecorded();
            }, `Payment recorded against ${invoice.invoiceNumber}.`);
          }}
        >
          Record payment
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </Actions>
    </Card>
  );
}
