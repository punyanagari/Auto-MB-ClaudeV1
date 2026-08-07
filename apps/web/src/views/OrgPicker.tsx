import { useEffect, useState, type FormEvent } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';

interface OrgPickerProps {
  readonly api: ApiClient;
  readonly onSelect: (organisation: Organisation) => void;
  readonly onCreated: (organisation: Organisation) => void;
}

export function OrgPicker({ api, onSelect, onCreated }: OrgPickerProps) {
  const [organisations, setOrganisations] = useState<readonly Organisation[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listOrganisations()
      .then((loaded) => {
        if (!cancelled) setOrganisations(loaded);
      })
      .catch(() => {
        if (!cancelled) setOrganisations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = formValue(data, 'name');
    const slug = formValue(data, 'slug');

    setPending(true);
    setError(null);
    try {
      const organisation = await api.createOrganisation({ name, slug });
      onCreated(organisation);
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card card--narrow" aria-labelledby="orgs-title">
      <h1 id="orgs-title" tabIndex={-1}>
        Select an organisation
      </h1>

      {organisations === null ? (
        <p className="muted" role="status">
          Loading organisations…
        </p>
      ) : organisations.length > 0 ? (
        <ul className="org-list">
          {organisations.map((organisation) => (
            <li key={organisation.id}>
              <button
                type="button"
                className="org-list__item"
                onClick={() => {
                  onSelect(organisation);
                }}
              >
                <span className="org-list__name">{organisation.name}</span>
                <span className="muted">{organisation.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          You are not a member of any organisation yet. Create one, or ask an owner to
          add you by your account email.
        </p>
      )}

      <h2>Create an organisation</h2>
      <form onSubmit={(event) => void create(event)}>
        <div className="field">
          <label htmlFor="org-name">Organisation name</label>
          <input
            id="org-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="org-slug">Short identifier</label>
          <input
            id="org-slug"
            name="slug"
            type="text"
            required
            pattern="[a-z0-9][a-z0-9-]{1,62}"
            aria-describedby="org-slug-hint"
          />
          <p id="org-slug-hint" className="hint">
            Lowercase letters, digits, and hyphens; for example “sharma-constructions”.
          </p>
        </div>

        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create organisation'}
          </button>
        </div>
      </form>
    </section>
  );
}
