import { useEffect, useRef, useState } from 'react';
import type { OrganisationProfile } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formValue, RequestFailedError } from '../api.js';

interface SettingsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly isOwner: boolean;
}

/** Organisation settings: the company profile and logo that appear on
 * generated documents. Reads for every member; edits are owner-only. */
export function Settings({ api, organisationId, isOwner }: SettingsProps) {
  const [profile, setProfile] = useState<OrganisationProfile | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    Promise.all([api.organisationProfile(organisationId), api.logoBlob(organisationId)])
      .then(([loaded, blob]) => {
        if (cancelled) return;
        setProfile(loaded);
        if (blob !== null) {
          objectUrl = URL.createObjectURL(blob);
          setLogoUrl(objectUrl);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : 'Settings failed to load.',
          );
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, organisationId]);

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const optional = (name: string): string | null => {
      const value = formValue(data, name).trim();
      return value.length === 0 ? null : value;
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateOrganisationProfile(organisationId, {
        name: formValue(data, 'name').trim(),
        address: optional('address'),
        gstin: optional('gstin'),
        contactPhone: optional('contactPhone'),
        contactEmail: optional('contactEmail'),
      });
      setProfile(updated);
      setNotice('Company details saved.');
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'Saving the company details failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File) {
    const mediaType =
      file.type === 'image/png' || file.type === 'image/jpeg' ? file.type : null;
    if (mediaType === null) {
      setError('The logo must be a PNG or JPEG image.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.uploadLogo(organisationId, file, mediaType);
      setProfile(updated);
      setLogoUrl((current) => {
        if (current !== null) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      setNotice('Logo updated. It will appear on newly rendered documents.');
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError ? cause.message : 'Logo upload failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.removeLogo(organisationId);
      setProfile((current) => (current === null ? null : { ...current, hasLogo: false }));
      setLogoUrl((current) => {
        if (current !== null) URL.revokeObjectURL(current);
        return null;
      });
      setNotice('Logo removed.');
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError ? cause.message : 'Removing the logo failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (profile === null) {
    return (
      <section className="card">
        <h1 tabIndex={-1}>Settings</h1>
        {error === null ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="card card--narrow">
      <h1 tabIndex={-1}>Settings</h1>
      <p className="muted">
        These company details and the logo appear on Delivery Challans and other
        generated documents.
      </p>

      <h2>Logo</h2>
      <div className="logo-row">
        {logoUrl !== null ? (
          <img className="logo-preview" src={logoUrl} alt="Organisation logo" />
        ) : (
          <span className="muted">No logo uploaded.</span>
        )}
        {isOwner && (
          <div className="actions">
            <input
              ref={logoInputRef}
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Choose logo image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) void uploadLogo(file);
                event.currentTarget.value = '';
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => logoInputRef.current?.click()}
            >
              {profile.hasLogo ? 'Replace logo' : 'Upload logo'}
            </button>
            {profile.hasLogo && (
              <button
                type="button"
                className="button--ghost"
                disabled={busy}
                onClick={() => void removeLogo()}
              >
                Remove logo
              </button>
            )}
          </div>
        )}
      </div>
      <p className="hint">PNG or JPEG, up to 1 MB. Shown at the top of documents.</p>

      <h2>Company details</h2>
      {isOwner ? (
        <form onSubmit={(event) => void saveProfile(event)}>
          <div className="field">
            <label htmlFor="org-name">Company name</label>
            <input
              id="org-name"
              name="name"
              required
              minLength={2}
              maxLength={200}
              defaultValue={profile.name}
            />
          </div>
          <div className="field">
            <label htmlFor="org-address">Address</label>
            <textarea
              id="org-address"
              name="address"
              rows={3}
              maxLength={600}
              defaultValue={profile.address ?? ''}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="org-gstin">GSTIN</label>
              <input
                id="org-gstin"
                name="gstin"
                maxLength={15}
                pattern="[0-9A-Z]{15}"
                defaultValue={profile.gstin ?? ''}
              />
              <p className="hint">15 characters, as printed on GST records.</p>
            </div>
            <div className="field">
              <label htmlFor="org-phone">Phone</label>
              <input
                id="org-phone"
                name="contactPhone"
                maxLength={30}
                defaultValue={profile.contactPhone ?? ''}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="org-email">Email</label>
            <input
              id="org-email"
              name="contactEmail"
              type="email"
              maxLength={200}
              defaultValue={profile.contactEmail ?? ''}
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={busy}>
              Save company details
            </button>
          </div>
        </form>
      ) : (
        <dl className="fact-list">
          <div>
            <dt>Company name</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{profile.address ?? '—'}</dd>
          </div>
          <div>
            <dt>GSTIN</dt>
            <dd>{profile.gstin ?? '—'}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{profile.contactPhone ?? '—'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{profile.contactEmail ?? '—'}</dd>
          </div>
        </dl>
      )}

      {error !== null && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="form-notice">
          {notice}
        </p>
      )}
    </section>
  );
}
