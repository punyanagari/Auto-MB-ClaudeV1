import { useState, type FormEvent } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { Building2, Plus } from 'lucide-react';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';

interface OrganisationCreateFormProps {
  readonly api: ApiClient;
  readonly onCreated: (organisation: Organisation) => void;
  readonly submitLabel?: string;
}

/** Creating an Organisation creates a new tenant and legal-entity boundary;
 * it is deliberately separate from the ordinary sign-in/selection flow. */
export function OrganisationCreateForm({
  api,
  onCreated,
  submitLabel = 'Create organisation',
}: OrganisationCreateFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = formValue(data, 'name').trim();
    const slug = formValue(data, 'slug').trim().toLowerCase();

    setPending(true);
    setError(null);
    try {
      const organisation = await api.createOrganisation({ name, slug });
      onCreated(organisation);
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The organisation could not be created. Check the connection and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void create(event)} noValidate>
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.035] p-4">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Building2 className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="font-medium">A separate legal entity and tenant</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Its Works, members, numbering, documents and audit history remain isolated
            from every other organisation.
          </p>
        </div>
      </div>

      <Field className="max-w-none">
        <label htmlFor="new-organisation-name">Legal organisation name</label>
        <input
          id="new-organisation-name"
          name="name"
          type="text"
          autoComplete="organization"
          required
          minLength={2}
          maxLength={200}
          placeholder="Sharma Engineering Private Limited"
        />
      </Field>
      <Field className="max-w-none">
        <label htmlFor="new-organisation-slug">Workspace identifier</label>
        <input
          id="new-organisation-slug"
          name="slug"
          type="text"
          required
          pattern="[a-z0-9][a-z0-9-]{1,62}"
          aria-describedby="new-organisation-slug-hint"
          placeholder="sharma-engineering"
        />
        <Hint id="new-organisation-slug-hint">
          Lowercase letters, digits and hyphens. This is an internal workspace identity;
          it does not replace the legal name.
        </Hint>
      </Field>

      {error !== null && <FormError>{error}</FormError>}

      <Actions>
        <Button type="submit" disabled={pending}>
          <Plus className="size-4" aria-hidden="true" />
          {pending ? 'Creating…' : submitLabel}
        </Button>
      </Actions>
    </form>
  );
}
