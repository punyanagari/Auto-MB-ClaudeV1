import type { Organisation } from '@auto-mb/contracts';
import { Building2, Check, Plus } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { Badge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
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
    <Card aria-labelledby="organisation-access-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            Account-level access
          </p>
          <h2 id="organisation-access-title" className="m-0 text-lg">
            Organisations
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Each entry is a separate tenant and legal entity. Creating another does not
            add a company profile inside {currentOrganisation.name}.
          </p>
        </div>
        <Badge variant="neutral">{organisations.length} active</Badge>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {organisations.map((organisation) => {
          const current = organisation.id === currentOrganisation.id;
          return (
            <div
              key={organisation.id}
              className={`flex items-center gap-3 rounded-xl border p-4 ${
                current
                  ? 'border-primary/30 bg-primary/[0.035]'
                  : 'border-border bg-background/60'
              }`}
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Building2 className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{organisation.name}</strong>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {organisation.slug}
                </span>
              </span>
              {current && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <Check className="size-3.5" aria-hidden="true" />
                  Current
                </span>
              )}
            </div>
          );
        })}
      </div>

      {canCreate && (
        <Disclosure
          label="Create another organisation"
          className="mt-5"
          variant="outline"
        >
          <div className="max-w-2xl rounded-2xl border border-border bg-background/60 p-5">
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
