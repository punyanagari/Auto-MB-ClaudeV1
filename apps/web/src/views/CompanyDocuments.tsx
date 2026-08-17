import { useCallback, useEffect, useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import {
  COMPANY_DOCUMENT_CATEGORIES,
  type CompanyDocument,
  type CompanyDocumentCategory,
  type CompanyDocumentExpiryStatus,
  type CompanyDocumentVersion,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { cn } from '../lib/cn.js';
import { openPdf } from '../lib/openPdf.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The company document library.
 *
 * Replicates `app/tenders/company-documents/page.tsx` and
 * `components/company-document-library.tsx` of the frozen mock at
 * fdfe5ef: a `PageHeader` over a `.75fr / 1.25fr` two-card grid — the
 * add form on the left, the credentials on the right as `rounded-xl
 * border p-4` rows carrying the title, a `v{n}` outline badge and the
 * validity state.
 *
 * Three additions, each built inside that grammar rather than beside it:
 *
 *   * **The status badge is the product's own** (`ui/chip.tsx`, the mock's
 *     `components/shared` → `StatusBadge`) rather than the raw
 *     `Badge variant="destructive"` this one screen of the mock reaches
 *     for. `docs/DESIGN.md` § Status badge semantics makes the dot-plus-
 *     label chip the single vocabulary for record state, and the mock's
 *     own `statusStyles` already carries `expiring`; using it here is
 *     applying the mock's grammar consistently, not inventing one. It is
 *     also what keeps the state off the colour-only path.
 *   * **Version history**, which the mock promises in copy ("New uploads
 *     retain source, date, and version history") and never draws. It
 *     renders in the existing `Disclosure`, under the row it belongs to.
 *   * **No signing gate.** The mock hands each row to `DscSigningGate`.
 *     A company document is a copy of something an authority already
 *     issued, so there is nothing here for this organisation to sign;
 *     `docs/UX.md` § Approved divergences 4 covers behaviour the mock
 *     fakes.
 */

const CATEGORY_LABELS: Record<CompanyDocumentCategory, string> = {
  statutory: 'Statutory',
  financial: 'Financial',
  eligibility: 'Eligibility',
  certification: 'Certification',
  company: 'Company',
};

/** What the register calls each derived validity reading. The reading is
 * also the chip's status key, so `ui/chip.tsx` carries the tone: `valid`
 * success, `expiring` warning, `expired` destructive, and `none`
 * deliberately unmapped so it reads neutral — a PAN card that never
 * expires is not "currently good", it is outside the question. */
const EXPIRY_LABELS: Record<CompanyDocumentExpiryStatus, string> = {
  none: 'No expiry',
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
};

interface CompanyDocumentsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Uploading and archiving are owner/office work, exactly as the
   * server gates them. A viewer reads the library and downloads from it. */
  readonly canModify: boolean;
}

export function CompanyDocuments({
  api,
  organisationId,
  canModify,
}: CompanyDocumentsProps) {
  const [documents, setDocuments] = useState<readonly CompanyDocument[] | null>(null);
  const [warningDays, setWarningDays] = useState(60);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDocuments(null);
    setLoadError(null);
    api
      .listCompanyDocuments(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setDocuments(loaded.documents);
        setWarningDays(loaded.expiryWarningDays);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The company documents could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const act = useCallback(
    async (work: () => Promise<readonly CompanyDocument[]>, done: string) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        setDocuments(await work());
        setNotice(done);
      } catch (cause) {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The action failed; nothing was changed.',
        );
      } finally {
        setPending(false);
      }
    },
    [],
  );

  /** Every mutation answers the credential it changed, so the register
   * replaces that one row instead of re-reading the whole library. */
  const withReplaced = useCallback(
    (updated: CompanyDocument): readonly CompanyDocument[] => {
      const current = documents ?? [];
      return current.some((credential) => credential.id === updated.id)
        ? current.map((credential) =>
            credential.id === updated.id ? updated : credential,
          )
        : [...current, updated].sort((left, right) =>
            left.title.localeCompare(right.title),
          );
    },
    [documents],
  );

  const header = (
    <PageHeader
      title="Company documents"
      titleId="company-documents-title"
      description={`Upload a credential once, keep every version, and see what lapses within ${String(warningDays)} days. Statutory registrations, financial statements, eligibility and certification papers — reused wherever they are demanded.`}
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry company documents">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (documents === null) {
    return (
      <>
        {header}
        <LoadingState label="the company documents" rows={4} columns={3} />
      </>
    );
  }

  return (
    <>
      {header}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {/* The mock's own split (`components/company-document-library` at
          fdfe5ef): the form takes the narrower column so the register
          beside it keeps the room. */}
      <div className="grid gap-5 lg:grid-cols-[.75fr_1.25fr]">
        {canModify && (
          <AddDocumentCard
            pending={pending}
            onSubmit={(file, details) =>
              void act(
                async () =>
                  withReplaced(
                    await api.createCompanyDocument(organisationId, file, details),
                  ),
                `${details.title} added to the library.`,
              )
            }
          />
        )}
        <Card className={canModify ? undefined : 'lg:col-span-2'}>
          <CardHeader>
            <h2 className="text-base font-semibold">Company credentials</h2>
          </CardHeader>
          {documents.length === 0 ? (
            <EmptyState>
              Nothing in the library yet. Add the registrations, financial statements
              and certificates that every tender asks for, and they will be here the
              next time one does.
            </EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {documents.map((credential) => (
                <li key={credential.id}>
                  <DocumentRow
                    credential={credential}
                    canModify={canModify}
                    pending={pending}
                    onOpen={(version) =>
                      void act(async () => {
                        await openPdf(() =>
                          api.downloadCompanyDocumentVersion(
                            organisationId,
                            version.id,
                          ),
                        );
                        return documents;
                      }, 'Document opened in a new tab.')
                    }
                    onUploadVersion={(file, details) =>
                      void act(
                        async () =>
                          withReplaced(
                            await api.uploadCompanyDocumentVersion(
                              organisationId,
                              credential.id,
                              file,
                              details,
                            ),
                          ),
                        `${credential.title} updated to a new version.`,
                      )
                    }
                    onArchive={() =>
                      void act(
                        async () =>
                          withReplaced(
                            await api.archiveCompanyDocument(
                              organisationId,
                              credential.id,
                            ),
                          ),
                        `${credential.title} archived. Its versions are kept.`,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }
}

interface UploadDetails {
  readonly filename: string;
  readonly validFrom?: string;
  readonly expiresOn?: string;
}

/** The mock's compact file control: the chosen name and an upload glyph
 * on a bordered row, with the native input present but visually hidden
 * inside the label.
 *
 * `has-[:focus-visible]` is the one addition — the native control's own
 * focus ring is hidden with it, and a keyboard user must still be able
 * to see where they are (`docs/UX.md` § Approved divergences 5). */
function FileRow({
  id,
  label,
  filename,
  onPick,
}: {
  readonly id: string;
  readonly label: string;
  readonly filename: string;
  readonly onPick: (file: File | null) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
    >
      <span
        className={cn('min-w-0 truncate', filename === '' && 'text-muted-foreground')}
      >
        {filename === '' ? label : filename}
      </span>
      <FileUp className="size-4 shrink-0" aria-hidden="true" />
      <input
        id={id}
        type="file"
        accept="application/pdf"
        className="sr-only"
        onChange={(event) => {
          onPick(event.currentTarget.files?.[0] ?? null);
        }}
      />
    </label>
  );
}

/** The two date-only fields every upload carries. Both optional and
 * independently so: a PAN card has neither, a GST registration
 * certificate has an effective date and no expiry. */
function ValidityFields({
  idPrefix,
  validFrom,
  expiresOn,
  onChange,
}: {
  readonly idPrefix: string;
  readonly validFrom: string;
  readonly expiresOn: string;
  readonly onChange: (field: 'validFrom' | 'expiresOn', value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <DateField
        id={`${idPrefix}-valid-from`}
        label="Effective from"
        fieldClassName="my-0 max-w-none"
        value={validFrom}
        onChange={(event) => {
          onChange('validFrom', event.currentTarget.value);
        }}
      />
      <DateField
        id={`${idPrefix}-expires-on`}
        label="Expires on"
        fieldClassName="my-0 max-w-none"
        hint="Leave empty for a document that does not expire."
        value={expiresOn}
        onChange={(event) => {
          onChange('expiresOn', event.currentTarget.value);
        }}
      />
    </div>
  );
}

function AddDocumentCard({
  pending,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly onSubmit: (
    file: File,
    details: UploadDetails & {
      readonly title: string;
      readonly category: CompanyDocumentCategory;
    },
  ) => void;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<CompanyDocumentCategory>('statutory');
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Add reusable document</h2>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() === '' || file === null) {
            setFormError('Give the document a name and choose the PDF to store.');
            return;
          }
          setFormError(null);
          onSubmit(file, {
            title: title.trim(),
            category,
            filename: file.name,
            ...(validFrom === '' ? {} : { validFrom }),
            ...(expiresOn === '' ? {} : { expiresOn }),
          });
          setTitle('');
          setFile(null);
          setValidFrom('');
          setExpiresOn('');
        }}
      >
        <Field className="my-0 max-w-none">
          <label htmlFor="company-document-title">Document name</label>
          <input
            id="company-document-title"
            value={title}
            maxLength={200}
            placeholder="GST registration certificate"
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
          />
        </Field>
        <Field className="max-w-none">
          <label htmlFor="company-document-category">Category</label>
          <select
            id="company-document-category"
            value={category}
            onChange={(event) => {
              setCategory(event.currentTarget.value as CompanyDocumentCategory);
            }}
          >
            {COMPANY_DOCUMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <FileRow
          id="company-document-file"
          label="Choose file"
          filename={file?.name ?? ''}
          onPick={setFile}
        />
        <div className="mt-3">
          <ValidityFields
            idPrefix="company-document"
            validFrom={validFrom}
            expiresOn={expiresOn}
            onChange={(field, value) => {
              if (field === 'validFrom') setValidFrom(value);
              else setExpiresOn(value);
            }}
          />
        </div>
        {formError !== null && <FormError>{formError}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add document
          </Button>
        </Actions>
      </form>
    </Card>
  );
}

function DocumentRow({
  credential,
  canModify,
  pending,
  onOpen,
  onUploadVersion,
  onArchive,
}: {
  readonly credential: CompanyDocument;
  readonly canModify: boolean;
  readonly pending: boolean;
  readonly onOpen: (version: CompanyDocumentVersion) => void;
  readonly onUploadVersion: (file: File, details: UploadDetails) => void;
  readonly onArchive: () => void;
}) {
  const [current, ...earlier] = credential.versions;
  const archived = credential.archivedAt !== null;
  return (
    /* The mock's row: `rounded-xl border p-4`, stacked on a phone and a
       justified row from `sm` up. */
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 font-medium">{credential.title}</p>
          {current !== undefined && (
            <Badge variant="outline" className="font-mono tabular-nums">
              v{current.versionNumber}
            </Badge>
          )}
          {archived ? (
            <StatusChip status="archived">Archived</StatusChip>
          ) : (
            <StatusChip status={credential.expiryStatus}>
              {EXPIRY_LABELS[credential.expiryStatus]}
            </StatusChip>
          )}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {current === undefined ? 'No file' : current.originalFilename} ·{' '}
          {CATEGORY_LABELS[credential.category]}
          {current !== undefined && current.expiresOn !== null && (
            <>
              {' '}
              · valid until{' '}
              <span className="font-mono tabular-nums">
                {formatDate(current.expiresOn)}
              </span>
              {credential.expiresInDays !== null && (
                <>
                  {' '}
                  ({credential.expiresInDays < 0 ? 'lapsed ' : ''}
                  <span className="font-mono tabular-nums">
                    {Math.abs(credential.expiresInDays)}
                  </span>
                  {credential.expiresInDays < 0 ? ' days ago' : ' days away'})
                </>
              )}
            </>
          )}
        </p>
        {(earlier.length > 0 || (canModify && !archived)) && (
          <Disclosure
            label={
              earlier.length > 0
                ? `Versions and renewals (${String(credential.versions.length)})`
                : 'Upload a renewal…'
            }
            variant="outline"
            className="my-1"
          >
            {earlier.length > 0 && (
              <ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
                {earlier.map((version) => (
                  <li
                    key={version.id}
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="font-mono tabular-nums">
                      v{version.versionNumber}
                    </span>
                    <span className="min-w-0 truncate">{version.originalFilename}</span>
                    {version.expiresOn !== null && (
                      <span className="font-mono tabular-nums">
                        valid until {formatDate(version.expiresOn)}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        onOpen(version);
                      }}
                    >
                      Open v{version.versionNumber}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {canModify && !archived && (
              <NewVersionForm
                credential={credential}
                pending={pending}
                onSubmit={onUploadVersion}
              />
            )}
          </Disclosure>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {current !== undefined && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              onOpen(current);
            }}
          >
            Open
          </Button>
        )}
        {canModify && !archived && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onArchive}>
            Archive
          </Button>
        )}
      </div>
    </div>
  );
}

function NewVersionForm({
  credential,
  pending,
  onSubmit,
}: {
  readonly credential: CompanyDocument;
  readonly pending: boolean;
  readonly onSubmit: (file: File, details: UploadDetails) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (file === null) {
          setFormError('Choose the renewed document first.');
          return;
        }
        setFormError(null);
        onSubmit(file, {
          filename: file.name,
          ...(validFrom === '' ? {} : { validFrom }),
          ...(expiresOn === '' ? {} : { expiresOn }),
        });
        setFile(null);
        setValidFrom('');
        setExpiresOn('');
      }}
    >
      <FileRow
        id={`company-document-version-file-${credential.id}`}
        label={`Choose the renewed ${credential.title}`}
        filename={file?.name ?? ''}
        onPick={setFile}
      />
      <div className="mt-3">
        <ValidityFields
          idPrefix={`company-document-version-${credential.id}`}
          validFrom={validFrom}
          expiresOn={expiresOn}
          onChange={(field, value) => {
            if (field === 'validFrom') setValidFrom(value);
            else setExpiresOn(value);
          }}
        />
      </div>
      <Hint>
        The earlier version is kept. It is what a bid submitted against it attached.
      </Hint>
      {formError !== null && <FormError>{formError}</FormError>}
      <Actions>
        <Button type="submit" variant="outline" disabled={pending}>
          Upload new version
        </Button>
      </Actions>
    </form>
  );
}
