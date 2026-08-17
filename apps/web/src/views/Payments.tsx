import { useCallback, useEffect, useState } from 'react';
import type {
  PaymentRequest,
  PaymentRequestKind,
  TdsPreviewResponse,
  VendorInvoice,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import {
  navigateOnClick,
  paymentsHash,
  type PaymentsRegisterTab,
} from '../lib/workspace-routes.js';
import { formatDate, formatInr } from '../format.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Actions, Field, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { describeLoadFailure } from '../lib/load-failure.js';

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
};

const STATUS_LABELS: Record<PaymentRequest['status'], string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
  settled: 'Settled',
};

/** The signal lamp each status lights, in the mock's badge vocabulary. */
const STATUS_TONES: Record<PaymentRequest['status'], string> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'info',
  rejected: 'danger',
  paid: 'info',
  settled: 'success',
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
  const [blocked, setBlocked] = useState<readonly string[]>([]);
  const [invoices, setInvoices] = useState<readonly VendorInvoice[] | null>(null);
  const [totals, setTotals] = useState<{
    outstanding: string;
    overdue: number;
  } | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [vendorsError, setVendorsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const loadRequests = useCallback(async () => {
    setRequestsError(null);
    setRequests(null);
    try {
      const payload = await api.listPaymentRequests(organisationId);
      setRequests(payload.requests);
      setBlocked(payload.beneficiariesWithBillsDue);
    } catch (error) {
      setRequestsError(describeLoadFailure(error, 'Payment requests').message);
    }
  }, [api, organisationId]);

  const loadVendors = useCallback(async () => {
    setVendorsError(null);
    setInvoices(null);
    try {
      const payload = await api.listVendorInvoices(organisationId);
      setInvoices(payload.invoices);
      setTotals({
        outstanding: payload.totalOutstanding,
        overdue: payload.overdueCount,
      });
    } catch (error) {
      setVendorsError(describeLoadFailure(error, 'Vendor invoices').message);
    }
  }, [api, organisationId]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);

  const act = useCallback(async (run: () => Promise<void>, success: string) => {
    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      await run();
      setNotice(success);
    } catch (error) {
      setFormError(
        error instanceof RequestFailedError
          ? error.message
          : 'The action could not be completed.',
      );
    } finally {
      setPending(false);
    }
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
      />

      <div className="stat-row">
        <Stat
          label="Awaiting approval"
          value={String(awaitingDecision.length)}
          hint="Employee requests"
        />
        <Stat
          label="Advances open"
          value={String(openAdvances.length)}
          hint="Final bills due"
          {...(openAdvances.length > 0 ? { tone: 'warning' as const } : {})}
        />
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

      {tab === 'employee' ? (
        <section aria-label="Employee payment requests">
          <EmployeeRegister
            api={api}
            organisationId={organisationId}
            currentUserId={currentUserId}
            canManagePayments={canManagePayments}
            requests={requests}
            blocked={blocked}
            error={requestsError}
            pending={pending}
            onRetry={() => {
              void loadRequests();
            }}
            onAct={act}
            onReload={loadRequests}
          />
        </section>
      ) : (
        <section aria-label="Vendor ledger">
          <VendorRegister
            api={api}
            organisationId={organisationId}
            canManagePayments={canManagePayments}
            canCancel={canCancel}
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

interface RegisterShared {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canManagePayments: boolean;
  readonly error: string | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
  readonly onReload: () => Promise<void>;
}

function EmployeeRegister({
  api,
  organisationId,
  currentUserId,
  canManagePayments,
  requests,
  blocked,
  error,
  pending,
  onRetry,
  onAct,
  onReload,
}: RegisterShared & {
  readonly currentUserId: string;
  readonly requests: readonly PaymentRequest[] | null;
  readonly blocked: readonly string[];
}) {
  if (error !== null) {
    return (
      <ErrorState onRetry={onRetry} retryLabel="Retry payment requests">
        {error}
      </ErrorState>
    );
  }
  if (requests === null) return <LoadingState label="Loading payment requests" />;
  if (requests.length === 0) {
    return <EmptyState>No advance or reimbursement has been raised yet.</EmptyState>;
  }

  const openAdvances = requests.filter((request) => request.billsDue);

  return (
    <>
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
              <td className={wrapCell}>{request.purpose}</td>
              <td className={numericCell}>{formatInr(request.amount)}</td>
              <td>
                <span className={`lamp lamp-${STATUS_TONES[request.status]}`} />
                {STATUS_LABELS[request.status]}
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
                          await api.decidePaymentRequest(organisationId, request.id, {
                            decision: 'approve',
                          });
                          await onReload();
                        }, `${request.requestNumber} approved.`);
                      }}
                    >
                      Approve
                    </Button>
                  )}
                {canManagePayments && request.billsDue && (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      void onAct(async () => {
                        await api.recordAdvanceBills(organisationId, request.id, {});
                        await onReload();
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
      {blocked.length > 0 && (
        <p className="sr-only">
          {String(blocked.length)} beneficiaries cannot be given a new advance.
        </p>
      )}
    </>
  );
}

function VendorRegister({
  api,
  organisationId,
  canManagePayments,
  canCancel,
  invoices,
  error,
  pending,
  onRetry,
  onAct,
  onReload,
}: RegisterShared & {
  readonly canCancel: boolean;
  readonly invoices: readonly VendorInvoice[] | null;
}) {
  const [paying, setPaying] = useState<string | null>(null);

  if (error !== null) {
    return (
      <ErrorState onRetry={onRetry} retryLabel="Retry vendor ledger">
        {error}
      </ErrorState>
    );
  }
  if (invoices === null) return <LoadingState label="Loading vendor ledger" />;
  if (invoices.length === 0) {
    return <EmptyState>No vendor invoice has been recorded yet.</EmptyState>;
  }

  return (
    <>
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
          {invoices.map((invoice) => (
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
              <td className={numericCell}>{formatInr(invoice.outstandingAmount)}</td>
              <td>
                {invoice.tdsSection ?? '—'}
                {invoice.payments.some((payment) => payment.panAbsent) && (
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
                        setPaying(paying === invoice.id ? null : invoice.id);
                      }}
                    >
                      Record payment
                    </Button>
                  )}
                {canCancel &&
                  invoice.cancelledAt === null &&
                  invoice.payments.every((payment) => payment.voidedAt !== null) && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void onAct(async () => {
                          await api.cancelVendorInvoice(organisationId, invoice.id, {
                            reason: 'Cancelled from the vendor ledger',
                          });
                          await onReload();
                        }, `${invoice.invoiceNumber} cancelled.`);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {paying !== null && (
        <VendorPaymentForm
          api={api}
          organisationId={organisationId}
          invoice={invoices.find((invoice) => invoice.id === paying) ?? null}
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
    </>
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
  readonly invoice: VendorInvoice | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onRecorded: () => Promise<void>;
  readonly onAct: (run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [gross, setGross] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<TdsPreviewResponse | null>(null);

  const invoiceId = invoice?.id ?? null;

  useEffect(() => {
    if (invoiceId === null || gross.trim() === '') {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.previewVendorTds(
          organisationId,
          invoiceId,
          gross.trim(),
          paidOn,
        );
        if (!cancelled) setPreview(result);
      } catch {
        // A failed preview is not a failed payment: the server computes
        // the authoritative split again when the payment is recorded, so
        // the form stays usable and simply shows no estimate.
        if (!cancelled) setPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, invoiceId, gross, paidOn]);

  if (invoice === null) return null;

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
        <input
          id="vendor-payment-gross"
          className="input"
          inputMode="decimal"
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
        <dl className="tds-preview">
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
