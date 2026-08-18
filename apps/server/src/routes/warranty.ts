import {
  CloseWarrantyRequestSchema,
  ExtendWarrantyRequestSchema,
  KeysetQuerySchema,
  SaveWarrantyTermsRequestSchema,
  StartWarrantyRequestSchema,
  VoidWarrantyRequestSchema,
  WarrantyRegisterQuerySchema,
  WarrantyRegisterResponseSchema,
  WarrantySchema,
  WarrantyTermsSchema,
  WorkWarrantyResponseSchema,
  type ErrorCode,
  type Warranty,
  type WarrantyPbgCover,
  type WarrantyStartBasis,
  type WarrantyTerms,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  cursorRowId,
  keysetPage,
  sqlLimit,
  workScopedCursorRowId,
} from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  audit,
  errorResponses,
  EXPIRY_WARNING_DAYS,
  IdParamsSchema,
} from './shared.js';

/**
 * Defect liability periods (migration 0099).
 *
 * ## The question this module answers
 *
 * A supply-and-installation contract does not end when the units go in:
 * the agency warrants them for a stated period, and the railway holds the
 * Performance Bank Guarantee until that period ends. "What comes out of
 * warranty this quarter" and "can this guarantee be released yet" are the
 * two questions an office asks about it every month, and neither was
 * answerable from the installation records alone.
 *
 * ## What is stored and what is worked out on read
 *
 * Stored: the Work's contract term, and one period per installation
 * carrying the months and the basis it was STARTED under — frozen, so a
 * later correction of the term cannot move an expiry the railway is
 * already holding a guarantee against.
 *
 * Derived on every read, against the ORGANISATION's own calendar date and
 * never against the server's:
 *
 *   `standing`        the stored status with the two date splits folded
 *                     in — `expiring` inside the shared warning window,
 *                     `elapsed` once the last covered day has passed.
 *   `daysToExpiry`    the countdown, negative once elapsed.
 *   `pbgCover`        the Work's latest DLP expiry against the expiry of
 *                     its live PBG instrument, and the shortfall between.
 *
 * None of the three is a column. A stored answer to a question about
 * today is wrong by the next morning, which is the reasoning migration
 * 0084's review already recorded against stored derived state.
 *
 * ## Authority
 *
 * Every write here is `role: 'writer'` (owner or office), and NO new
 * membership authority is added. The reasoning is the one
 * `company-documents.ts` records for itself: the authorities that exist —
 * issue, cancel, statutory, sign, payments, payroll — are authorities
 * over documents this organisation puts its name to or money it moves,
 * and none of those acts happens here. What does happen is that a date
 * the railway's guarantee is measured against gets set, which is office
 * work rather than site work: recording an installation is evidence and
 * stays `evidence`, deciding when its warranty runs is not.
 *
 * Reads ride the installations module's own work-scope: the register
 * filters in SQL by the Works the caller may see, exactly as the
 * installation register does, and the per-Work routes go through
 * `assertWorkAccess`.
 *
 * ## The database's own refusals
 *
 * Migration 0099 raises with SQLSTATEs from the 23Q block, one per rule,
 * so a guard that fires because a route's own check lost a race surfaces
 * as the same 409 the operator would have got from the route — not as an
 * unexplained 500.
 */

const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23Q01': [
    'WARRANTY_INSTALLATION_NOT_RECORDED',
    'The installation was cancelled while the defect liability period was being started.',
  ],
  '23Q02': [
    'WARRANTY_START_OUT_OF_RANGE',
    'A defect liability period starts on or after the installation date, and never in the future.',
  ],
  '23Q03': [
    'WARRANTY_PAC_BASIS_INVALID',
    'The PAC certificate changed while the defect liability period was being started; reload the Work and pick a recorded certificate that certifies this item.',
  ],
  '23Q04': [
    'WARRANTY_STATE',
    'The defect liability period moved on while this was being recorded; reload the Work and read its current state.',
  ],
  '23Q05': [
    'WARRANTY_STATE',
    'The facts a defect liability period was started with cannot be changed; void the period and start it again.',
  ],
  '23Q06': [
    'WARRANTY_EXTENSION_INVALID',
    'A defect liability period is extended forward only, and never past ten years from its start.',
  ],
  '23Q07': [
    'WARRANTY_END_INVALID',
    'Ending a defect liability period records the date, who ended it, and a note; the date is on or after the expiry and never in the future.',
  ],
  '23Q08': [
    'WARRANTY_STATE',
    'A defect liability period is voided with a note rather than removed.',
  ],
  '23Q09': [
    'INSTALLATION_HAS_WARRANTY_PERIOD',
    'Void the defect liability period on this installation before cancelling the record; a period already discharged makes the record permanent.',
  ],
  '23Q10': [
    'WARRANTY_STATE',
    'A warranty term belongs to the Work it was recorded against; record the term on the right Work.',
  ],
  // A second live period against one installation loses the race to the
  // partial unique index rather than to a guard, so it arrives as 23505.
  '23505': [
    'WARRANTY_ALREADY_STARTED',
    'Reload the Work: a defect liability period against this installation was started while this one was being recorded.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/**
 * How many un-started installations the Work's card offers at once.
 *
 * A cap and a flag rather than a page, because this is a PICKER and a
 * picker cannot page — the same posture the correspondence composer's
 * thread options record. Start a period on the ones offered and the next
 * ones appear.
 */
const CANDIDATE_LIMIT = 50;

/** The extension ceiling, in months from the start. Stated here and in
 * `app_private.warranty_expiry`'s callers in migration 0099; the route
 * reads the database's own answer rather than recomputing the date, so
 * only the number is repeated. */
const MAX_DLP_MONTHS = 120;

interface WarrantyRow {
  id: string;
  work_id: string;
  work_code: string;
  work_title: string;
  installation_id: string;
  item_number: string;
  quantity: string;
  installed_on: string;
  location_name: string;
  dlp_months: number;
  start_basis: WarrantyStartBasis;
  pac_reference: string | null;
  dlp_start_on: string;
  original_expires_on: string;
  dlp_expires_on: string;
  status: Warranty['status'];
  standing: Warranty['standing'];
  days_to_expiry: number | null;
  closed_on: string | null;
  closure_note: string | null;
  void_note: string | null;
  created_at: Date;
}

function toWarranty(row: WarrantyRow): Warranty {
  return {
    id: row.id,
    workId: row.work_id,
    workCode: row.work_code,
    workTitle: row.work_title,
    installationId: row.installation_id,
    itemNumber: row.item_number,
    quantity: row.quantity,
    installedOn: row.installed_on,
    locationName: row.location_name,
    dlpMonths: row.dlp_months,
    startBasis: row.start_basis,
    pacReference: row.pac_reference,
    dlpStartOn: row.dlp_start_on,
    originalExpiresOn: row.original_expires_on,
    dlpExpiresOn: row.dlp_expires_on,
    status: row.status,
    standing: row.standing,
    daysToExpiry: row.days_to_expiry,
    closedOn: row.closed_on,
    closureNote: row.closure_note,
    voidNote: row.void_note,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The shared read, wrapped so a caller can filter on the DERIVED columns
 * as well as the stored ones.
 *
 * `$1` is always the warning window in days, so every caller's parameter
 * list starts the same way. "Today" is the organisation's own, read once
 * per statement from the 0082 helper rather than from the server's clock
 * or from `current_date` — a DLP boundary is a legal date, and an office
 * in Nagpur reading its register at 00:30 IST must be told about today,
 * not about yesterday in UTC.
 *
 * `where` is a fixed fragment from this file; every value in it is
 * parameterised.
 */
function warrantyQuery(where: string): string {
  return `
    select * from (
      select
        w.id, w.work_id, wk.work_code, wk.title as work_title,
        w.installation_id, wi.item_number,
        inst.quantity::text as quantity,
        inst.installed_on::text as installed_on,
        inst.location_name,
        w.dlp_months, w.start_basis, pc.reference as pac_reference,
        w.dlp_start_on::text as dlp_start_on,
        w.original_expires_on::text as original_expires_on,
        w.dlp_expires_on::text as dlp_expires_on,
        w.status,
        case
          when w.status <> 'active' then w.status
          when w.dlp_expires_on < today.day then 'elapsed'
          when w.dlp_expires_on <= today.day + $1::int then 'expiring'
          else 'active'
        end as standing,
        case
          when w.status = 'active' then (w.dlp_expires_on - today.day)::int
          else null
        end as days_to_expiry,
        w.closed_on::text as closed_on, w.closure_note, w.void_note,
        w.created_at, w.dlp_start_on as sort_start, w.dlp_expires_on as sort_expiry
      from installation_warranties w
      join installations inst on inst.id = w.installation_id
      join work_items wi on wi.id = inst.work_item_id
      -- A withdrawn Work is invisible everywhere else in the product
      -- (0071 soft-deletes it and every read filters on that), so its
      -- periods must not surface here either. The supersede guard refuses
      -- to withdraw a Work carrying an installation at all, which makes
      -- this unreachable today; a register that would start reporting
      -- ghost rows the day that rule changed is not one to leave open.
      join works wk on wk.id = w.work_id and wk.deleted_at is null
      left join pac_certificates pc on pc.id = w.pac_certificate_id
      cross join (
        select app_private.organisation_today(
          app_private.current_organisation_id()
        ) as day
      ) today
    ) r
    where ${where}`;
}

export function registerWarrantyRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // ------------------------------------------------------------------
  // The Work's warranty card: its term, its guarantee cover, the
  // installations still waiting for a period, and the periods themselves.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/warranty',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: WorkWarrantyResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string; pbg_required: boolean }[]>`
          select id, (pbg_required_amount is not null) as pbg_required
          from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        const terms = await readTerms(tx, workId);

        // Newest period first, so the keyset runs backward on
        // (dlp_start_on, created_at, id) — the trailing id turned
        // descending to match the comparison, exactly as the Work's
        // installation list orders itself. The cursor must name a period
        // OF THIS WORK; one from another Work is refused as
        // CURSOR_INVALID, indistinguishable from a nonexistent id.
        const cursor = await cursorRowId(
          tx,
          'installation_warranties',
          query.cursor,
          workId,
        );
        const rows = (await tx.unsafe(
          `${warrantyQuery(
            `r.work_id = $2
             and ($3::uuid is null
               or (r.sort_start, r.created_at, r.id) < (
                 select c.dlp_start_on, c.created_at, c.id
                 from installation_warranties c where c.id = $3::uuid))`,
          )}
           order by r.sort_start desc, r.created_at desc, r.id desc
           limit $4`,
          [EXPIRY_WARNING_DAYS, workId, cursor, sqlLimit(query.limit)],
        )) as unknown as WarrantyRow[];
        const paged = keysetPage(rows, query.limit, (row) => row.id);

        return {
          terms,
          pbgCover: await readPbgCover(tx, workId, work.pbg_required),
          ...(await readCandidates(tx, workId, terms?.startBasis ?? null)),
          warranties: paged.rows.map(toWarranty),
          nextCursor: paged.nextCursor,
        };
      });
    },
  );

  // ------------------------------------------------------------------
  // The Work's contract term.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/warranty-terms',
      schema: {
        params: IdParamsSchema,
        body: SaveWarrantyTermsRequestSchema,
        response: { 200: WarrantyTermsSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // Deliberately NOT gated on `assertWorkOperable`. The DLP of a
        // completed Work is exactly the period that is still running
        // after completion, and an office recording the contract term
        // late — which is the common case, because nobody looks the
        // clause up until the first installation goes in — must not be
        // refused because the Work has closed.
        const before = await readTerms(tx, workId);
        const notes = body.notes?.trim();
        const [row] = await tx<{ updated_at: Date }[]>`
          insert into work_warranty_terms (
            organisation_id, work_id, dlp_months, start_basis, notes,
            recorded_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${body.dlpMonths}, ${body.startBasis},
            ${notes !== undefined && notes.length > 0 ? notes : null}, ${user.id}
          )
          on conflict (organisation_id, work_id) do update
            set dlp_months = excluded.dlp_months,
                start_basis = excluded.start_basis,
                notes = excluded.notes
          returning updated_at
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('warranty terms upsert returned no row');

        const after = await readTerms(tx, workId);
        if (!after) throw new Error('warranty terms read-back returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          before === null ? 'warranty_terms.recorded' : 'warranty_terms.revised',
          'work_warranty_terms',
          workId,
          {
            workId,
            ...(before === null
              ? {}
              : {
                  before: {
                    dlpMonths: before.dlpMonths,
                    startBasis: before.startBasis,
                  },
                }),
            after: { dlpMonths: after.dlpMonths, startBasis: after.startBasis },
          },
        );
        return after;
      });
    },
  );

  // ------------------------------------------------------------------
  // Starting the clock on one installation.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/installations/:id/warranty',
      schema: {
        params: IdParamsSchema,
        body: StartWarrantyRequestSchema,
        response: { 201: WarrantySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: installationId } = request.params;
      const body = request.body;
      const warranty = await tenant(async (tx) => {
        // The installation row lock is what serialises this against a
        // concurrent cancellation of the same record: the cancel path
        // takes the same lock before it writes, so one of the two waits
        // and then reads the other's committed state. The 0099 insert
        // guard takes a share lock on the same row and backstops the
        // refusal against every other writer.
        const [installation] = await tx<
          {
            id: string;
            work_id: string;
            work_item_id: string;
            item_number: string;
            status: string;
            installed_on: string;
          }[]
        >`
          select inst.id, inst.work_id, inst.work_item_id, wi.item_number,
                 inst.status, inst.installed_on::text as installed_on
          from installations inst
          join work_items wi on wi.id = inst.work_item_id
          where inst.id = ${installationId}
          for update of inst
        `;
        if (!installation) {
          throw httpError(
            404,
            'INSTALLATION_NOT_FOUND',
            'No such installation record.',
          );
        }
        await assertWorkAccess(tx, user.id, installation.work_id);
        if (installation.status !== 'recorded') {
          throw httpError(
            409,
            'WARRANTY_INSTALLATION_NOT_RECORDED',
            'This installation record is cancelled; a defect liability period runs on a recorded installation.',
          );
        }

        const terms = await readTerms(tx, installation.work_id);
        if (terms === null) {
          throw httpError(
            409,
            'WARRANTY_TERMS_NOT_SET',
            "This Work has no defect liability term recorded, so there is nothing to start: the period's length and what starts it come from the contract.",
          );
        }

        const [live] = await tx<{ id: string }[]>`
          select id from installation_warranties
          where installation_id = ${installationId} and status <> 'voided'
        `;
        if (live) {
          throw httpError(
            409,
            'WARRANTY_ALREADY_STARTED',
            'This installation already carries a defect liability period.',
          );
        }

        let startOn = installation.installed_on;
        let pacCertificateId: string | null = null;
        if (terms.startBasis === 'pac') {
          if (body.pacCertificateId === undefined) {
            throw httpError(
              409,
              'WARRANTY_PAC_BASIS_INVALID',
              "This Work's defect liability period runs from provisional acceptance; name the PAC certificate that accepted this item.",
            );
          }
          const [certificate] = await tx<
            { id: string; issue_date: string; status: string; covers: boolean }[]
          >`
            select pc.id, pc.issue_date::text as issue_date, pc.status,
                   exists (
                     select 1 from pac_certificate_items pci
                     where pci.pac_certificate_id = pc.id
                       and pci.work_item_id = ${installation.work_item_id}
                   ) as covers
            from pac_certificates pc
            where pc.id = ${body.pacCertificateId}
              and pc.work_id = ${installation.work_id}
          `;
          // A certificate of another Work answers exactly like an unknown
          // id: no state-specific refusal may confirm a record outside
          // the caller's scope exists.
          if (!certificate) {
            throw httpError(
              404,
              'PAC_CERTIFICATE_NOT_FOUND',
              'No such PAC certificate.',
            );
          }
          if (certificate.status !== 'recorded') {
            throw httpError(
              409,
              'WARRANTY_PAC_BASIS_INVALID',
              'That PAC certificate is cancelled; pick a recorded one.',
            );
          }
          if (!certificate.covers) {
            throw httpError(
              409,
              'WARRANTY_PAC_BASIS_INVALID',
              `PAC certificate ${String(body.pacCertificateId)} does not certify ${installation.item_number}.`,
            );
          }
          if (certificate.issue_date < installation.installed_on) {
            throw httpError(
              409,
              'WARRANTY_START_OUT_OF_RANGE',
              `That certificate was issued on ${certificate.issue_date}, before the units went in on ${installation.installed_on}; a defect liability period cannot start before the installation.`,
            );
          }
          startOn = certificate.issue_date;
          pacCertificateId = certificate.id;
        } else if (body.pacCertificateId !== undefined) {
          throw httpError(
            409,
            'WARRANTY_PAC_BASIS_INVALID',
            "This Work's defect liability period runs from the installation date, so no PAC certificate is involved.",
          );
        }

        // `dlp_expires_on` and `original_expires_on` are deliberately not
        // sent: the 0099 insert guard derives both from
        // `app_private.warranty_expiry`, so the end date has exactly one
        // definition and this route reads it back rather than predicting
        // it (the 0077 posture).
        const [created] = await tx<{ id: string }[]>`
          insert into installation_warranties (
            organisation_id, work_id, installation_id, dlp_months,
            start_basis, pac_certificate_id, dlp_start_on,
            original_expires_on, dlp_expires_on, started_by_user_id
          )
          values (
            ${organisationId}, ${installation.work_id}, ${installationId},
            ${terms.dlpMonths}, ${terms.startBasis}, ${pacCertificateId},
            ${startOn}, ${startOn}, ${startOn}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!created) throw new Error('warranty insert returned no row');

        const full = await readWarranty(tx, created.id);
        await audit(
          tx,
          organisationId,
          user.id,
          'installation_warranty.started',
          'installation_warranties',
          created.id,
          {
            workId: installation.work_id,
            installationId,
            itemNumber: installation.item_number,
            dlpMonths: full.dlpMonths,
            startBasis: full.startBasis,
            dlpStartOn: full.dlpStartOn,
            dlpExpiresOn: full.dlpExpiresOn,
            ...(full.pacReference === null ? {} : { pacReference: full.pacReference }),
          },
        );
        return full;
      });
      return reply.status(201).send(warranty);
    },
  );

  // ------------------------------------------------------------------
  // Extending a live period after a defect was rectified.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/warranties/:id/extend',
      schema: {
        params: IdParamsSchema,
        body: ExtendWarrantyRequestSchema,
        response: { 200: WarrantySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const existing = await lockLiveWarranty(tx, user.id, id);
        if (body.expiresOn <= existing.dlp_expires_on) {
          throw httpError(
            409,
            'WARRANTY_EXTENSION_INVALID',
            `This period already runs to ${existing.dlp_expires_on}; an extension moves the expiry forward.`,
          );
        }
        if (body.expiresOn > existing.ceiling) {
          throw httpError(
            409,
            'WARRANTY_EXTENSION_INVALID',
            `A defect liability period cannot run past ${existing.ceiling} — ten years from its start on ${existing.dlp_start_on}.`,
          );
        }
        await tx`
          update installation_warranties
          set dlp_expires_on = ${body.expiresOn}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        const full = await readWarranty(tx, id);
        // The REASON lives only here. A third table holding extension
        // history would be a second place to look for what the Work's
        // own Timeline already answers, and the timeline is where this
        // product records why a record changed.
        await audit(
          tx,
          organisationId,
          user.id,
          'installation_warranty.extended',
          'installation_warranties',
          id,
          {
            workId: existing.work_id,
            installationId: existing.installation_id,
            before: { dlpExpiresOn: existing.dlp_expires_on },
            after: { dlpExpiresOn: full.dlpExpiresOn },
            reason: body.reason.trim(),
          },
        );
        return full;
      });
    },
  );

  // ------------------------------------------------------------------
  // Closing a period that ran out with nothing outstanding.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/warranties/:id/close',
      schema: {
        params: IdParamsSchema,
        body: CloseWarrantyRequestSchema,
        response: { 200: WarrantySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const existing = await lockLiveWarranty(tx, user.id, id);
        if (body.closedOn < existing.dlp_expires_on) {
          throw httpError(
            409,
            'WARRANTY_END_INVALID',
            `The defect liability period runs to ${existing.dlp_expires_on}; it cannot be discharged on ${body.closedOn}. Wait for the period to run out, or void it if it should never have been started.`,
          );
        }
        if (body.closedOn > existing.today) {
          throw httpError(
            409,
            'WARRANTY_END_INVALID',
            `The closure date cannot be in the future (today is ${existing.today}).`,
          );
        }
        await tx`
          update installation_warranties
          set status = 'closed', closed_on = ${body.closedOn},
              closure_note = ${body.note.trim()},
              closed_by_user_id = ${user.id}, closed_at = now()
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        const full = await readWarranty(tx, id);
        await audit(
          tx,
          organisationId,
          user.id,
          'installation_warranty.closed',
          'installation_warranties',
          id,
          {
            workId: existing.work_id,
            installationId: existing.installation_id,
            before: { status: 'active' },
            after: { status: 'closed' },
            closedOn: body.closedOn,
            note: body.note.trim(),
          },
        );
        return full;
      });
    },
  );

  // ------------------------------------------------------------------
  // Voiding a period that should never have been started. The only way
  // out of a live period, and what releases the installation to be
  // cancelled.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/warranties/:id/void',
      schema: {
        params: IdParamsSchema,
        body: VoidWarrantyRequestSchema,
        response: { 200: WarrantySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const existing = await lockLiveWarranty(tx, user.id, id);
        await tx`
          update installation_warranties
          set status = 'voided', void_note = ${body.note.trim()},
              voided_by_user_id = ${user.id}, voided_at = now()
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        const full = await readWarranty(tx, id);
        await audit(
          tx,
          organisationId,
          user.id,
          'installation_warranty.voided',
          'installation_warranties',
          id,
          {
            workId: existing.work_id,
            installationId: existing.installation_id,
            before: { status: 'active' },
            after: { status: 'voided' },
            note: body.note.trim(),
          },
        );
        return full;
      });
    },
  );

  // ------------------------------------------------------------------
  // The tenant-wide register: what comes out of warranty next.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/warranties',
      schema: {
        querystring: WarrantyRegisterQuerySchema,
        response: { 200: WarrantyRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        // Work-scope, decided in SQL so the rows an 'assigned'-scoped
        // member may not see never leave the database. This is the same
        // predicate the installation register uses, and it is the ONLY
        // thing standing between the two scopes here: a list has no
        // per-row `assertWorkAccess` to fall back on.
        const full = await hasFullWorkScope(tx, user.id);
        const cursor = await workScopedCursorRowId(
          tx,
          'installation_warranties',
          query.cursor,
          { userId: user.id, full },
        );
        // Soonest expiry first, which is the order the question is asked
        // in, so the keyset runs FORWARD on (dlp_expires_on, created_at,
        // id).
        const rows = (await tx.unsafe(
          `${warrantyQuery(
            `($2::boolean or exists (
                select 1 from work_assignments wa
                where wa.work_id = r.work_id and wa.user_id = $3))
             and ($4::text is null or r.standing = $4)
             and ($5::date is null or r.sort_expiry <= $5::date)
             and ($6::uuid is null
               or (r.sort_expiry, r.created_at, r.id) > (
                 select c.dlp_expires_on, c.created_at, c.id
                 from installation_warranties c where c.id = $6::uuid))`,
          )}
           order by r.sort_expiry, r.created_at, r.id
           limit $7`,
          [
            EXPIRY_WARNING_DAYS,
            full,
            user.id,
            query.standing ?? null,
            query.expiresBefore ?? null,
            cursor,
            sqlLimit(query.limit),
          ],
        )) as unknown as WarrantyRow[];
        const paged = keysetPage(rows, query.limit, (row) => row.id);
        return {
          warranties: paged.rows.map(toWarranty),
          nextCursor: paged.nextCursor,
        };
      });
    },
  );
}

interface PacOption {
  readonly id: string;
  readonly reference: string;
  readonly issueDate: string;
}

/** The aggregated certificate list, which postgres.js hands back as raw
 * JSON text like every other jsonb column. */
function toPacOptions(value: unknown): PacOption[] {
  const raw = parseJsonbColumn(value);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is PacOption =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as PacOption).id === 'string' &&
      typeof (entry as PacOption).reference === 'string' &&
      typeof (entry as PacOption).issueDate === 'string',
  );
}

/** The Work's contract term, or null where none has been recorded. */
async function readTerms(
  tx: TransactionSql,
  workId: string,
): Promise<WarrantyTerms | null> {
  const [row] = await tx<
    {
      dlp_months: number;
      start_basis: WarrantyStartBasis;
      notes: string | null;
      updated_at: Date;
    }[]
  >`
    select dlp_months, start_basis, notes, updated_at
    from work_warranty_terms where work_id = ${workId}
  `;
  if (!row) return null;
  return {
    dlpMonths: row.dlp_months,
    startBasis: row.start_basis,
    notes: row.notes,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One period, read back after a write. */
async function readWarranty(tx: TransactionSql, id: string): Promise<Warranty> {
  const rows = (await tx.unsafe(`${warrantyQuery('r.id = $2')} limit 1`, [
    EXPIRY_WARNING_DAYS,
    id,
  ])) as unknown as WarrantyRow[];
  const row = rows[0];
  if (!row) throw new Error('warranty read-back returned no row');
  return toWarranty(row);
}

interface LiveWarrantyRow {
  readonly id: string;
  readonly work_id: string;
  readonly installation_id: string;
  readonly dlp_start_on: string;
  readonly dlp_expires_on: string;
  /** The latest day any extension of this period could reach, from the
   * database's own `app_private.warranty_expiry` rather than from date
   * arithmetic repeated here. */
  readonly ceiling: string;
  /** The organisation's own calendar date, read in the same statement. */
  readonly today: string;
}

/**
 * Locks a period and proves the caller may act on it, in the order those
 * two things have to happen: the row lock serialises this write against a
 * concurrent one, and the work-scope check runs before any refusal that
 * describes the period's STATE, so a caller outside the Work's scope
 * cannot tell a live period from a closed one.
 */
async function lockLiveWarranty(
  tx: TransactionSql,
  userId: string,
  id: string,
): Promise<LiveWarrantyRow> {
  const [row] = await tx<(LiveWarrantyRow & { status: string })[]>`
    select w.id, w.work_id, w.installation_id, w.status,
           w.dlp_start_on::text as dlp_start_on,
           w.dlp_expires_on::text as dlp_expires_on,
           app_private.warranty_expiry(
             w.dlp_start_on, ${MAX_DLP_MONTHS}::int
           )::text as ceiling,
           app_private.organisation_today(w.organisation_id)::text as today
    from installation_warranties w
    where w.id = ${id}
    for update of w
  `;
  if (!row) {
    throw httpError(404, 'WARRANTY_NOT_FOUND', 'No such defect liability period.');
  }
  await assertWorkAccess(tx, userId, row.work_id);
  if (row.status !== 'active') {
    throw httpError(
      409,
      'WARRANTY_STATE',
      row.status === 'closed'
        ? 'This defect liability period is already discharged.'
        : 'This defect liability period is voided.',
    );
  }
  return row;
}

/**
 * Whether the Performance Bank Guarantee outlives the warranty it secures.
 *
 * Derived, never stored. The Work's latest last-covered-day over the
 * periods that were not voided, against the expiry of the live `pbg`
 * instrument it holds. Where either side is missing the shortfall is
 * null — an unanswerable question is not a shortfall of zero.
 *
 * A Work may hold several PBG rows over its life (a renewal is a new
 * instrument). The one that counts is the ACTIVE one reaching furthest
 * out, because that is the cover the railway is actually holding; an
 * active row with no expiry recorded is treated as unanswerable rather
 * than as infinite cover, which is why it is excluded here and reported
 * as a missing date.
 */
async function readPbgCover(
  tx: TransactionSql,
  workId: string,
  requiredByLetter: boolean,
): Promise<WarrantyPbgCover> {
  const [row] = await tx<
    {
      dlp_cover_until: string | null;
      instrument_reference: string | null;
      instrument_expires_on: string | null;
      shortfall_days: number | null;
    }[]
  >`
    select cover.until::text as dlp_cover_until,
           pbg.reference as instrument_reference,
           pbg.expires_on::text as instrument_expires_on,
           case
             when cover.until is null or pbg.expires_on is null then null
             when pbg.expires_on >= cover.until then null
             else (cover.until - pbg.expires_on)::int
           end as shortfall_days
    from (
      select max(dlp_expires_on) as until
      from installation_warranties
      where work_id = ${workId} and status <> 'voided'
    ) cover
    left join lateral (
      select wi.reference, wi.expires_on
      from work_instruments wi
      where wi.work_id = ${workId} and wi.kind = 'pbg'
        and wi.status = 'active' and wi.expires_on is not null
      order by wi.expires_on desc, wi.id
      limit 1
    ) pbg on true
  `;
  return {
    requiredByLetter,
    dlpCoverUntil: row?.dlp_cover_until ?? null,
    instrumentReference: row?.instrument_reference ?? null,
    instrumentExpiresOn: row?.instrument_expires_on ?? null,
    shortfallDays: row?.shortfall_days ?? null,
  };
}

/**
 * Recorded installations of this Work with no live period on them, oldest
 * first — oldest because the one whose warranty should already have
 * started is the one somebody has to act on.
 *
 * On the PAC basis each candidate carries the certificates a period could
 * be started from: recorded, of this Work, certifying that installation's
 * own item, and issued on or after the day the units went in. The list is
 * bounded by the Work's own PAC certificates, which is the same bound
 * `GET /api/works/:id/pac-certificates` already declares.
 */
async function readCandidates(
  tx: TransactionSql,
  workId: string,
  basis: WarrantyStartBasis | null,
): Promise<{
  candidates: {
    installationId: string;
    itemNumber: string;
    quantity: string;
    installedOn: string;
    locationName: string;
    pacOptions: readonly PacOption[];
  }[];
  candidatesTruncated: boolean;
}> {
  // No term, nothing to start: the picker would offer an act the next
  // route refuses.
  if (basis === null) return { candidates: [], candidatesTruncated: false };
  const rows = await tx<
    {
      installation_id: string;
      item_number: string;
      quantity: string;
      installed_on: string;
      location_name: string;
      pac_options: unknown;
    }[]
  >`
    select inst.id as installation_id, wi.item_number,
           inst.quantity::text as quantity,
           inst.installed_on::text as installed_on,
           inst.location_name,
           case when ${basis}::text = 'pac' then coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', pc.id,
               'reference', pc.reference,
               'issueDate', pc.issue_date::text
             ) order by pc.issue_date, pc.reference)
             from pac_certificates pc
             join pac_certificate_items pci
               on pci.pac_certificate_id = pc.id
              and pci.work_item_id = inst.work_item_id
             where pc.work_id = ${workId} and pc.status = 'recorded'
               and pc.issue_date >= inst.installed_on
           ), '[]'::jsonb) else '[]'::jsonb end as pac_options
    from installations inst
    join work_items wi on wi.id = inst.work_item_id
    where inst.work_id = ${workId} and inst.status = 'recorded'
      and not exists (
        select 1 from installation_warranties w
        where w.installation_id = inst.id and w.status <> 'voided'
      )
    order by inst.installed_on, inst.created_at, inst.id
    limit ${CANDIDATE_LIMIT + 1}
  `;
  return {
    candidates: rows.slice(0, CANDIDATE_LIMIT).map((row) => ({
      installationId: row.installation_id,
      itemNumber: row.item_number,
      quantity: row.quantity,
      installedOn: row.installed_on,
      locationName: row.location_name,
      pacOptions: toPacOptions(row.pac_options),
    })),
    candidatesTruncated: rows.length > CANDIDATE_LIMIT,
  };
}
