import type { Membership, Organisation } from '@auto-mb/contracts';
import { ArrowRight, BriefcaseBusiness, Building2, ShieldCheck } from 'lucide-react';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

interface OrgPickerProps {
  readonly organisations: readonly Organisation[];
  readonly memberships: readonly Membership[];
  readonly onSelect: (organisation: Organisation) => void;
}

const ROLE_LABELS: Record<Membership['role'], string> = {
  owner: 'Owner',
  office: 'Office',
  site: 'Site',
  viewer: 'Viewer',
};

/** Only rendered for two or more active Organisations. Creation belongs to
 * zero-state onboarding or the deliberate Settings action, never every login. */
export function OrgPicker({ organisations, memberships, onSelect }: OrgPickerProps) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
      <header className="mb-8 max-w-2xl">
        <p className="mb-2 text-xs font-semibold tracking-[0.16em] text-primary uppercase">
          Choose tenant
        </p>
        <h1 id="orgs-title" tabIndex={-1}>
          Select an organisation
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each organisation is a separate legal entity and data boundary. Your role,
          Work scope and explicit authorities are revalidated after selection and on
          every request.
        </p>
      </header>

      <section aria-labelledby="orgs-title" className="grid gap-4 md:grid-cols-2">
        {organisations.map((organisation) => {
          const membership = memberships.find(
            (candidate) =>
              candidate.organisationId === organisation.id &&
              candidate.status === 'active',
          );
          if (membership === undefined) return null;
          return (
            <article
              key={organisation.id}
              className="group flex min-h-52 flex-col rounded-2xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.03)] transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-lg"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Building2 className="size-5" aria-hidden="true" />
                </span>
                <Badge variant={membership.role === 'owner' ? 'info' : 'neutral'}>
                  {ROLE_LABELS[membership.role]}
                </Badge>
              </div>

              <div className="mt-5 min-w-0 flex-1">
                <h2 className="m-0 truncate text-base font-semibold">
                  {organisation.name}
                </h2>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {organisation.slug}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5">
                    <BriefcaseBusiness className="size-3.5" aria-hidden="true" />
                    {membership.workScope === 'all' ? 'All Works' : 'Assigned Works'}
                  </span>
                  {(membership.canIssueDocuments ||
                    membership.canCancelDocuments ||
                    membership.canManageStatutoryReporting) && (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5">
                      <ShieldCheck className="size-3.5" aria-hidden="true" />
                      Sensitive authority
                    </span>
                  )}
                </div>
              </div>

              <Button
                className="mt-5 w-full justify-between"
                onClick={() => {
                  onSelect(organisation);
                }}
              >
                Open workspace
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </article>
          );
        })}
      </section>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Only active memberships are shown. Selecting an organisation never bypasses its
        server-side permissions or PostgreSQL tenant boundary.
      </p>
    </div>
  );
}
