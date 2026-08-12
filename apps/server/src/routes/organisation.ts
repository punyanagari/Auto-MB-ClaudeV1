import {
  ApiErrorSchema,
  NUMBERED_DOCUMENT_TYPES,
  NumberSeriesListResponseSchema,
  NumberSeriesSchema,
  NumberedDocumentTypeSchema,
  OrganisationProfileSchema,
  SaveNumberSeriesRequestSchema,
  UpdateOrganisationProfileRequestSchema,
  type NumberSeries,
  type NumberedDocumentType,
  type OrganisationProfile,
  type SaveNumberSeriesRequest,
  type UpdateOrganisationProfileRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { jsonb, type Sql, type TransactionSql } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { normaliseEmail, normaliseGstin } from '../contact-fields.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import {
  ALLOWED_TOKENS,
  DEFAULT_TEMPLATES,
  NumberTemplateError,
  assertValidTemplate,
} from '../number-series.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertNotMalware } from '../upload-guards.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
} as const;

/** Logos are embedded into generated PDFs; keep them small and simple. */
const LOGO_MAX_BYTES = 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function detectImageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  return null;
}

/** One audit row. The profile routes below write their own inline (they
 * carry before/after diffs); the number-series routes state a fact, so
 * they share this. */
async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, ${entityType}, ${entityId},
      ${jsonb(tx, details)}
    )
  `;
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
    warrantyTemplateText: row.warranty_template_text,
  };
}

async function loadProfile(tx: TransactionSql): Promise<ProfileRow> {
  const [row] = await tx<ProfileRow[]>`
    select id, name, slug, address, gstin, contact_phone,
           contact_email, logo_object_key, warranty_template_text, state_code,
           pincode, locality, trade_name, msme_number, invoice_number_prefix,
           invoice_notes
    from organisations
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
 * Organisation profile and branding: the company details and logo used on
 * generated documents. Reads are member-wide; writes are owner-only. The
 * logo is validated by magic bytes (never by the client's claimed type),
 * scanned like every other upload, and stored under the tenant prefix.
 */
export function registerOrganisationRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  app.get(
    '/api/organisation/profile',
    {
      schema: {
        response: { 200: OrganisationProfileSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      return withBoundTenant(database, organisationId, user.id, async (tx) =>
        toProfile(await loadProfile(tx)),
      );
    },
  );

  app.patch<{ Body: UpdateOrganisationProfileRequest }>(
    '/api/organisation/profile',
    {
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
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
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
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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
          warranty_template_text:
            body.warrantyTemplateText !== undefined
              ? body.warrantyTemplateText
              : current.warranty_template_text,
        };
        // Against the values as they will stand, so neither field can be
        // edited into contradicting the other.
        assertStateCodeMatchesGstin(next.state_code, next.gstin);
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
            warranty_template_text = ${next.warranty_template_text},
            updated_at = now()
          where id = ${organisationId}
          returning id, name, slug, address, gstin, contact_phone,
                    contact_email, logo_object_key, warranty_template_text,
                    state_code, pincode, locality, trade_name, msme_number,
                    invoice_number_prefix, invoice_notes
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

  app.put<{ Body: Buffer }>(
    '/api/organisation/logo',
    { schema: { response: { ...errorResponses } } },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'INVALID_IMAGE',
          'Send the logo bytes as an image/png or image/jpeg request body.',
        );
      }
      if (body.length > LOGO_MAX_BYTES) {
        throw httpError(400, 'IMAGE_TOO_LARGE', 'The logo must be 1 MB or smaller.');
      }
      const mediaType = detectImageType(body);
      if (mediaType === null) {
        throw httpError(400, 'INVALID_IMAGE', 'The logo must be a PNG or JPEG image.');
      }
      // Authorisation before the expensive scan (ops batch).
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireOwner(tx, user.id);
      });
      await assertNotMalware(scanner, body);

      const extension = mediaType === 'image/png' ? 'png' : 'jpg';
      const key = `${organisationId}/branding/logo.${extension}`;
      const profile = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
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
        },
      );
      return reply.status(200).send(profile);
    },
  );

  app.get(
    '/api/organisation/logo',
    { schema: { response: { ...errorResponses } } },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const row = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [organisation] = await tx<
            { logo_object_key: string | null; logo_media_type: string | null }[]
          >`
            select logo_object_key, logo_media_type from organisations
          `;
          return organisation ?? null;
        },
      );
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

  app.delete(
    '/api/organisation/logo',
    {
      schema: {
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
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
  // --- Number series (migration 0039) --------------------------------------
  //
  // Number formats belong to the organisation, not to us. Four documents
  // are configurable; a type with no row here uses the product default,
  // which is exactly the format it had before the table existed. Reads
  // are member-wide (an operator should be able to see what their
  // numbers will look like); writes are owner-only, like the rest of the
  // profile.

  app.get(
    '/api/organisation/number-series',
    {
      schema: {
        response: { 200: NumberSeriesListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.put<{
    Params: { documentType: NumberedDocumentType };
    Body: SaveNumberSeriesRequest;
  }>(
    '/api/organisation/number-series/:documentType',
    {
      schema: {
        params: Type.Object(
          { documentType: NumberedDocumentTypeSchema },
          { additionalProperties: false },
        ),
        body: SaveNumberSeriesRequestSchema,
        response: { 200: NumberSeriesSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { documentType } = request.params;
      const template = request.body.template.trim();
      // Proved BEFORE it is stored: a template that cannot be filled in
      // must fail on this screen, not at the moment an operator has a
      // finished document and nowhere to put its number.
      try {
        assertValidTemplate(template, ALLOWED_TOKENS[documentType]);
      } catch (cause) {
        if (cause instanceof NumberTemplateError) {
          throw httpError(400, 'NUMBER_TEMPLATE_INVALID', cause.message);
        }
        throw cause;
      }
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.delete<{ Params: { documentType: NumberedDocumentType } }>(
    '/api/organisation/number-series/:documentType',
    {
      schema: {
        params: Type.Object(
          { documentType: NumberedDocumentTypeSchema },
          { additionalProperties: false },
        ),
        response: { 200: NumberSeriesSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { documentType } = request.params;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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
