import { useEffect, useState } from 'react';
import type {
  Contact,
  OrganisationProfile,
  PaymentMatrixRow,
  WorkItem,
} from '@auto-mb/contracts';
import { CheckCircle, CircleAlert } from 'lucide-react';
import type { ApiClient } from '../api.js';
// The same names the matrix screen prints on its rows. This checklist
// tells the operator to go and add a row; naming it "Pure installation"
// while that screen shows "Purely installation" sends them looking for a
// row that is not there under that name.
import { missingOrganisationFacts } from '../lib/organisation-facts.js';
import { CATEGORY_LABELS } from '../lib/payment-matrix.js';
import { useReload } from '../lib/view-state.js';
import { mastersHash, SETTINGS_HASH, workHash } from '../lib/workspace-routes.js';
import { ErrorState, LoadingState } from '../ui/state.js';

interface WorkBillingReadinessProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
}

interface ChecklistItem {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** What is still missing, shown only while not ok. */
  readonly detail: string;
  readonly fix: { readonly label: string; readonly hash: string };
}

/** The buyer facts the invoice snapshot and IRP payload require —
 * mirrors the server's BUYER_PROFILE_INCOMPLETE check. */
function clientProfileComplete(contact: Contact): boolean {
  return (
    contact.address !== null &&
    contact.stateCode !== null &&
    contact.pincode !== null &&
    (contact.gstin === null || (contact.locality ?? null) !== null)
  );
}

/**
 * Whether this Work can reach a submitted GST invoice, answered before
 * the operator walks into the refusals: a payment matrix row for every
 * category the items use (or the MB will not finalize), a client
 * contact with complete statutory facts (or the invoice will not draft
 * or submit), and a complete organisation GST profile (or submit is
 * refused). Each unmet prerequisite links to the screen that fixes it.
 * Derived entirely from reads the app already exposes.
 */
export function WorkBillingReadiness({
  api,
  organisationId,
  workId,
  workItems,
}: WorkBillingReadinessProps) {
  const [matrix, setMatrix] = useState<readonly PaymentMatrixRow[] | null>(null);
  const [contacts, setContacts] = useState<readonly Contact[] | null>(null);
  const [profile, setProfile] = useState<OrganisationProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setMatrix(null);
    setContacts(null);
    setProfile(null);
    setFailed(false);
    Promise.all([
      api.getPaymentMatrix(organisationId, workId),
      api.listContacts(organisationId),
      api.organisationProfile(organisationId),
    ])
      .then(([matrixRows, contactRows, organisationProfile]) => {
        if (cancelled) return;
        setMatrix(matrixRows ?? []);
        setContacts(contactRows ?? []);
        // A stubbed or degraded client may resolve nothing; render the
        // failed state instead of crashing on a missing profile.
        if ((organisationProfile as OrganisationProfile | undefined) === undefined) {
          setFailed(true);
        } else {
          setProfile(organisationProfile);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  if (failed) {
    return (
      <section aria-labelledby="billing-readiness-heading">
        <h2 id="billing-readiness-heading">Billing readiness</h2>
        <ErrorState retryLabel="Retry readiness check" onRetry={retry}>
          The billing prerequisites could not be checked. Invoicing itself is unaffected
          — the server still verifies everything at submit.
        </ErrorState>
      </section>
    );
  }

  if (matrix === null || contacts === null || profile === null) {
    return (
      <section aria-labelledby="billing-readiness-heading">
        <h2 id="billing-readiness-heading">Billing readiness</h2>
        <LoadingState label="the billing prerequisites" rows={2} />
      </section>
    );
  }

  const usedCategories = [
    ...new Set(workItems.map((item) => item.paymentCategory ?? 'UNCATEGORISED')),
  ];
  const matrixCategories = new Set(matrix.map((row) => row.category as string));
  const missingCategories = usedCategories.filter(
    (category) => !matrixCategories.has(category),
  );

  const activeClients = contacts.filter(
    (contact) => contact.isClient && contact.active,
  );
  const completeClients = activeClients.filter(clientProfileComplete);
  const missingOrgFacts = missingOrganisationFacts(profile);

  const items: readonly ChecklistItem[] = [
    {
      key: 'matrix',
      label: 'Payment matrix covers every item category',
      ok: missingCategories.length === 0,
      detail: `No matrix row for: ${missingCategories
        .map((category) => CATEGORY_LABELS[category] ?? category)
        .join(', ')}. The Measurement Book cannot be finalized until the rows exist.`,
      fix: {
        label: 'Open the payment matrix',
        hash: workHash(workId, 'schedules'),
      },
    },
    {
      key: 'client',
      label: 'A client contact exists to invoice',
      ok: activeClients.length > 0,
      detail: 'Tax invoices name a client contact as the buyer; there is none yet.',
      fix: { label: 'Open Masters → Contacts', hash: mastersHash('contacts') },
    },
    {
      key: 'buyer-facts',
      label: 'Buyer statutory facts are complete',
      ok: activeClients.length > 0 && completeClients.length > 0,
      detail:
        activeClients.length === 0
          ? 'Add a client contact first — the invoice needs its address, state code and PIN.'
          : 'No client contact carries the full set: address, state code, PIN code (and locality when a GSTIN is recorded).',
      fix: { label: 'Complete the contact', hash: mastersHash('contacts') },
    },
    {
      key: 'org-gst',
      label: 'Organisation GST profile is complete',
      ok: missingOrgFacts.length === 0,
      detail: `The organisation profile is missing: ${missingOrgFacts.join(', ')}. Submit is refused without them.`,
      fix: { label: 'Open organisation settings', hash: SETTINGS_HASH },
    },
  ];

  const unmet = items.filter((item) => !item.ok);

  return (
    /* `.data-surface`, the mock's shared panel wrapper (docs/DESIGN.md
       § Component-layer conventions, ported from the mock at a8e1fde). */
    <section
      className="data-surface mt-4 flex flex-col gap-3 p-4"
      aria-labelledby="billing-readiness-heading"
    >
      <h2 id="billing-readiness-heading" className="m-0 text-sm font-medium">
        Billing readiness
      </h2>
      <p className="m-0 text-sm text-muted-foreground">
        {unmet.length === 0
          ? 'Every invoice prerequisite is in place.'
          : `${String(unmet.length)} of ${String(items.length)} prerequisites still need attention before an invoice can be submitted.`}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-[13px]">
            {item.ok ? (
              <CheckCircle
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
            ) : (
              /* Warning, not destructive. The mock's tint families put
                 "attention, in progress, awaiting someone" on warning and
                 reserve destructive for cancelled and rejected
                 (docs/DESIGN.md § Status badge semantics; the same pending
                 treatment the mock gives an unmet prerequisite in
                 Auto-MB-Vercel-du, components/measurement-book.tsx at
                 a8e1fde). An unfilled prerequisite is waiting on someone,
                 not refused. */
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-warning-foreground"
                aria-hidden="true"
              />
            )}
            <span>
              <span className="font-medium">{item.label}</span>
              <span className="sr-only">{item.ok ? ' — ready' : ' — not ready'}</span>
              {!item.ok && (
                <>
                  {' '}
                  <span className="text-muted-foreground">{item.detail}</span>{' '}
                  <a href={item.fix.hash}>{item.fix.label}</a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
