import { createHash } from 'node:crypto';
import {
  byItemNumber,
  CancelPacCertificateRequestSchema,
  PacCertificateListResponseSchema,
  PacCertificateSchema,
  RecordPacCertificateRequestSchema,
  type PacCapExceededDetails,
  type PacCertificate,
  type PacCertificationBasis,
  type PacItemSummary,
  type WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { cancellationNote } from './challans.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { addDecimalStrings, computeStageAmounts } from '../mb-remark.js';
import {
  loadPaymentMatrix,
  resolvePaymentPercentages,
  type PaymentMatrixRowData,
} from '../payment-matrix.js';
import { assertSourceNotBilled } from './measurement-books/index.js';
import type { ObjectStorage } from '@auto-mb/documents';
import { assertWorkOperable } from '../work-status.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Milestone 8 phase 1: PAC certificate lifecycle (legacy spec §5.5, rule
 * R18). PACs are railway-issued acceptance certificates recorded by
 * office staff (owner/office — not the site evidence role), certifying
 * installed quantities per item, in parts. Per item the certified total
 * across non-cancelled certificates never exceeds the supporting
 * quantity — the installed total for an installable item, and the
 * sanctioned quantity for an AMC one, which is never installed at all
 * (CERTIFICATION_BASIS_SQL below; migration 0068). The cap runs in exact
 * SQL numeric under the work_items row locks, the same discipline
 * installations use. Certificates cancel with a note
 * (releasing their certified quantities); they are never edited or
 * deleted. The reference-level work_instruments rows with kind 'pac'
 * stay untouched — those are banking-reference records, this table is the
 * quantity-bearing certificate.
 */

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

/** Everything needed to price certified quantities at read time: the
 * Work's payment matrix plus each item's effective rate and category. */
interface ReleasedValueContext {
  readonly matrix: readonly PaymentMatrixRowData[];
  readonly items: ReadonlyMap<
    string,
    { effectiveRate: string; paymentCategory: WorkItemPaymentCategory | null }
  >;
}

async function loadReleasedValueContext(
  tx: TransactionSql,
  workId: string,
): Promise<ReleasedValueContext> {
  const matrix = await loadPaymentMatrix(tx, workId);
  const rows = await tx<
    { id: string; effective_rate: string; payment_category: string | null }[]
  >`
    select id,
           coalesce(effective_unit_rate, effective_rate)::text as effective_rate,
           payment_category
    from work_items
    where work_id = ${workId}
  `;
  return {
    matrix,
    items: new Map(
      rows.map((row) => [
        row.id,
        {
          effectiveRate: row.effective_rate,
          paymentCategory: row.payment_category as WorkItemPaymentCategory | null,
        },
      ]),
    ),
  };
}

/** round2(certified × effective rate × PAC% / 100) via the exact-decimal
 * stage arithmetic (R13: line-rounded, then summed by the caller); null
 * when the item's category has no matrix row to resolve through. */
function lineReleasedValue(
  context: ReleasedValueContext,
  line: ItemLine,
): string | null {
  const item = context.items.get(line.workItemId);
  if (!item) return null;
  const resolution = resolvePaymentPercentages(context.matrix, item.paymentCategory);
  if (!resolution.resolved) return null;
  const { perStage } = computeStageAmounts({
    effectiveRate: item.effectiveRate,
    stages: [
      {
        stage: 'pac',
        percent: resolution.percentages.pctPac,
        deltaQuantity: line.certifiedQuantity,
      },
    ],
  });
  return perStage[0]?.amount ?? null;
}

function toCertificate(
  row: CertificateRow,
  releasedValues: ReleasedValueContext,
): PacCertificate {
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
  // Natural order. The stored aggregate is ordered by `item_number`,
  // which is text, so it holds A1/10 before A1/2; the certificate is
  // read beside the schedule it certifies.
  const priced = byItemNumber(
    lines.map((line) => ({
      ...line,
      releasedValue: lineReleasedValue(releasedValues, line),
    })),
  );
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
    // from the ACTIVE payment matrix. A line whose category has no
    // matrix row answers null; the certificate total sums only when
    // every line resolves (a partial sum would misstate the release).
    items: priced,
    releasedValue:
      priced.length > 0 && priced.every((line) => line.releasedValue !== null)
        ? priced.reduce(
            (sum, line) => addDecimalStrings(sum, line.releasedValue as string),
            '0.00',
          )
        : null,
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

/**
 * The R18 ceiling, as one SQL expression, correlated to a `work_items`
 * alias named `wi`.
 *
 * Written once and interpolated into both places that need it — the
 * per-item read below and the cap check on record — because two spellings
 * of a quantity ceiling is exactly how the screen and the refusal come to
 * disagree, and the screen is the one the operator believes.
 *
 * Two rules. Every installable item caps at its installed total: a
 * certificate accepts work that exists, so it can never certify more
 * than was installed. An AMC item caps at its SANCTIONED quantity
 * instead. Annual maintenance is never installed — migration 0068 makes
 * an installation record naming an AMC item structurally impossible — so
 * the installed rule would cap it at zero, which is the shape of the
 * defect 0068 closes: uncertifiable, therefore unbillable, therefore a
 * Work that can never honestly complete. The sanctioned quantity is the
 * same ceiling R5 already puts on installation, read through the same
 * amendment overlay the completion predicate reads.
 *
 * Contains no interpolated values; it is a constant fragment, and every
 * value around it stays parameterised.
 */
export const CERTIFICATION_BASIS_SQL = `
  case when wi.payment_category = 'AMC'
    then coalesce(wi.effective_quantity, wi.awarded_quantity)
    else coalesce((
      select sum(i.quantity) from installations i
      where i.work_item_id = wi.id and i.status = 'recorded'
    ), 0)
  end::numeric(18,3)
`;

/** Per-item aggregates for a Work: installed (SUM over non-cancelled
 * installations — the authoritative aggregate from installations.ts),
 * the quantity that supports certification (CERTIFICATION_BASIS_SQL),
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
      certification_basis: PacItemSummary['certificationBasis'];
      supporting_quantity: string;
      pac_certified_quantity: string;
      available_quantity: string;
    }[]
  >`
    select wi.id as work_item_id, wi.item_number,
           installed.total::text as installed_quantity,
           case when wi.payment_category = 'AMC' then 'sanctioned' else 'installed' end
             as certification_basis,
           supporting.total::text as supporting_quantity,
           certified.total::text as pac_certified_quantity,
           (supporting.total - certified.total)::numeric(18,3)::text as available_quantity
    from work_items wi
    cross join lateral (
      select coalesce((
        select sum(i.quantity) from installations i
        where i.work_item_id = wi.id and i.status = 'recorded'
      ), 0)::numeric(18,3) as total
    ) installed
    -- Reuses the installed lateral above rather than interpolating
    -- CERTIFICATION_BASIS_SQL, whose else-branch is that same subquery:
    -- this read already reports the installed total as a column of its
    -- own, so re-deriving it would scan installations twice per item for
    -- one number. The rule is identical to the shared fragment's, and
    -- the cap check below -- which reports no installed column -- uses
    -- the fragment.
    cross join lateral (
      select case when wi.payment_category = 'AMC'
               then coalesce(wi.effective_quantity, wi.awarded_quantity)
               else installed.total
             end::numeric(18,3) as total
    ) supporting
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
  // Natural order: `item_number` is text and the SQL sorts A1/10 before
  // A1/2, which is not the order the schedule is written in.
  return byItemNumber(
    rows.map((row) => ({
      workItemId: row.work_item_id,
      itemNumber: row.item_number,
      installedQuantity: row.installed_quantity,
      certificationBasis: row.certification_basis,
      supportingQuantity: row.supporting_quantity,
      pacCertifiedQuantity: row.pac_certified_quantity,
      availableQuantity: row.available_quantity,
    })),
  );
}

export function registerPacRoutes(
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
      url: '/api/works/:id/pac-certificates',
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
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
        const releasedValues = await loadReleasedValueContext(tx, workId);
        return {
          certificates: rows.map((row) => toCertificate(row, releasedValues)),
          itemSummaries: await readItemSummaries(tx, workId),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/pac-certificates/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const row = await readCertificate(tx, id);
        if (!row) {
          throw httpError(404, 'PAC_CERTIFICATE_NOT_FOUND', 'No such PAC certificate.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return toCertificate(row, await loadReleasedValueContext(tx, row.work_id));
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/pac-certificates',
      schema: {
        params: IdParamsSchema,
        body: RecordPacCertificateRequestSchema,
        response: { 201: PacCertificateSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;

      const itemIds = body.items.map((item) => item.workItemId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw httpError(
          400,
          'PAC_ITEMS_DUPLICATED',
          'The same work item appears more than once — merge the quantities.',
        );
      }

      const certificate = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);

        // The works row lock pairs with the one the MB finalize
        // transaction holds, so recording and a final-MB finalize on
        // the same Work serialise: a certificate recorded first is
        // caught by the final sweep, and a final MB finalized first
        // makes this recording fail the FINAL_MB_EXISTS check below
        // (the 0027 insert guard backstops it in the database). Lock
        // order works -> work_items matches every other writer taking
        // both.
        const [work] = await tx<
          { letter_date: string; today: string; status: string }[]
        >`
            select w.letter_date::text as letter_date, w.status,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
            for update of w
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // R8: a completed Work accepts no new operational documents.
        // The works lock above serialises this against completion, and
        // the 0031 insert guard backstops it in the database.
        assertWorkOperable(work.status, 'recording a PAC certificate');

        // A live final Measurement Book closes the Work's payment
        // cycle (spec §5.9): a PAC certificate recorded after it
        // could never be billed, so the recording is refused outright.
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${workId} and is_final and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; a PAC certificate recorded now could never be billed.`,
          );
        }

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
          throw httpError(404, 'CONTACT_NOT_FOUND', 'No such consignee.');
        }
        if (!consignee.active) {
          throw httpError(
            409,
            'CONTACT_RETIRED',
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
        // quantity may not exceed the supporting quantity —
        // CERTIFICATION_BASIS_SQL, which is the installed total for an
        // installable item and the sanctioned quantity for an AMC one.
        const quantities = body.items.map((item) => item.certifiedQuantity);
        const capRows = await tx<
          {
            work_item_id: string;
            item_number: string;
            basis: PacCertificationBasis;
            supporting: string;
            covered: string;
            available: string;
            exceeded: boolean;
          }[]
        >`
            select wi.id as work_item_id, wi.item_number,
                   case when wi.payment_category = 'AMC'
                     then 'sanctioned' else 'installed' end as basis,
                   supporting.total::text as supporting,
                   covered.total::text as covered,
                   (supporting.total - covered.total)::numeric(18,3)::text as available,
                   (req.qty > supporting.total - covered.total) as exceeded
            from unnest(${itemIds}::uuid[], ${quantities}::numeric(18,3)[])
              as req(item_id, qty)
            join work_items wi on wi.id = req.item_id
            cross join lateral (
              select ${tx.unsafe(CERTIFICATION_BASIS_SQL)} as total
            ) supporting
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
            items: byItemNumber(
              offending.map((row) => ({
                workItemId: row.work_item_id,
                itemNumber: row.item_number,
                basis: row.basis,
                supporting: row.supporting,
                covered: row.covered,
                available: row.available,
              })),
            ),
          };
          // R18's requirement: the error states the supporting quantity,
          // what is already covered, and what is left. Two codes rather
          // than one, because the two ceilings have different remedies —
          // an installable item is short of installation records, an AMC
          // item is short of contract, and telling a maintenance clerk to
          // "record the installation" would be an instruction migration
          // 0068's trigger refuses.
          const sanctioned = offending.filter((row) => row.basis === 'sanctioned');
          const message = offending
            .map(
              (row) =>
                `${row.item_number}: ${row.basis === 'sanctioned' ? 'sanctioned' : 'installed'} ${row.supporting}, already certified ${row.covered}, available ${row.available}`,
            )
            .join('; ');
          throw sanctioned.length === offending.length
            ? httpError(
                409,
                'PAC_EXCEEDS_SANCTIONED',
                `The certified quantity exceeds the sanctioned quantity of the maintenance item — ${message}.`,
                details,
              )
            : httpError(
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
        await audit(
          tx,
          organisationId,
          user.id,
          'pac_certificate.recorded',
          'pac_certificates',
          row.id,
          {
            workId,
            reference: body.reference,
            issueDate: body.issueDate,
            consigneeMasterId: consignee.id,
            consigneeDesignation: consignee.designation,
            items: body.items.map((item) => ({
              workItemId: item.workItemId,
              certifiedQuantity: item.certifiedQuantity,
            })),
          },
        );
        return toCertificate(full, await loadReleasedValueContext(tx, workId));
      });
      return reply.status(201).send(certificate);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/pac-certificates/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelPacCertificateRequestSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        // PACs stay an office document, so the writer role still gates
        // site staff out here.
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
        // Cancelling reverses a quantity-ledger contribution — the
        // certified quantities go straight back into the R18 pool — and
        // docs/SECURITY.md holds that sensitive issue/cancel actions
        // require an EXPLICIT authority, which is what every other cancel
        // of a quantity-bearing record already demands (challans,
        // Issue Challans, Measurement Books, correction notices). The
        // move is one-way: the 0022 guard freezes a cancelled certificate
        // forever, so the only repair is re-recording under a reference
        // the partial unique index has just freed. Proven AFTER the
        // work-access gate on purpose, so a cross-tenant or out-of-scope
        // caller keeps reading 404 and never learns the certificate
        // exists.
        await requireAuthority(tx, user.id, 'cancel');
        if (existing.status !== 'recorded') {
          throw httpError(
            409,
            'PAC_CERTIFICATE_CANCELLED',
            'This PAC certificate is already cancelled.',
          );
        }
        // R8: a completed Work's acceptance evidence is frozen — the
        // certificate is part of what admitted the completion, so it
        // cannot be withdrawn behind it. Lock order is the recording
        // path's — own row first, then works — so cancel and completion
        // serialise; the 0032 PAC update guard is the database backstop.
        const [work] = await tx<{ status: string }[]>`
          select status from works
          where id = ${existing.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'cancelling a PAC certificate');
        // R19: a PAC certificate billed in a live Measurement Book
        // cannot be cancelled — the MB must be cancelled first (the
        // 0024 database guard backstops this against every writer).
        await assertSourceNotBilled(tx, 'pac_certificate', id);
        await tx`
          update pac_certificates
          set status = 'cancelled', cancellation_note = ${note},
              cancelled_by_user_id = ${user.id}, cancelled_at = now()
          where id = ${id}
        `;
        const full = await readCertificate(tx, id);
        if (!full) throw new Error('PAC certificate read-back returned no row');
        // Cancelling releases the certified quantities: the R18 cap sums
        // only non-cancelled certificates, so the freed amounts are
        // certifiable again immediately.
        await audit(
          tx,
          organisationId,
          user.id,
          'pac_certificate.cancelled',
          'pac_certificates',
          id,
          {
            before: { status: 'recorded' },
            after: { status: 'cancelled' },
            reference: existing.reference,
            note,
          },
        );
        return toCertificate(full, await loadReleasedValueContext(tx, full.work_id));
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/pac-certificates/:id/document',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: PacCertificateSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the scanned PAC certificate',
      });
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash travels with the row.
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/pac/${id}-${sha256.slice(0, 16)}.pdf`;
      return tenant(async (tx) => {
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
          'pac_certificates',
          id,
          {
            sizeBytes: body.length,
            sha256,
          },
        );
        const full = await readCertificate(tx, id);
        if (!full) throw new Error('PAC certificate read-back returned no row');
        return toCertificate(full, await loadReleasedValueContext(tx, full.work_id));
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/pac-certificates/:id/document',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const key = await tenant(async (tx) => {
        const [row] = await tx<
          { work_id: string; document_object_key: string | null }[]
        >`
            select work_id, document_object_key from pac_certificates
            where id = ${id}
          `;
        if (!row) {
          throw httpError(404, 'PAC_CERTIFICATE_NOT_FOUND', 'No such PAC certificate.');
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
      });
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
