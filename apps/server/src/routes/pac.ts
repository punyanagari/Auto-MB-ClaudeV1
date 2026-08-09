import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelPacCertificateRequestSchema,
  PacCertificateListResponseSchema,
  PacCertificateSchema,
  RecordPacCertificateRequestSchema,
  type CancelPacCertificateRequest,
  type PacCapExceededDetails,
  type PacCertificate,
  type PacItemSummary,
  type RecordPacCertificateRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertNotMalware } from '../upload-guards.js';

/**
 * Milestone 8 phase 1: PAC certificate lifecycle (legacy spec §5.5, rule
 * R18). PACs are railway-issued acceptance certificates recorded by
 * office staff (owner/office — not the site evidence role), certifying
 * installed quantities per item, in parts. Per item the certified total
 * across non-cancelled certificates never exceeds the installed total;
 * the cap runs in exact SQL numeric under the work_items row locks, the
 * same discipline installations use. Certificates cancel with a note
 * (releasing their certified quantities); they are never edited or
 * deleted. The reference-level work_instruments rows with kind 'pac'
 * stay untouched — those are banking-reference records, this table is the
 * quantity-bearing certificate.
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'pac_certificates', ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

interface CertificateRow {
  id: string;
  work_id: string;
  reference: string;
  issue_date: string;
  consignee_master_id: string;
  consignee_designation: string;
  status: PacCertificate['status'];
  cancellation_note: string | null;
  document_object_key: string | null;
  items: unknown;
  created_at: Date;
  cancelled_at: Date | null;
}

interface ItemLine {
  workItemId: string;
  itemNumber: string;
  certifiedQuantity: string;
}

function toCertificate(row: CertificateRow): PacCertificate {
  const raw = parseJsonbColumn(row.items);
  const lines: ItemLine[] = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is ItemLine =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as ItemLine).workItemId === 'string' &&
          typeof (entry as ItemLine).certifiedQuantity === 'string',
      )
    : [];
  return {
    id: row.id,
    workId: row.work_id,
    reference: row.reference,
    issueDate: row.issue_date,
    consigneeMasterId: row.consignee_master_id,
    consigneeDesignation: row.consignee_designation,
    status: row.status,
    cancellationNote: row.cancellation_note,
    documentAvailable: row.document_object_key !== null,
    // Released value is DISPLAY-ONLY and never stored (adopted Milestone 8
    // decision): certified qty x item effective rate x PAC stage percent
    // / 100, round2 per line then summed (R13), resolved at read time
    // from the ACTIVE payment matrix.
    // TODO-SEAM(payment-matrix): the per-Work payment matrix lands with
    // the sibling Milestone 8 track; the integrator wires these nulls to
    // its resolver. Until then every released value answers null, which
    // the contract and the web UI already accommodate.
    items: lines.map((line) => ({ ...line, releasedValue: null })),
    releasedValue: null,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

/** Shared SELECT: a certificate with its certified lines (kept after
 * cancellation — the cancelled record's story includes what it had
 * certified). */
const CERTIFICATE_COLUMNS = `
  pc.id, pc.work_id, pc.reference, pc.issue_date::text as issue_date,
  pc.consignee_master_id, pc.consignee_designation, pc.status,
  pc.cancellation_note, pc.document_object_key,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'workItemId', pci.work_item_id,
      'itemNumber', wi.item_number,
      'certifiedQuantity', pci.certified_quantity::text
    ) order by wi.item_number)
    from pac_certificate_items pci
    join work_items wi on wi.id = pci.work_item_id
    where pci.pac_certificate_id = pc.id
  ), '[]'::jsonb) as items,
  pc.created_at, pc.cancelled_at
`;

async function readCertificate(
  tx: TransactionSql,
  id: string,
): Promise<CertificateRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${CERTIFICATE_COLUMNS}
     from pac_certificates pc
     where pc.id = $1`,
    [id],
  )) as unknown as CertificateRow[];
  return rows[0];
}

/** Per-item aggregates for a Work: installed (SUM over non-cancelled
 * installations — the authoritative aggregate from installations.ts),
 * certified (SUM over non-cancelled PAC certificates), and the R18
 * remainder. pacCertifiedQuantity is THE pac_qty the Measurement Book
 * engine will consume (legacy §8) — do not derive it anywhere else. */
async function readItemSummaries(
  tx: TransactionSql,
  workId: string,
): Promise<PacItemSummary[]> {
  const rows = await tx<
    {
      work_item_id: string;
      item_number: string;
      installed_quantity: string;
      pac_certified_quantity: string;
      available_quantity: string;
    }[]
  >`
    select wi.id as work_item_id, wi.item_number,
           installed.total::text as installed_quantity,
           certified.total::text as pac_certified_quantity,
           (installed.total - certified.total)::numeric(18,3)::text as available_quantity
    from work_items wi
    cross join lateral (
      select coalesce((
        select sum(i.quantity) from installations i
        where i.work_item_id = wi.id and i.status = 'recorded'
      ), 0)::numeric(18,3) as total
    ) installed
    cross join lateral (
      select coalesce((
        select sum(pci.certified_quantity)
        from pac_certificate_items pci
        join pac_certificates pc on pc.id = pci.pac_certificate_id
        where pci.work_item_id = wi.id and pc.status = 'recorded'
      ), 0)::numeric(18,3) as total
    ) certified
    where wi.work_id = ${workId} and wi.deleted_at is null
    order by wi.item_number
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    installedQuantity: row.installed_quantity,
    pacCertifiedQuantity: row.pac_certified_quantity,
    availableQuantity: row.available_quantity,
  }));
}

export function registerPacRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  app.get(
    '/api/works/:id/pac-certificates',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = (await tx.unsafe(
          `select ${CERTIFICATE_COLUMNS}
           from pac_certificates pc
           where pc.work_id = $1
           order by pc.issue_date desc, pc.created_at desc, pc.id`,
          [workId],
        )) as unknown as CertificateRow[];
        return {
          certificates: rows.map(toCertificate),
          itemSummaries: await readItemSummaries(tx, workId),
        };
      });
    },
  );

  app.get(
    '/api/pac-certificates/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const row = await readCertificate(tx, id);
        if (!row) {
          throw httpError(404, 'PAC_CERTIFICATE_NOT_FOUND', 'No such PAC certificate.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return toCertificate(row);
      });
    },
  );

  app.post(
    '/api/works/:id/pac-certificates',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordPacCertificateRequestSchema,
        response: { 201: PacCertificateSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as RecordPacCertificateRequest;

      const itemIds = body.items.map((item) => item.workItemId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw httpError(
          400,
          'PAC_ITEMS_DUPLICATED',
          'The same work item appears more than once — merge the quantities.',
        );
      }

      const certificate = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertWorkAccess(tx, user.id, workId);

          const [work] = await tx<{ letter_date: string; today: string }[]>`
            select w.letter_date::text as letter_date,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

          // §5.5, friendly form (the 0022 trigger holds it against every
          // writer): issue date not in the future in the organisation's
          // timezone, not before the LOA letter date.
          if (body.issueDate > work.today) {
            throw httpError(
              400,
              'PAC_DATE_FUTURE',
              `The PAC issue date cannot be in the future (today is ${work.today}).`,
            );
          }
          if (body.issueDate < work.letter_date) {
            throw httpError(
              400,
              'PAC_DATE_BEFORE_LOA',
              `The PAC issue date cannot precede the LOA letter date ${work.letter_date}.`,
            );
          }

          // The issuing consignee: an active master, its designation
          // snapshotted onto the certificate (snapshot-on-use, 0013
          // posture — the FK stays as provenance only).
          const [consignee] = await tx<
            { id: string; designation: string; active: boolean }[]
          >`
            select id, designation, active from consignee_masters
            where id = ${body.consigneeMasterId}
          `;
          if (!consignee) {
            throw httpError(404, 'CONSIGNEE_MASTER_NOT_FOUND', 'No such consignee.');
          }
          if (!consignee.active) {
            throw httpError(
              409,
              'CONSIGNEE_MASTER_RETIRED',
              'This consignee is retired — reactivate it or pick another.',
            );
          }

          // A reference names one live certificate per Work (friendly
          // check; the partial unique index holds it against races).
          const [duplicate] = await tx<{ id: string }[]>`
            select id from pac_certificates
            where work_id = ${workId}
              and lower(reference) = lower(${body.reference})
              and status <> 'cancelled'
          `;
          if (duplicate) {
            throw httpError(
              409,
              'PAC_REFERENCE_EXISTS',
              'A PAC certificate with this reference is already recorded for this Work.',
            );
          }

          // The item row locks serialise every certification (and every
          // installation recording) touching these items: the R18 sums
          // below are read under the locks, so concurrent certifications
          // cannot jointly breach the cap — the same discipline the
          // installation caps use.
          const lockedItems = await tx<{ id: string }[]>`
            select wi.id from work_items wi
            where wi.id = any(${itemIds}::uuid[]) and wi.work_id = ${workId}
              and wi.deleted_at is null
            order by wi.id
            for update of wi
          `;
          if (lockedItems.length !== itemIds.length) {
            throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
          }

          // R18, in exact SQL numeric arithmetic: per item, certified
          // total across non-cancelled certificates plus the requested
          // quantity may not exceed the installed total (SUM over
          // non-cancelled installations — the authoritative aggregate
          // from installations.ts).
          const quantities = body.items.map((item) => item.certifiedQuantity);
          const capRows = await tx<
            {
              work_item_id: string;
              item_number: string;
              installed: string;
              covered: string;
              available: string;
              exceeded: boolean;
            }[]
          >`
            select wi.id as work_item_id, wi.item_number,
                   installed.total::text as installed,
                   covered.total::text as covered,
                   (installed.total - covered.total)::numeric(18,3)::text as available,
                   (req.qty > installed.total - covered.total) as exceeded
            from unnest(${itemIds}::uuid[], ${quantities}::numeric(18,3)[])
              as req(item_id, qty)
            join work_items wi on wi.id = req.item_id
            cross join lateral (
              select coalesce((
                select sum(i.quantity) from installations i
                where i.work_item_id = wi.id and i.status = 'recorded'
              ), 0)::numeric(18,3) as total
            ) installed
            cross join lateral (
              select coalesce((
                select sum(pci.certified_quantity)
                from pac_certificate_items pci
                join pac_certificates pc on pc.id = pci.pac_certificate_id
                where pci.work_item_id = wi.id and pc.status = 'recorded'
              ), 0)::numeric(18,3) as total
            ) covered
            order by wi.item_number
          `;
          const offending = capRows.filter((row) => row.exceeded);
          if (offending.length > 0) {
            const details: PacCapExceededDetails = {
              items: offending.map((row) => ({
                workItemId: row.work_item_id,
                itemNumber: row.item_number,
                installed: row.installed,
                covered: row.covered,
                available: row.available,
              })),
            };
            // R18's requirement: the error states installed, covered and
            // available.
            const message = offending
              .map(
                (row) =>
                  `${row.item_number}: installed ${row.installed}, already certified ${row.covered}, available ${row.available}`,
              )
              .join('; ');
            throw httpError(
              409,
              'PAC_EXCEEDS_INSTALLED',
              `The certified quantity exceeds what installation records support — ${message}.`,
              details,
            );
          }

          const [row] = await tx<{ id: string }[]>`
            insert into pac_certificates (
              organisation_id, work_id, reference, issue_date,
              consignee_master_id, consignee_designation, recorded_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.reference}, ${body.issueDate},
              ${consignee.id}, ${consignee.designation}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'PAC_REFERENCE_EXISTS',
                'A PAC certificate with this reference is already recorded for this Work.',
              );
            }
            throw error;
          });
          if (!row) throw new Error('PAC certificate insert returned no row');

          await tx`
            insert into pac_certificate_items (
              organisation_id, pac_certificate_id, work_id, work_item_id,
              certified_quantity
            )
            select ${organisationId}, ${row.id}, ${workId}, line.item_id, line.qty
            from unnest(${itemIds}::uuid[], ${quantities}::numeric(18,3)[])
              as line(item_id, qty)
          `;

          const full = await readCertificate(tx, row.id);
          if (!full) throw new Error('PAC certificate read-back returned no row');
          await audit(tx, organisationId, user.id, 'pac_certificate.recorded', row.id, {
            workId,
            reference: body.reference,
            issueDate: body.issueDate,
            consigneeMasterId: consignee.id,
            consigneeDesignation: consignee.designation,
            items: body.items.map((item) => ({
              workItemId: item.workItemId,
              certifiedQuantity: item.certifiedQuantity,
            })),
          });
          return toCertificate(full);
        },
      );
      return reply.status(201).send(certificate);
    },
  );

  app.post(
    '/api/pac-certificates/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelPacCertificateRequestSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelPacCertificateRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        // The row lock serialises cancellation against a concurrent
        // cancel; whichever wins, the loser sees the final status.
        const [existing] = await tx<
          { work_id: string; status: string; reference: string }[]
        >`
          select work_id, status, reference from pac_certificates
          where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(404, 'PAC_CERTIFICATE_NOT_FOUND', 'No such PAC certificate.');
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        if (existing.status !== 'recorded') {
          throw httpError(
            409,
            'PAC_CERTIFICATE_ALREADY_CANCELLED',
            'This PAC certificate is already cancelled.',
          );
        }
        // R19-SEAM (Milestone 8 phase 2): once the stage-wise Measurement
        // Book exists, a PAC billed in a live MB must refuse cancellation
        // here (billed sources cannot be cancelled while their MB lives).
        // Phase 1 has no MB sources yet, so nothing blocks.
        await tx`
          update pac_certificates
          set status = 'cancelled', cancellation_note = ${body.note},
              cancelled_by_user_id = ${user.id}, cancelled_at = now()
          where id = ${id}
        `;
        const full = await readCertificate(tx, id);
        if (!full) throw new Error('PAC certificate read-back returned no row');
        // Cancelling releases the certified quantities: the R18 cap sums
        // only non-cancelled certificates, so the freed amounts are
        // certifiable again immediately.
        await audit(tx, organisationId, user.id, 'pac_certificate.cancelled', id, {
          before: { status: 'recorded' },
          after: { status: 'cancelled' },
          reference: existing.reference,
          note: body.note,
        });
        return toCertificate(full);
      });
    },
  );

  app.post(
    '/api/pac-certificates/:id/document',
    {
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the scanned PAC certificate as an application/pdf request body.',
        );
      }
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash travels with the row.
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/pac/${id}-${sha256.slice(0, 16)}.pdf`;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const [existing] = await tx<{ work_id: string; status: string }[]>`
          select work_id, status from pac_certificates
          where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(404, 'PAC_CERTIFICATE_NOT_FOUND', 'No such PAC certificate.');
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        if (existing.status !== 'recorded') {
          throw httpError(
            409,
            'PAC_CERTIFICATE_CANCELLED',
            'This PAC certificate is cancelled; its record is immutable.',
          );
        }
        await storage.put(objectKey, body);
        await tx`
          update pac_certificates
          set document_object_key = ${objectKey}, document_sha256 = ${sha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'pac_certificate.document_uploaded',
          id,
          {
            sizeBytes: body.length,
            sha256,
          },
        );
        const full = await readCertificate(tx, id);
        if (!full) throw new Error('PAC certificate read-back returned no row');
        return toCertificate(full);
      });
    },
  );

  app.get(
    '/api/pac-certificates/:id/document',
    {
      schema: { params: IdParamsSchema },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const key = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [row] = await tx<
            { work_id: string; document_object_key: string | null }[]
          >`
            select work_id, document_object_key from pac_certificates
            where id = ${id}
          `;
          if (!row) {
            throw httpError(
              404,
              'PAC_CERTIFICATE_NOT_FOUND',
              'No such PAC certificate.',
            );
          }
          await assertWorkAccess(tx, user.id, row.work_id);
          if (row.document_object_key === null) {
            throw httpError(
              404,
              'PDF_NOT_AVAILABLE',
              'No scanned document has been uploaded for this PAC certificate.',
            );
          }
          return row.document_object_key;
        },
      );
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="pac-certificate-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
