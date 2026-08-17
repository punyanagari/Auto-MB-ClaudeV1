import type { Membership, Organisation } from '@auto-mb/contracts';
import { ArrowRight, BriefcaseBusiness, Building2, ShieldCheck } from 'lucide-react';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';

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

/**
 * Only rendered for two or more active Organisations. Creation belongs to
 * zero-state onboarding or the deliberate Settings action, never every login.
 *
 * The mock draws the chooser as one card of stacked rows inside the
 * sign-in column (`app/sign-in/page` at fdfe5ef, the `organisation` step),
 * not as a wide grid of tiles on a page of its own. Each row carries more
 * than the mock's two lines because more is true here — the membership's
 * role, its Work scope and whether it holds a sensitive authority are what
 * an operator is actually choosing between — so the extra facts are built
 * inside the mock's row rather than beside it.
 */
export function OrgPicker({ organisations, memberships, onSelect }: OrgPickerProps) {
  return (
    <Card>
      <CardHeader>
        <h1 id="orgs-title" tabIndex={-1} className="text-base font-semibold">
          Select an organisation
        </h1>
      </CardHeader>

      <p className="m-0 text-sm text-muted-foreground">
        Each organisation is a separate legal entity and data boundary. Your role, Work
        scope and explicit authorities are revalidated after selection and on every
        request.
      </p>

      <div className="mt-4 flex flex-col gap-3">
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
              className="flex flex-col gap-3 rounded-lg border border-border p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-start gap-3">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Building2 className="size-4" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <h2 className="m-0 truncate text-sm font-medium">
                      {organisation.name}
                    </h2>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {organisation.slug}
                    </span>
                  </span>
                </span>
                <Badge variant={membership.role === 'owner' ? 'info' : 'neutral'}>
                  {ROLE_LABELS[membership.role]}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
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

              <Button
                className="w-full justify-between"
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
      </div>

      <p className="mt-4 mb-0 text-xs text-muted-foreground">
        Only active memberships are shown. Selecting an organisation never bypasses its
        server-side permissions or PostgreSQL tenant boundary.
      </p>
    </Card>
  );
}
