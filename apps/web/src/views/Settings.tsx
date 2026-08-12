import { useEffect, useRef, useState } from 'react';
import type {
  EinvoiceApplicability,
  NumberSeries,
  NumberedDocumentType,
  OrganisationProfile,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formValue, RequestFailedError } from '../api.js';
import { formatDate } from '../format.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Field, FieldRow, Actions, FormError, FormNotice, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { DataTable } from '../ui/table.js';

/** What each configurable document is called on screen. */
const SERIES_LABELS: Record<NumberedDocumentType, string> = {
  delivery_challan: 'Delivery Challan',
  issue_challan: 'Issue Challan',
  tax_invoice: 'Tax Invoice',
  budgetary_quotation: 'Budgetary Quotation',
  credit_note: 'Credit Note',
};

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
  /** Null while loading — distinct from "none configured", which the
   * server reports as four rows carrying the product defaults. */
  const [series, setSeries] = useState<readonly NumberSeries[] | null>(null);
  const [seriesType, setSeriesType] = useState<NumberedDocumentType>('tax_invoice');
  /** Drives which declaration fields the e-invoicing form shows; the
   * applicable-from date and the window exist only while applicable. */
  const [einvoiceChoice, setEinvoiceChoice] =
    useState<EinvoiceApplicability>('undeclared');
  const logoInputRef = useRef<HTMLInputElement>(null);

  async function saveSeries(documentType: NumberedDocumentType, template: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.setNumberSeries(organisationId, documentType, {
        template,
      });
      setSeries((current) =>
        (current ?? []).map((row) => (row.documentType === documentType ? saved : row)),
      );
      setNotice(
        `${SERIES_LABELS[documentType]} numbers will now look like ${template}.`,
      );
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The format was not saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function clearSeries(documentType: NumberedDocumentType) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const restored = await api.clearNumberSeries(organisationId, documentType);
      setSeries((current) =>
        (current ?? []).map((row) =>
          row.documentType === documentType ? restored : row,
        ),
      );
      setNotice(
        `${SERIES_LABELS[documentType]} numbers follow the default again. Nothing already issued is renumbered.`,
      );
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The default was not restored.',
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Read separately from the profile: a number series that fails to
    // load must not blank the company details, which is the screen's
    // main job.
    api
      .listNumberSeries(organisationId)
      .then((loaded) => {
        if (!cancelled) setSeries(loaded);
      })
      .catch(() => {
        if (!cancelled) setSeries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    Promise.all([api.organisationProfile(organisationId), api.logoBlob(organisationId)])
      .then(([loaded, blob]) => {
        if (cancelled) return;
        setProfile(loaded);
        setEinvoiceChoice(loaded.einvoiceApplicability ?? 'undeclared');
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
        pincode: optional('pincode'),
        locality: optional('locality'),
        tradeName: optional('tradeName'),
        msmeNumber: optional('msmeNumber'),
        invoiceNumberPrefix: optional('invoiceNumberPrefix'),
        invoiceNotes: optional('invoiceNotes'),
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

  /** The e-invoicing declaration travels as three profile fields; a
   * non-applicable declaration clears the date and window with it, so
   * the stored trio always matches what the 0049 CHECK accepts. */
  async function saveEinvoiceDeclaration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const applicability = formValue(
      data,
      'einvoice-applicability',
    ) as EinvoiceApplicability;
    const applicableFrom = formValue(data, 'einvoice-applicable-from').trim();
    const windowDays = formValue(data, 'einvoice-window-days').trim();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateOrganisationProfile(organisationId, {
        einvoiceApplicability: applicability,
        einvoiceApplicableFrom:
          applicability === 'applicable' && applicableFrom !== ''
            ? applicableFrom
            : null,
        irpReportingWindowDays:
          applicability === 'applicable' && windowDays !== ''
            ? Number(windowDays)
            : null,
      });
      setProfile(updated);
      setEinvoiceChoice(updated.einvoiceApplicability ?? 'undeclared');
      setNotice(
        applicability === 'applicable'
          ? 'E-invoicing declared applicable. New invoices freeze their IRP reporting deadline at submit; nothing already issued changes.'
          : applicability === 'not_applicable'
            ? 'E-invoicing declared not applicable. The IRP transport is refused until the declaration changes.'
            : 'E-invoicing declaration cleared. The IRP transport stays refused until it is declared.',
      );
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The e-invoicing declaration was not saved.',
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
              <label htmlFor="org-pincode">PIN code</label>
              <input
                id="org-pincode"
                name="pincode"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                defaultValue={profile.pincode ?? ''}
              />
              <Hint>Six digits, stored separately for statutory payloads.</Hint>
            </Field>
            <Field>
              <label htmlFor="org-locality">Locality / city</label>
              <input
                id="org-locality"
                name="locality"
                minLength={2}
                maxLength={100}
                defaultValue={profile.locality ?? ''}
              />
              <Hint>Exact NIC seller locality. Never guessed from the address.</Hint>
            </Field>
          </FieldRow>
          <FieldRow>
            <Field>
              <label htmlFor="org-trade-name">Trade name</label>
              <input
                id="org-trade-name"
                name="tradeName"
                minLength={2}
                maxLength={200}
                defaultValue={profile.tradeName ?? ''}
              />
            </Field>
            <Field>
              <label htmlFor="org-msme-number">Udyam / MSME number</label>
              <input
                id="org-msme-number"
                name="msmeNumber"
                defaultValue={profile.msmeNumber ?? ''}
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field>
              <label htmlFor="org-invoice-prefix">Tax invoice prefix</label>
              <input
                id="org-invoice-prefix"
                name="invoiceNumberPrefix"
                maxLength={20}
                defaultValue={profile.invoiceNumberPrefix ?? ''}
              />
            </Field>
            <Field>
              <label htmlFor="org-invoice-notes">Default invoice notes</label>
              <textarea
                id="org-invoice-notes"
                name="invoiceNotes"
                rows={2}
                maxLength={4000}
                defaultValue={profile.invoiceNotes ?? ''}
              />
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
        <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
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
            <dt>PIN / locality</dt>
            <dd>
              {[profile.pincode, profile.locality].filter(Boolean).join(' · ') || '—'}
            </dd>
          </div>
          <div>
            <dt>Trade name</dt>
            <dd>{profile.tradeName ?? '—'}</dd>
          </div>
          <div>
            <dt>MSME number</dt>
            <dd>{profile.msmeNumber ?? '—'}</dd>
          </div>
          <div>
            <dt>Invoice prefix</dt>
            <dd>{profile.invoiceNumberPrefix ?? '—'}</dd>
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

      <h2>E-invoicing</h2>
      <p className="text-muted-foreground">
        Whether invoices must be reported to the IRP. E-invoicing is mandatory once
        aggregate turnover has ever crossed ₹5 crore, permanently; from 1 April 2025,
        taxpayers at ₹10 crore or more cannot report an invoice more than 30 days after
        its date. Each invoice freezes its reporting deadline when it is submitted, and
        nothing is ever sent automatically.
      </p>
      {isOwner ? (
        <form onSubmit={(event) => void saveEinvoiceDeclaration(event)}>
          <Field>
            <label htmlFor="einvoice-applicability">Declaration</label>
            <select
              id="einvoice-applicability"
              name="einvoice-applicability"
              value={einvoiceChoice}
              onChange={(event) => {
                setEinvoiceChoice(event.target.value as EinvoiceApplicability);
              }}
            >
              <option value="undeclared">Not yet declared</option>
              <option value="not_applicable">
                Not applicable — turnover has never crossed ₹5 crore
              </option>
              <option value="applicable">
                Applicable — turnover has crossed ₹5 crore
              </option>
            </select>
            <Hint>
              The IRP transport is refused until this is declared, and refused under
              “not applicable” — voluntary registration below the mandate is not
              provided for.
            </Hint>
          </Field>
          {einvoiceChoice === 'applicable' && (
            <FieldRow>
              <Field>
                <label htmlFor="einvoice-applicable-from">Applicable from</label>
                <input
                  id="einvoice-applicable-from"
                  name="einvoice-applicable-from"
                  type="date"
                  required
                  defaultValue={profile.einvoiceApplicableFrom ?? ''}
                />
                <Hint>
                  The date e-invoicing became mandatory for you. Invoices dated before
                  it carry no reporting deadline.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="einvoice-window-days">
                  IRP reporting window (days)
                </label>
                <input
                  id="einvoice-window-days"
                  name="einvoice-window-days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  defaultValue={profile.irpReportingWindowDays ?? ''}
                />
                <Hint>
                  30 where turnover is ₹10 crore or more (since 1 April 2025). Leave
                  blank when no window binds you.
                </Hint>
              </Field>
            </FieldRow>
          )}
          <Actions>
            <Button type="submit" disabled={busy}>
              Save declaration
            </Button>
          </Actions>
        </form>
      ) : (
        <p>
          {(profile.einvoiceApplicability ?? 'undeclared') === 'applicable' ? (
            <>
              Applicable from{' '}
              {profile.einvoiceApplicableFrom !== null &&
              profile.einvoiceApplicableFrom !== undefined
                ? formatDate(profile.einvoiceApplicableFrom)
                : '—'}
              {profile.irpReportingWindowDays !== null &&
              profile.irpReportingWindowDays !== undefined
                ? ` · ${String(profile.irpReportingWindowDays)}-day IRP reporting window`
                : ' · no reporting window declared'}
            </>
          ) : (profile.einvoiceApplicability ?? 'undeclared') === 'not_applicable' ? (
            'Declared not applicable — the IRP transport is refused.'
          ) : (
            'Not yet declared — the IRP transport is refused until the owner declares it.'
          )}
        </p>
      )}

      <h2>Number series</h2>
      <p className="text-muted-foreground">
        How each document numbers itself. A document you have not configured uses the
        product default, shown here so you can see what your numbers will look like.
        Changing a series never renumbers anything already issued.
      </p>
      {series === null ? (
        <p className="text-muted-foreground" role="status">
          Loading number series…
        </p>
      ) : (
        <DataTable>
          <caption className="sr-only">Number formats for each document</caption>
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Format</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {series.map((row) => (
              <tr key={row.documentType}>
                <th scope="row">{SERIES_LABELS[row.documentType]}</th>
                <td>
                  <code>{row.template}</code>
                </td>
                <td>{row.isDefault ? 'Default' : 'Yours'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {isOwner && series !== null && (
        <Disclosure label="Change a number series">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const documentType = formValue(data, 'series-document') as
                NumberedDocumentType | '';
              if (documentType === '') return;
              void saveSeries(documentType, formValue(data, 'series-template'));
            }}
          >
            <FieldRow>
              <Field>
                <label htmlFor="series-document">Document</label>
                <select
                  id="series-document"
                  name="series-document"
                  value={seriesType}
                  onChange={(event) => {
                    setSeriesType(event.target.value as NumberedDocumentType);
                  }}
                >
                  {series.map((row) => (
                    <option key={row.documentType} value={row.documentType}>
                      {SERIES_LABELS[row.documentType]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <label htmlFor="series-template">Format</label>
                <input
                  id="series-template"
                  name="series-template"
                  required
                  maxLength={120}
                  defaultValue={
                    series.find((row) => row.documentType === seriesType)?.template ??
                    ''
                  }
                  key={seriesType}
                />
              </Field>
            </FieldRow>
            <Hint>
              Anything outside braces prints as itself. Available here:{' '}
              {(
                series.find((row) => row.documentType === seriesType)
                  ?.availableTokens ?? []
              )
                .map((token) => `{${token}}`)
                .join(', ')}
              . Use <code>{'{SEQ:3}'}</code> to pad the counter to three digits — every
              format must use <code>{'{SEQ}'}</code>, or every document would take the
              same number.
            </Hint>
            <Actions>
              <Button type="submit" disabled={busy}>
                Save format
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void clearSeries(seriesType);
                }}
                disabled={busy}
              >
                Restore the default
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {error !== null && <FormError>{error}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
    </Card>
  );
}
