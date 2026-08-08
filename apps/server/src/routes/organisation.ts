import {
  ApiErrorSchema,
  OrganisationProfileSchema,
  UpdateOrganisationProfileRequestSchema,
  type OrganisationProfile,
  type UpdateOrganisationProfileRequest,
} from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import { jsonb, type Sql, type TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
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

async function requireOwner(tx: TransactionSql, userId: string): Promise<void> {
  const [membership] = await tx<{ role: string }[]>`
    select role from organisation_memberships where user_id = ${userId}
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
  };
}

async function loadProfile(tx: TransactionSql): Promise<ProfileRow> {
  const [row] = await tx<ProfileRow[]>`
    select id, name, slug, address, gstin, contact_phone,
           contact_email, logo_object_key
    from organisations
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
  return row;
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
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireOwner(tx, user.id);
        const current = await loadProfile(tx);
        const next = {
          name: body.name ?? current.name,
          address: body.address !== undefined ? body.address : current.address,
          gstin: body.gstin !== undefined ? body.gstin : current.gstin,
          contact_phone:
            body.contactPhone !== undefined ? body.contactPhone : current.contact_phone,
          contact_email:
            body.contactEmail !== undefined ? body.contactEmail : current.contact_email,
        };
        const [updated] = await tx<ProfileRow[]>`
          update organisations set
            name = ${next.name},
            address = ${next.address},
            gstin = ${next.gstin},
            contact_phone = ${next.contact_phone},
            contact_email = ${next.contact_email},
            updated_at = now()
          where id = ${organisationId}
          returning id, name, slug, address, gstin, contact_phone,
                    contact_email, logo_object_key
        `;
        if (!updated) throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisationId}, ${user.id}, 'organisation.profile_updated',
            'organisations', ${organisationId},
            ${jsonb(tx, { changed: Object.keys(body) })}
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
                      contact_email, logo_object_key
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
}
