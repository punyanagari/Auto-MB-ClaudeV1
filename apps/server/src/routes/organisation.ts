import {
  ApiErrorSchema,
  CreateOrganisationBankAccountRequestSchema,
  NUMBERED_DOCUMENT_TYPES,
  NumberSeriesListResponseSchema,
  NumberSeriesSchema,
  NumberedDocumentTypeSchema,
  OrganisationBankAccountListResponseSchema,
  OrganisationBankAccountSchema,
  OrganisationProfileSchema,
  SaveNumberSeriesRequestSchema,
  UpdateOrganisationProfileRequestSchema,
  UuidSchema,
  type EinvoiceApplicability,
  type TaxInvoiceLineShape,
  type NumberSeries,
  type NumberedDocumentType,
  type OrganisationBankAccount,
  type OrganisationProfile,
  type UpdateOrganisationProfileRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import { jsonb, type Sql, type TransactionSql } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import {
  normaliseBankAccountNumber,
  normaliseEmail,
  normaliseGstin,
  normaliseIfsc,
} from '../contact-fields.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import type { ObjectStorage } from '@auto-mb/documents';
import {
  ALLOWED_TOKENS,
  DEFAULT_TEMPLATES,
  NumberTemplateError,
  assertValidTemplate,
} from '../number-series.js';
import { assertNotMalware, consumeUpload } from '../upload-guards.js';
import { audit } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
} as const;

/** Logos are embedded into generated PDFs; keep them small and simple.
 * Declared as the route's Fastify `bodyLimit` as well as checked in the
 * handler: the limit is what marks the route as an upload for the throttle
 * derived in app.ts, and it is the value Fastify was already applying by
 * default, so nothing about the accepted sizes changes. */
const LOGO_MAX_BYTES = 1024 * 1024;

/**
 * The only projection of `organisation_bank_accounts` in this file.
 *
 * `account_number` is deliberately absent and `right(account_number, 4)`
 * stands in its place, so the full stored number has no route out of the
 * database at all — not through a response, not through a log line, not
 * through an audit payload. See the section header on the routes below
 * for why nothing needs it back.
 */
const BANK_ACCOUNT_SELECT = `
  select id, account_holder, bank_name, right(account_number, 4)
           as account_number_last4,
         ifsc, branch, active, created_at
  from organisation_bank_accounts
`;

interface BankAccountRow {
  id: string;
  account_holder: string;
  bank_name: string;
  account_number_last4: string;
  ifsc: string;
  branch: string | null;
  active: boolean;
  created_at: Date;
}

function toBankAccount(row: BankAccountRow): OrganisationBankAccount {
  return {
    id: row.id,
    accountHolder: row.account_holder,
    bankName: row.bank_name,
    accountNumberLast4: row.account_number_last4,
    ifsc: row.ifsc,
    branch: row.branch,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Retire or reactivate one bank account.
 *
 * Written outside the two-line registration loop below rather than inside
 * it: retire and reactivate differ by one boolean, and a `for` loop over
 * `[false, true]` holding the statement would read to the write-loop
 * census (`test/query-write-loop-census.test.ts`) as a per-row write in a
 * loop, which it is not. Lifting it out says the same thing to a reader
 * and to the scan.
 *
 * Owner-only, enforced by the registrar's `role: 'owner'` on both routes
 * rather than here, so the refusal lands before the handler.
 */
async function setBankAccountActive(
  tx: TransactionSql,
  options: {
    readonly id: string;
    readonly active: boolean;
    readonly userId: string;
    readonly organisationId: string;
  },
): Promise<OrganisationBankAccount> {
  const [updated] = await tx<{ id: string }[]>`
    update organisation_bank_accounts set active = ${options.active}
    where id = ${options.id}
    returning id
  `.catch((error: unknown) => {
    // Reactivating collides with the live-account index when the same
    // account was added again while this one was retired.
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      throw httpError(
        409,
        'BANK_ACCOUNT_EXISTS',
        'A live account already carries this number and IFSC; retire that one first.',
      );
    }
    throw error;
  });
  if (!updated) {
    throw httpError(404, 'BANK_ACCOUNT_NOT_FOUND', 'No such bank account.');
  }
  const [row] = await tx<BankAccountRow[]>`
    ${tx.unsafe(BANK_ACCOUNT_SELECT)} where id = ${options.id}
  `;
  if (!row) throw new Error('bank account vanished after update');
  await audit(
    tx,
    options.organisationId,
    options.userId,
    `organisation.bank_account_${options.active ? 'reactivated' : 'retired'}`,
    'organisation_bank_accounts',
    options.id,
    { bankName: row.bank_name, last4: row.account_number_last4 },
  );
  return toBankAccount(row);
}

async function requireOwner(tx: TransactionSql, userId: string): Promise<void> {
  const [membership] = await tx<{ role: string }[]>`
    select role from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  if (membership?.role !== 'owner') {
    throw httpError(
      403,
      'OWNER_REQUIRED',
      'Only an organisation owner may change the organisation profile.',
    );
  }
}

interface ProfileRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  gstin: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_object_key: string | null;
  warranty_template_text: string | null;
  state_code: string | null;
  pincode: string | null;
  locality: string | null;
  trade_name: string | null;
  msme_number: string | null;
  invoice_number_prefix: string | null;
  invoice_notes: string | null;
  default_invoice_shape: TaxInvoiceLineShape;
  einvoice_applicability: EinvoiceApplicability;
  einvoice_applicable_from: string | null;
  irp_reporting_window_days: number | null;
}

function toProfile(row: ProfileRow): OrganisationProfile {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    gstin: row.gstin,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    hasLogo: row.logo_object_key !== null,
    stateCode: row.state_code,
    pincode: row.pincode,
    locality: row.locality,
    tradeName: row.trade_name,
    msmeNumber: row.msme_number,
    invoiceNumberPrefix: row.invoice_number_prefix,
    invoiceNotes: row.invoice_notes,
    defaultInvoiceShape: row.default_invoice_shape,
    warrantyTemplateText: row.warranty_template_text,
    einvoiceApplicability: row.einvoice_applicability,
    einvoiceApplicableFrom: row.einvoice_applicable_from,
    irpReportingWindowDays: row.irp_reporting_window_days,
  };
}

async function loadProfile(tx: TransactionSql): Promise<ProfileRow> {
  // Pinned to the BOUND organisation explicitly: the 0004 org-picker
  // policy also lets a member SELECT every organisation they belong to,
  // so an unqualified read under a user with two organisations can hand
  // back the other one's row — and this row seeds the PATCH merge.
  const [row] = await tx<ProfileRow[]>`
    select id, name, slug, address, gstin, contact_phone,
           contact_email, logo_object_key, warranty_template_text, state_code,
           pincode, locality, trade_name, msme_number, invoice_number_prefix,
           invoice_notes, default_invoice_shape, einvoice_applicability,
           einvoice_applicable_from::text as einvoice_applicable_from,
           irp_reporting_window_days
    from organisations
    where id = app_private.current_organisation_id()
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
  return row;
}

/**
 * The state code and the GSTIN must agree (migration 0033).
 *
 * A registered GSTIN begins with the two-digit state code of the
 * registration, and the supplier's state is what decides CGST+SGST
 * against IGST for a given place of supply. Storing a state code that
 * contradicts the GSTIN would therefore split the tax the wrong way on
 * every invoice raised afterwards — and the invoice carries both values,
 * so the contradiction is visible to the officer reading it.
 *
 * The check runs against the values as they will STAND after this
 * request, not against the ones it happens to name: editing the GSTIN
 * alone can contradict a state code stored months ago, and that is the
 * same defect arriving by the other door. It is a refusal rather than a
 * silent derivation because the column is a fact in its own right — an
 * unregistered organisation has no GSTIN to derive from and still has a
 * place of business — so the operator says which of the two is wrong.
 */
function assertStateCodeMatchesGstin(
  stateCode: string | null,
  gstin: string | null,
): void {
  if (stateCode === null || gstin === null) return;
  const registered = gstin.slice(0, 2);
  if (stateCode !== registered) {
    throw httpError(
      400,
      'STATE_CODE_GSTIN_MISMATCH',
      `The GST state code ${stateCode} contradicts the GSTIN ${gstin}, which is registered in state ${registered}. The state code decides CGST+SGST against IGST on every invoice, so correct whichever of the two is wrong.`,
    );
  }
}

/**
 * The e-invoicing declaration must be coherent as it will STAND after
 * the request (migration 0049) — same posture as the state-code/GSTIN
 * check above, and for the same reason: each field can be edited alone
 * into contradicting the others.
 *
 * `applicable` requires the date it became so, because the mandate is
 * permanent from a date, not a mood; anything else forbids that date,
 * so a stale from-date cannot linger under a withdrawn declaration; and
 * a reporting window exists only while applicable, because the window
 * is a consequence of the mandate, not a standalone preference. The
 * refusals are 400s here so the operator gets a sentence; the 0049
 * CHECK binds the same rule against direct SQL.
 */
function assertEinvoiceDeclarationCoherent(
  applicability: EinvoiceApplicability,
  applicableFrom: string | null,
  reportingWindowDays: number | null,
): void {
  if ((applicability === 'applicable') !== (applicableFrom !== null)) {
    throw httpError(
      400,
      'E_INVOICE_DECLARATION_INCOHERENT',
      applicability === 'applicable'
        ? 'Declaring e-invoicing applicable requires the date it became so — the mandate runs from a date, permanently.'
        : 'An applicable-from date can only stand under an applicable declaration; clear it or declare e-invoicing applicable.',
    );
  }
  if (reportingWindowDays !== null && applicability !== 'applicable') {
    throw httpError(
      400,
      'E_INVOICE_DECLARATION_INCOHERENT',
      'An IRP reporting window can only stand under an applicable declaration; clear it or declare e-invoicing applicable.',
    );
  }
}

/**
 * Organisation profile and branding: the company details and logo used on
 * generated documents. Reads are member-wide; writes are owner-only. The
 * logo is validated by magic bytes (never by the client's claimed type),
 * scanned like every other upload, and stored under the tenant prefix.
 */
export function registerOrganisationRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisation/profile',
      schema: {
        response: { 200: OrganisationProfileSchema, ...errorResponses },
      },
    },
    async ({ tenant }) => {
      return tenant(async (tx) => toProfile(await loadProfile(tx)));
    },
  );

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/organisation/profile',
      /** The contract's GSTIN pattern is uppercase-only, because the
       * stored value must be; without this a correctly-typed lowercase
       * GSTIN would be bounced by schema validation with a generic 400
       * before the handler could fold the case, while the contacts
       * endpoint accepts either case. Fold it here, ahead of validation,
       * and leave the structure to normaliseGstin below. */
      preValidation: (request, _reply, done) => {
        const body = request.body as UpdateOrganisationProfileRequest | undefined;
        if (body && typeof body.gstin === 'string') {
          body.gstin = body.gstin.trim().toUpperCase();
        }
        done();
      },
      schema: {
        body: UpdateOrganisationProfileRequestSchema,
        response: { 200: OrganisationProfileSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const body = request.body;
      // The contractor's own GSTIN and email are proved exactly as a
      // contact's are (../contact-fields.js) and before the transaction
      // opens: branding is read live at every render, so whatever lands
      // here is printed as the supplier GSTIN and the letterhead email on
      // every Delivery Challan, Issue Challan, MB, extension letter, and
      // correction notice. `undefined` means "leave as it was"; an
      // explicit null clears the field.
      const gstin = body.gstin !== undefined ? normaliseGstin(body.gstin) : undefined;
      const contactEmail =
        body.contactEmail !== undefined ? normaliseEmail(body.contactEmail) : undefined;
      const locality =
        body.locality === undefined
          ? undefined
          : body.locality === null
            ? null
            : body.locality.trim();
      if (locality !== undefined && locality !== null && locality.length < 2) {
        throw httpError(
          400,
          'LOCALITY_INVALID',
          'Locality must contain at least two non-space characters.',
        );
      }
      return tenant(async (tx) => {
        await requireOwner(tx, user.id);
        const current = await loadProfile(tx);
        const next = {
          name: body.name ?? current.name,
          address: body.address !== undefined ? body.address : current.address,
          gstin: gstin !== undefined ? gstin : current.gstin,
          contact_phone:
            body.contactPhone !== undefined ? body.contactPhone : current.contact_phone,
          contact_email:
            contactEmail !== undefined ? contactEmail : current.contact_email,
          // Two digits by the contract schema and by the column's own
          // CHECK; null clears it, which an organisation that entered the
          // wrong state must be able to do.
          state_code:
            body.stateCode !== undefined ? body.stateCode : current.state_code,
          // The tax invoice's masthead. The PIN is not decoration: the
          // e-invoice payload needs the seller's PIN as a number in its
          // own right, and an address line is not required to contain
          // one — the sample invoice's does not.
          pincode: body.pincode !== undefined ? body.pincode : current.pincode,
          locality: locality !== undefined ? locality : current.locality,
          trade_name:
            body.tradeName !== undefined ? body.tradeName : current.trade_name,
          msme_number:
            body.msmeNumber !== undefined ? body.msmeNumber : current.msme_number,
          invoice_number_prefix:
            body.invoiceNumberPrefix !== undefined
              ? body.invoiceNumberPrefix
              : current.invoice_number_prefix,
          invoice_notes:
            body.invoiceNotes !== undefined ? body.invoiceNotes : current.invoice_notes,
          // Which line shape the invoice CREATE FORM starts on
          // (migration 0057). A form default and nothing more: the
          // shape is a per-document choice, and changing this never
          // reaches an invoice that already exists.
          default_invoice_shape:
            body.defaultInvoiceShape !== undefined
              ? body.defaultInvoiceShape
              : current.default_invoice_shape,
          warranty_template_text:
            body.warrantyTemplateText !== undefined
              ? body.warrantyTemplateText
              : current.warranty_template_text,
          // The e-invoicing declaration (migration 0049). Owner-only
          // like the rest of this route; the coherence of the three is
          // asserted below against the values as they will stand.
          einvoice_applicability:
            body.einvoiceApplicability !== undefined
              ? body.einvoiceApplicability
              : current.einvoice_applicability,
          einvoice_applicable_from:
            body.einvoiceApplicableFrom !== undefined
              ? body.einvoiceApplicableFrom
              : current.einvoice_applicable_from,
          irp_reporting_window_days:
            body.irpReportingWindowDays !== undefined
              ? body.irpReportingWindowDays
              : current.irp_reporting_window_days,
        };
        // Against the values as they will stand, so neither field can be
        // edited into contradicting the other.
        assertStateCodeMatchesGstin(next.state_code, next.gstin);
        assertEinvoiceDeclarationCoherent(
          next.einvoice_applicability,
          next.einvoice_applicable_from,
          next.irp_reporting_window_days,
        );
        const [updated] = await tx<ProfileRow[]>`
          update organisations set
            name = ${next.name},
            address = ${next.address},
            gstin = ${next.gstin},
            contact_phone = ${next.contact_phone},
            contact_email = ${next.contact_email},
            state_code = ${next.state_code},
            pincode = ${next.pincode},
            locality = ${next.locality},
            trade_name = ${next.trade_name},
            msme_number = ${next.msme_number},
            invoice_number_prefix = ${next.invoice_number_prefix},
            invoice_notes = ${next.invoice_notes},
            default_invoice_shape = ${next.default_invoice_shape},
            warranty_template_text = ${next.warranty_template_text},
            einvoice_applicability = ${next.einvoice_applicability},
            einvoice_applicable_from = ${next.einvoice_applicable_from},
            irp_reporting_window_days = ${next.irp_reporting_window_days},
            updated_at = now()
          where id = ${organisationId}
          returning id, name, slug, address, gstin, contact_phone,
                    contact_email, logo_object_key, warranty_template_text,
                    state_code, pincode, locality, trade_name, msme_number,
                    invoice_number_prefix, invoice_notes,
                    default_invoice_shape, einvoice_applicability,
                    einvoice_applicable_from::text as einvoice_applicable_from,
                    irp_reporting_window_days
        `;
        if (!updated) throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
        // Milestone 6: record each changed field's old and new value —
        // company details only, never credentials or upload bytes.
        const changes = auditDiff(
          {
            name: current.name,
            address: current.address,
            gstin: current.gstin,
            contactPhone: current.contact_phone,
            contactEmail: current.contact_email,
            stateCode: current.state_code,
            pincode: current.pincode,
            locality: current.locality,
            tradeName: current.trade_name,
            msmeNumber: current.msme_number,
            invoiceNumberPrefix: current.invoice_number_prefix,
            invoiceNotes: current.invoice_notes,
            defaultInvoiceShape: current.default_invoice_shape,
            einvoiceApplicability: current.einvoice_applicability,
            einvoiceApplicableFrom: current.einvoice_applicable_from,
            irpReportingWindowDays: current.irp_reporting_window_days,
          },
          {
            name: next.name,
            address: next.address,
            gstin: next.gstin,
            contactPhone: next.contact_phone,
            contactEmail: next.contact_email,
            stateCode: next.state_code,
            pincode: next.pincode,
            locality: next.locality,
            tradeName: next.trade_name,
            msmeNumber: next.msme_number,
            invoiceNumberPrefix: next.invoice_number_prefix,
            invoiceNotes: next.invoice_notes,
            defaultInvoiceShape: next.default_invoice_shape,
            einvoiceApplicability: next.einvoice_applicability,
            einvoiceApplicableFrom: next.einvoice_applicable_from,
            irpReportingWindowDays: next.irp_reporting_window_days,
          },
        );
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisationId}, ${user.id}, 'organisation.profile_updated',
            'organisations', ${organisationId},
            ${jsonb(tx, { before: changes.before, after: changes.after })}
          )
        `;
        return toProfile(updated);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/organisation/logo',
      bodyLimit: LOGO_MAX_BYTES,
      schema: { response: { ...errorResponses } },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { bytes: body, mediaType } = consumeUpload(request.body, {
        format: 'image',
        description: 'the logo bytes',
      });
      if (body.length > LOGO_MAX_BYTES) {
        throw httpError(400, 'IMAGE_TOO_LARGE', 'The logo must be 1 MB or smaller.');
      }
      // Authorisation before the expensive scan (ops batch).
      await tenant(async (tx) => {
        await requireOwner(tx, user.id);
      });
      await assertNotMalware(scanner, body);

      const extension = mediaType === 'image/png' ? 'png' : 'jpg';
      const key = `${organisationId}/branding/logo.${extension}`;
      const profile = await tenant(async (tx) => {
        await requireOwner(tx, user.id);
        // Store before the row points at the key; an orphan object is
        // harmless, a dangling key is not.
        await storage.put(key, body);
        const [updated] = await tx<ProfileRow[]>`
            update organisations set
              logo_object_key = ${key},
              logo_media_type = ${mediaType},
              updated_at = now()
            where id = ${organisationId}
            returning id, name, slug, address, gstin, contact_phone,
                      contact_email, logo_object_key, warranty_template_text,
                      state_code
          `;
        if (!updated) throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'organisation.logo_updated',
              'organisations', ${organisationId},
              ${jsonb(tx, { mediaType, sizeBytes: body.length })}
            )
          `;
        return toProfile(updated);
      });
      return reply.status(200).send(profile);
    },
  );

  // The success payload is the raw image bytes, which no response schema
  // describes; the explicit Reply generic says so to the type provider.
  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisation/logo',
      schema: { response: { ...errorResponses } },
    },
    async ({ reply, tenant }) => {
      const row = await tenant(async (tx) => {
        const [organisation] = await tx<
          { logo_object_key: string | null; logo_media_type: string | null }[]
        >`
            select logo_object_key, logo_media_type from organisations
            where id = app_private.current_organisation_id()
          `;
        return organisation ?? null;
      });
      if (!row?.logo_object_key || !row.logo_media_type) {
        throw httpError(404, 'NO_LOGO', 'The organisation has no logo.');
      }
      const bytes = await storage.get(row.logo_object_key);
      return reply
        .header('content-type', row.logo_media_type)
        .header('cache-control', 'private, no-store')
        .send(bytes);
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/organisation/logo',
      schema: {
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    },
    async ({ reply, user, organisationId, tenant }) => {
      await tenant(async (tx) => {
        await requireOwner(tx, user.id);
        await tx`
          update organisations set
            logo_object_key = null,
            logo_media_type = null,
            updated_at = now()
          where id = ${organisationId}
        `;
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisationId}, ${user.id}, 'organisation.logo_removed',
            'organisations', ${organisationId}, ${jsonb(tx, {})}
          )
        `;
      });
      return reply.status(204).send();
    },
  );
  // --- The organisation's own bank accounts (migration 0078) ---------------
  //
  // The accounts money arrives in, for printing on an invoice. A list
  // rather than columns on `organisations`, because the mock's Company
  // card is a list with an "Add account" dialog; a contact's single
  // beneficiary is columns for the opposite reason (routes/masters.ts).
  //
  // THE STORED ACCOUNT NUMBER NEVER LEAVES THE DATABASE. `right(...) as
  // account_number_last4` is the only projection of that column anywhere
  // in this file, so there is no code path that could put the full value
  // into a response, a log line, or an audit event. The card only ever
  // renders the last four, and nothing edits an account — the row is
  // added and retired — so nothing needs the whole value back.
  //
  // Reads are member-wide, like the profile above (an operator should be
  // able to see which account an invoice will name); writes are
  // owner-only, like everything else that changes the company's identity.

  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisation/bank-accounts',
      schema: {
        querystring: Type.Object(
          { includeRetired: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: {
          200: OrganisationBankAccountListResponseSchema,
          ...errorResponses,
        },
      },
    },
    async ({ request, tenant }) => {
      const { includeRetired = false } = request.query;
      const rows = await tenant(
        async (tx) => tx<BankAccountRow[]>`
          ${tx.unsafe(BANK_ACCOUNT_SELECT)}
          where active or ${includeRetired}
          order by created_at, id
        `,
      );
      return { accounts: rows.map(toBankAccount) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      schema: {
        body: CreateOrganisationBankAccountRequestSchema,
        response: { 201: OrganisationBankAccountSchema, ...errorResponses },
      },
      // The registrar's own guard rather than this file's inline
      // `requireOwner`, and the difference is ORDER: the registrar
      // decides membership and role before the handler body runs, so a
      // non-member is refused rather than told which of their field
      // values this organisation dislikes. `test/route-inventory` checks
      // exactly that for every tenant route.
      role: 'owner',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const account = await tenant(async (tx) => {
        // Normalised inside the authorised transaction, by the same
        // normalisers a contact's beneficiary details go through
        // (../contact-fields.js). A junk IFSC is a payment that bounces
        // at the bank against an invoice already sent.
        const ifsc = normaliseIfsc(body.ifsc);
        const accountNumber = normaliseBankAccountNumber(body.accountNumber);
        if (ifsc === null || accountNumber === null) {
          throw new Error(
            'bank account normalisers cannot answer null for a required field',
          );
        }
        const [inserted] = await tx<{ id: string }[]>`
          insert into organisation_bank_accounts (
            organisation_id, account_holder, bank_name, account_number, ifsc,
            branch, created_by_user_id
          )
          values (
            ${organisationId}, ${body.accountHolder.trim()},
            ${body.bankName.trim()}, ${accountNumber}, ${ifsc},
            ${body.branch?.trim() ?? null}, ${user.id}
          )
          returning id
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'BANK_ACCOUNT_EXISTS',
              'This account is already on the list (it may be retired — reactivate it instead).',
            );
          }
          throw error;
        });
        if (!inserted) throw new Error('bank account insert returned no row');
        const [row] = await tx<BankAccountRow[]>`
          ${tx.unsafe(BANK_ACCOUNT_SELECT)} where id = ${inserted.id}
        `;
        if (!row) throw new Error('bank account vanished after insert');
        // The bank and the last four only. An audit trail that records
        // account numbers is a second place they can leak from.
        await audit(
          tx,
          organisationId,
          user.id,
          'organisation.bank_account_added',
          'organisation_bank_accounts',
          row.id,
          { bankName: row.bank_name, ifsc: row.ifsc, last4: row.account_number_last4 },
        );
        return toBankAccount(row);
      });
      return reply.status(201).send(account);
    },
  );

  // Retire and reactivate. The mock's card draws neither, because a static
  // page has no wrong rows in it; a real one does, and an account typed
  // wrong with no exit would be permanent — there is no DELETE grant on
  // this table and masters retire by flag (0013). Built with the
  // product's existing master grammar rather than new visual language,
  // per the design contract's clause 4.
  for (const active of [false, true]) {
    tenantRoute(
      {
        method: 'POST',
        url: `/api/organisation/bank-accounts/:id/${active ? 'reactivate' : 'retire'}`,
        schema: {
          params: Type.Object({ id: UuidSchema }, { additionalProperties: false }),
          response: { 200: OrganisationBankAccountSchema, ...errorResponses },
        },
        role: 'owner',
      },
      async ({ request, user, organisationId, tenant }) =>
        tenant(async (tx) =>
          setBankAccountActive(tx, {
            id: request.params.id,
            active,
            userId: user.id,
            organisationId,
          }),
        ),
    );
  }

  // --- Number series (migration 0039) --------------------------------------
  //
  // Number formats belong to the organisation, not to us. Four documents
  // are configurable; a type with no row here uses the product default,
  // which is exactly the format it had before the table existed. Reads
  // are member-wide (an operator should be able to see what their
  // numbers will look like); writes are owner-only, like the rest of the
  // profile.

  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisation/number-series',
      schema: {
        response: { 200: NumberSeriesListResponseSchema, ...errorResponses },
      },
    },
    async ({ tenant }) => {
      return tenant(async (tx) => {
        const rows = await tx<
          { document_type: NumberedDocumentType; template: string }[]
        >`
          select document_type, template from document_number_series
        `;
        const configured = new Map(
          rows.map((row) => [row.document_type, row.template]),
        );
        const series: NumberSeries[] = NUMBERED_DOCUMENT_TYPES.map((documentType) => ({
          documentType,
          template: configured.get(documentType) ?? DEFAULT_TEMPLATES[documentType],
          isDefault: !configured.has(documentType),
          availableTokens: [...ALLOWED_TOKENS[documentType]],
        }));
        return { series };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/organisation/number-series/:documentType',
      schema: {
        params: Type.Object(
          { documentType: NumberedDocumentTypeSchema },
          { additionalProperties: false },
        ),
        body: SaveNumberSeriesRequestSchema,
        response: { 200: NumberSeriesSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { documentType } = request.params;
      const template = request.body.template.trim();
      // Proved BEFORE it is stored: a template that cannot be filled in
      // must fail on this screen, not at the moment an operator has a
      // finished document and nowhere to put its number.
      try {
        assertValidTemplate(template, documentType);
      } catch (cause) {
        if (cause instanceof NumberTemplateError) {
          throw httpError(400, 'NUMBER_TEMPLATE_INVALID', cause.message);
        }
        throw cause;
      }
      return tenant(async (tx) => {
        await requireOwner(tx, user.id);
        await tx`
          insert into document_number_series (organisation_id, document_type, template)
          values (${organisationId}, ${documentType}, ${template})
          on conflict (organisation_id, document_type)
          do update set template = excluded.template
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'organisation.number_series_set',
          'document_number_series',
          organisationId,
          { documentType, template },
        );
        return {
          documentType,
          template,
          isDefault: false,
          availableTokens: [...ALLOWED_TOKENS[documentType]],
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/organisation/number-series/:documentType',
      schema: {
        params: Type.Object(
          { documentType: NumberedDocumentTypeSchema },
          { additionalProperties: false },
        ),
        response: { 200: NumberSeriesSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { documentType } = request.params;
      return tenant(async (tx) => {
        await requireOwner(tx, user.id);
        await tx`
          delete from document_number_series where document_type = ${documentType}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'organisation.number_series_cleared',
          'document_number_series',
          organisationId,
          { documentType },
        );
        // Numbers already issued keep the strings they were issued with;
        // only future ones follow the default again.
        return {
          documentType,
          template: DEFAULT_TEMPLATES[documentType],
          isDefault: true,
          availableTokens: [...ALLOWED_TOKENS[documentType]],
        };
      });
    },
  );
}
