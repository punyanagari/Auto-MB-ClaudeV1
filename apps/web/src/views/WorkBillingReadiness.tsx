import { useEffect, useState } from 'react';
import type {
  Contact,
  OrganisationProfile,
  PaymentMatrixRow,
  WorkItem,
} from '@auto-mb/contracts';
import { CheckCircle, CircleAlert } from 'lucide-react';
import type { ApiClient } from '../api.js';
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

/** The seller facts the submit route refuses without — mirrors
 * ORG_STATE/GSTIN/ADDRESS/PINCODE/LOCALITY_REQUIRED. */
function missingOrganisationFacts(profile: OrganisationProfile): readonly string[] {
  return [
    ...((profile.stateCode ?? null) === null ? ['GST state code'] : []),
    ...(profile.gstin === null ? ['GSTIN'] : []),
    ...(profile.address === null ? ['address'] : []),
    ...((profile.pincode ?? null) === null ? ['PIN code'] : []),
    ...((profile.locality ?? null) === null ? ['locality'] : []),
  ];
}

const CATEGORY_LABELS: Record<string, string> = {
  SUPPLY: 'Supply',
  SUPPLY_AND_INSTALLATION: 'Supply and installation',
  PURE_INSTALLATION: 'Pure installation',
  SPARE_SUPPLY: 'Spare supply',
  UNCATEGORISED: 'Uncategorised',
};

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
  const [loadVersion, setLoadVersion] = useState(0);

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
        <ErrorState
          retryLabel="Retry readiness check"
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
        >
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
    <section aria-labelledby="billing-readiness-heading">
      <h2 id="billing-readiness-heading">Billing readiness</h2>
      <p className="text-muted-foreground">
        {unmet.length === 0
          ? 'Every invoice prerequisite is in place.'
          : `${String(unmet.length)} of ${String(items.length)} prerequisites still need attention before an invoice can be submitted.`}
      </p>
      <ul className="my-2 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-[13px]">
            {item.ok ? (
              <CheckCircle
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-destructive"
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
