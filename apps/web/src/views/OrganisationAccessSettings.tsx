import type { Organisation } from '@auto-mb/contracts';
import { Building2, Plus } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { Badge } from '../ui/badge.js';
import { Card, CardHeader } from '../ui/card.js';
import { Disclosure } from '../ui/disclosure.js';
import { OrganisationCreateForm } from './OrganisationCreateForm.js';

interface OrganisationAccessSettingsProps {
  readonly api: ApiClient;
  readonly currentOrganisation: Organisation;
  readonly organisations: readonly Organisation[];
  readonly canCreate: boolean;
  readonly onCreated: (organisation: Organisation) => void;
}

/** Account-level tenant management placed beside Organisation settings, but
 * kept visually distinct from the current legal entity's profile. */
export function OrganisationAccessSettings({
  api,
  currentOrganisation,
  organisations,
  canCreate,
  onCreated,
}: OrganisationAccessSettingsProps) {
  return (
    <Card
      className="mx-auto w-full max-w-4xl"
      aria-labelledby="organisation-access-title"
    >
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2
            id="organisation-access-title"
            className="m-0 text-base leading-snug font-medium"
          >
            Organisations
          </h2>
          <p className="text-sm text-muted-foreground">
            Account-level access. Each entry is a separate tenant and legal entity;
            creating another does not add a company profile inside{' '}
            {currentOrganisation.name}.
          </p>
        </div>
        <Badge variant="neutral">{organisations.length} active</Badge>
      </CardHeader>

      {/* The mock's tenant list (`app/settings/page` at fdfe5ef): a
       * vertical stack of `rounded-lg border px-4 py-3` rows, each led by
       * a 36px accent monogram and ending in the "Current" mark. The
       * earlier two-column grid is retired with it. */}
      <div className="flex flex-col gap-3">
        {organisations.map((organisation) => {
          const current = organisation.id === currentOrganisation.id;
          return (
            <div
              key={organisation.id}
              /* `flex-wrap` is the 320px fix: the name, the slug and the
                 "Current" mark on one unbreakable line gave this row a
                 300px minimum, and the Settings page inherited it. Below
                 about 290px the mark drops to its own line instead of
                 taking the page sideways. */
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <Building2 className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {organisation.name}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {organisation.slug}
                  </span>
                </span>
              </span>
              {current && <Badge variant="neutral">Current</Badge>}
            </div>
          );
        })}
      </div>

      {canCreate && (
        <Disclosure
          label="Create another organisation"
          className="mt-4"
          variant="outline"
        >
          <div className="max-w-2xl rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Plus className="size-4 text-primary" aria-hidden="true" />
              New legal entity workspace
            </div>
            <OrganisationCreateForm
              api={api}
              onCreated={onCreated}
              submitLabel="Create and open organisation"
            />
          </div>
        </Disclosure>
      )}
    </Card>
  );
}
