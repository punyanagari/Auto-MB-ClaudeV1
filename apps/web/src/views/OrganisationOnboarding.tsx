import type { Organisation } from '@auto-mb/contracts';
import { Building2, MailCheck, ShieldCheck } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { Card } from '../ui/card.js';
import { OrganisationCreateForm } from './OrganisationCreateForm.js';

interface OrganisationOnboardingProps {
  readonly api: ApiClient;
  readonly onCreated: (organisation: Organisation) => void;
}

/** Only shown when /api/me and /api/organisations agree that the account has
 * no active Organisation membership. Existing users never see a creation
 * form merely because they signed in again. */
export function OrganisationOnboarding({
  api,
  onCreated,
}: OrganisationOnboardingProps) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)] lg:px-8 lg:py-16">
      <section className="flex flex-col justify-center">
        <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
          Organisation access
        </p>
        <h1 tabIndex={-1}>Start your first workspace</h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          This account is not currently an active member of an organisation. Create the
          legal entity that will own the Works, or ask an existing owner to add this
          account by email.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5">
            <span className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <h2 className="m-0 text-sm font-semibold">Tenant boundary first</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The creator becomes the first owner. Data is isolated by membership,
              PostgreSQL row-level security and organisation-scoped transactions.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <span className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              <MailCheck className="size-5" aria-hidden="true" />
            </span>
            <h2 className="m-0 text-sm font-semibold">Already invited?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in with the exact invited email. Accepted active memberships appear
              automatically; disabled or unaccepted access is never offered here.
            </p>
          </div>
        </div>
      </section>

      <Card className="self-start" aria-labelledby="create-organisation-title">
        <span className="mb-4 inline-flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Building2 className="size-5" aria-hidden="true" />
        </span>
        <h2 id="create-organisation-title" className="mt-0 text-lg">
          Create an organisation
        </h2>
        <p className="text-sm text-muted-foreground">
          Use the legal entity name that should appear on generated documents.
        </p>
        <OrganisationCreateForm api={api} onCreated={onCreated} />
      </Card>
    </div>
  );
}
