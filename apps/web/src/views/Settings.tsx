import { useEffect, useRef, useState } from 'react';
import type { OrganisationProfile } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formValue, RequestFailedError } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Field, FieldRow, Actions, FormError, FormNotice, Hint } from '../ui/form.js';

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
  /** The STATE_CODE_GSTIN_MISMATCH refusal, shown against the field that
   * caused it rather than at the bottom of the form. */
  const [stateCodeError, setStateCodeError] = useState<string | null>(null);
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
          setError(cause instanceof Error ? cause.message : 'Settings failed to load.');
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
    setStateCodeError(null);
    setNotice(null);
    try {
      const updated = await api.updateOrganisationProfile(organisationId, {
        name: formValue(data, 'name').trim(),
        address: optional('address'),
        gstin: optional('gstin'),
        stateCode: optional('stateCode'),
        contactPhone: optional('contactPhone'),
        contactEmail: optional('contactEmail'),
        warrantyTemplateText: optional('warrantyTemplateText'),
      });
      setProfile(updated);
      setNotice('Company details saved.');
    } catch (cause) {
      if (
        cause instanceof RequestFailedError &&
        cause.code === 'STATE_CODE_GSTIN_MISMATCH'
      ) {
        // The server names which two values contradict; put that answer on
        // the state-code field itself so the operator corrects in place.
        setStateCodeError(cause.message);
      } else {
        setError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'Saving the company details failed.',
        );
      }
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
      setProfile((current) =>
        current === null ? null : { ...current, hasLogo: false },
      );
      setLogoUrl((current) => {
        if (current !== null) URL.revokeObjectURL(current);
        return null;
      });
      setNotice('Logo removed.');
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'Removing the logo failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (profile === null) {
    return (
      <Card>
        <h1 tabIndex={-1}>Settings</h1>
        {error === null ? (
          <p className="text-muted-foreground" role="status">
            Loading…
          </p>
        ) : (
          <FormError>{error}</FormError>
        )}
      </Card>
    );
  }

  return (
    <Card className="mx-auto mt-[10vh] mb-8 max-w-[26rem]">
      <h1 tabIndex={-1}>Settings</h1>
      <p className="text-muted-foreground">
        These company details and the logo appear on Delivery Challans and other
        generated documents.
      </p>

      <h2>Logo</h2>
      <div className="my-3 flex flex-wrap items-center gap-4">
        {logoUrl !== null ? (
          <img
            className="max-h-18 max-w-48 rounded-md border border-border bg-card p-2"
            src={logoUrl}
            alt="Organisation logo"
          />
        ) : (
          <span className="text-muted-foreground">No logo uploaded.</span>
        )}
        {isOwner && (
          <Actions>
            <input
              ref={logoInputRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Choose logo image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) void uploadLogo(file);
                event.currentTarget.value = '';
              }}
            />
            <Button disabled={busy} onClick={() => logoInputRef.current?.click()}>
              {profile.hasLogo ? 'Replace logo' : 'Upload logo'}
            </Button>
            {profile.hasLogo && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void removeLogo()}
              >
                Remove logo
              </Button>
            )}
          </Actions>
        )}
      </div>
      <Hint>PNG or JPEG, up to 1 MB. Shown at the top of documents.</Hint>

      <h2>Company details</h2>
      {isOwner ? (
        <form onSubmit={(event) => void saveProfile(event)}>
          <Field>
            <label htmlFor="org-name">Company name</label>
            <input
              id="org-name"
              name="name"
              required
              minLength={2}
              maxLength={200}
              defaultValue={profile.name}
            />
          </Field>
          <Field>
            <label htmlFor="org-address">Address</label>
            <textarea
              id="org-address"
              name="address"
              rows={3}
              maxLength={600}
              defaultValue={profile.address ?? ''}
            />
          </Field>
          <FieldRow>
            <Field>
              <label htmlFor="org-gstin">GSTIN</label>
              <input
                id="org-gstin"
                name="gstin"
                maxLength={15}
                pattern="[0-9A-Z]{15}"
                defaultValue={profile.gstin ?? ''}
              />
              <Hint>15 characters, as printed on GST records.</Hint>
            </Field>
            <Field>
              <label htmlFor="org-state-code">GST state code</label>
              <input
                id="org-state-code"
                name="stateCode"
                maxLength={2}
                pattern="[0-9]{2}"
                inputMode="numeric"
                defaultValue={profile.stateCode ?? ''}
                aria-invalid={stateCodeError !== null ? true : undefined}
                aria-describedby={
                  stateCodeError !== null
                    ? 'org-state-code-error'
                    : 'org-state-code-hint'
                }
              />
              <Hint id="org-state-code-hint">
                Two digits; must match the first two of the GSTIN. It decides CGST+SGST
                against IGST on tax invoices.
              </Hint>
              {stateCodeError !== null && (
                <FormError id="org-state-code-error">{stateCodeError}</FormError>
              )}
            </Field>
          </FieldRow>
          <FieldRow>
            <Field>
              <label htmlFor="org-phone">Phone</label>
              <input
                id="org-phone"
                name="contactPhone"
                maxLength={30}
                defaultValue={profile.contactPhone ?? ''}
              />
            </Field>
            <Field>
              <label htmlFor="org-email">Email</label>
              <input
                id="org-email"
                name="contactEmail"
                type="email"
                maxLength={200}
                defaultValue={profile.contactEmail ?? ''}
              />
            </Field>
          </FieldRow>
          <Field>
            <label htmlFor="org-warranty-template">Warranty agreement template</label>
            <textarea
              id="org-warranty-template"
              name="warrantyTemplateText"
              rows={6}
              maxLength={20000}
              defaultValue={profile.warrantyTemplateText ?? ''}
            />
            <Hint>
              Used by upcoming warranty documents; leave empty until you have your
              standard wording.
            </Hint>
          </Field>
          <Actions>
            <Button type="submit" disabled={busy}>
              Save company details
            </Button>
          </Actions>
        </form>
      ) : (
        <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
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
            <dt>GST state code</dt>
            <dd>{profile.stateCode ?? '—'}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{profile.contactPhone ?? '—'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{profile.contactEmail ?? '—'}</dd>
          </div>
          <div>
            <dt>Warranty template</dt>
            <dd>{profile.warrantyTemplateText ?? '—'}</dd>
          </div>
        </dl>
      )}

      {error !== null && <FormError>{error}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
    </Card>
  );
}
