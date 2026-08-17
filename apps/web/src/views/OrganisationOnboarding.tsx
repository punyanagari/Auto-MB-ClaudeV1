import type { Organisation } from '@auto-mb/contracts';
import { MailCheck, ShieldCheck } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { Card, CardHeader } from '../ui/card.js';
import { OrganisationCreateForm } from './OrganisationCreateForm.js';

interface OrganisationOnboardingProps {
  readonly api: ApiClient;
  readonly onCreated: (organisation: Organisation) => void;
}

/**
 * Only shown when /api/me and /api/organisations agree that the account has
 * no active Organisation membership. Existing users never see a creation
 * form merely because they signed in again.
 *
 * The mock's onboarding page (`app/onboarding/page` at fdfe5ef) is one
 * card in a narrow centred column, not a two-column marketing split. The
 * two reassurances this screen carries — what the tenant boundary means,
 * and what to do instead if an invitation already exists — follow the form
 * as a pair of plain panels rather than sitting opposite it, so the column
 * reads top to bottom on a phone the way it does on a desk.
 */
export function OrganisationOnboarding({
  api,
  onCreated,
}: OrganisationOnboardingProps) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <h1 tabIndex={-1} className="text-base font-semibold">
            Start your first workspace
          </h1>
        </CardHeader>
        <p className="m-0 mb-4 text-sm text-muted-foreground">
          This account is not currently an active member of an organisation. Create the
          legal entity that will own the Works, or ask an existing owner to add this
          account by email.
        </p>
        <OrganisationCreateForm api={api} onCreated={onCreated} />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="data-surface p-4">
          <span className="mb-3 inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <h2 className="m-0 text-sm font-medium">Tenant boundary first</h2>
          <p className="mt-2 mb-0 text-xs text-muted-foreground">
            The creator becomes the first owner. Data is isolated by membership,
            PostgreSQL row-level security and organisation-scoped transactions.
          </p>
        </div>
        <div className="data-surface p-4">
          <span className="mb-3 inline-flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
            <MailCheck className="size-4" aria-hidden="true" />
          </span>
          <h2 className="m-0 text-sm font-medium">Already invited?</h2>
          <p className="mt-2 mb-0 text-xs text-muted-foreground">
            Sign in with the exact invited email. Accepted active memberships appear
            automatically; disabled or unaccepted access is never offered here.
          </p>
        </div>
      </div>
    </div>
  );
}
