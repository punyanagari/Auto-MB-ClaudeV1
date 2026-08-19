import {
  CreateMeasurementBookRequestSchema,
  MeasurementBookDetailResponseSchema,
  MeasurementBookListResponseSchema,
  type MbHasMergedRecordsDetails,
  type MeasurementBookKind,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess, requireWriterRole } from '../../authz.js';
import { draftConflictError, nameDraftConflict } from '../../draft-conflict.js';
import { httpError } from '../../http.js';
import { assertWorkOperable } from '../../work-status.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import { BOOK_COLUMNS, readBook, readDetail, toBook } from './internal.js';
import type { BookRow } from './internal.js';

/** Listing, reading, creating and deleting a draft Measurement Book.
 * Drafts recompute their lines from live state on every read, so nothing
 * here snapshots anything. */
export function registerMeasurementBookDraftingRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/measurement-books',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookListResponseSchema, ...errorResponses },
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
          `select ${BOOK_COLUMNS} from measurement_books mb
           where mb.work_id = $1
           order by mb.created_at desc, mb.id`,
          [workId],
        )) as unknown as BookRow[];
        return { books: rows.map(toBook) };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/measurement-books/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/measurement-books',
      schema: {
        params: IdParamsSchema,
        body: CreateMeasurementBookRequestSchema,
        response: { 201: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      // `kind` is the request truth (0034); `isFinal` stays accepted as
      // the pre-0034 alias (true = final, false/absent = on_account). A
      // body naming both must agree with itself.
      if (
        body.kind !== undefined &&
        body.isFinal !== undefined &&
        body.isFinal !== (body.kind === 'final')
      ) {
        throw httpError(
          400,
          'MB_KIND_CONFLICT',
          `The request contradicts itself: kind '${body.kind}' with isFinal ${String(body.isFinal)}.`,
        );
      }
      const kind: MeasurementBookKind =
        body.kind ?? ((body.isFinal ?? false) ? 'final' : 'on_account');
      if (kind === 'record' && body.consigneeContactId === undefined) {
        throw httpError(
          400,
          'MB_CONSIGNEE_REQUIRED',
          'A record Measurement Book names the consignee filling it — consigneeContactId is required.',
        );
      }
      if (kind !== 'record' && body.consigneeContactId !== undefined) {
        throw httpError(
          400,
          'MB_CONSIGNEE_NOT_ALLOWED',
          'Only record Measurement Books name a consignee.',
        );
      }
      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<
          { status: string; letter_date: string; today: string }[]
        >`
            select w.status, w.letter_date::text as letter_date,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
            for update of w
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // R8: a completed Work accepts no new operational documents.
        // The works lock above pairs with the one POST
        // /api/works/:id/complete holds, so a draft MB can never appear
        // behind a completed Work's refusals; the 0031 insert guard
        // backstops it in the database.
        assertWorkOperable(work.status, 'raising a Measurement Book');
        // §5.9, friendly form (the 0024 trigger holds it against every
        // writer): MB date not in the future in the organisation's
        // timezone, not before the LOA letter date.
        if (body.mbDate > work.today) {
          throw httpError(
            400,
            'MB_DATE_FUTURE',
            `The MB date cannot be in the future (today is ${work.today}).`,
          );
        }
        if (body.mbDate < work.letter_date) {
          throw httpError(
            400,
            'MB_DATE_BEFORE_LOA',
            `The MB date cannot precede the LOA letter date ${work.letter_date}.`,
          );
        }
        // §5.9 register order: the MB register's dates must not run
        // backwards behind its gap-free, strictly increasing numbering.
        // MB-02's per-line remarks narrate 'previously billed X, now Y'
        // from the prior-cumulative memory, so an MB dated before its
        // predecessor prints a prior cumulative that, by its own date,
        // had not yet been measured — and the finalized snapshot is
        // immutable, so it can never be corrected. Equal dates pass:
        // several MBs on one day is normal. Checked here only: one
        // BILLING draft per Work (0034) means no MB can be finalized
        // between this draft's creation and its own finalize, so the
        // newest finalized date can only fall (by cancellation)
        // meanwhile, never rise. One indexed read —
        // measurement_books_work_idx already orders by (work_id,
        // status, mb_date desc). Record MBs are exempt: they never
        // take a number, never print the prior-cumulative narration,
        // and their sheet dates flow into nothing — the merged
        // on-account draft carries its own register-checked date.
        if (kind !== 'record') {
          const [newest] = await tx<{ mb_date: string; mb_number: string | null }[]>`
              select mb_date::text as mb_date, mb_number
              from measurement_books
              where work_id = ${workId} and status = 'finalized'
              order by mb_date desc
              limit 1
            `;
          if (newest && body.mbDate < newest.mb_date) {
            throw httpError(
              400,
              'MB_DATE_BEFORE_PREVIOUS',
              `The MB date cannot precede ${newest.mb_number ?? 'the previous Measurement Book'}, dated ${newest.mb_date}.`,
            );
          }
        }
        // A record MB names an ACTIVE consignee-role contact (the
        // 0034 FK holds existence; role and lifecycle are checked here
        // like every other contact picker).
        if (kind === 'record' && body.consigneeContactId !== undefined) {
          const [contact] = await tx<
            { id: string; is_consignee: boolean; active: boolean }[]
          >`
              select id, is_consignee, active from contacts
              where id = ${body.consigneeContactId}
            `;
          if (!contact) {
            throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
          }
          if (!contact.is_consignee) {
            throw httpError(
              409,
              'CONTACT_NOT_CONSIGNEE',
              'A record Measurement Book is filled by a consignee contact; this contact does not carry the consignee role.',
            );
          }
          if (!contact.active) {
            throw httpError(
              409,
              'CONTACT_RETIRED',
              'This consignee is retired — reactivate it or pick another.',
            );
          }
        }
        // No further MBs once a live final MB exists (friendly form;
        // the 0024 insert guard holds it against every writer —
        // record sheets included: nothing they gather could ever be
        // billed past the final MB).
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${workId} and is_final and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; no further Measurement Books can be raised.`,
          );
        }
        // The 0034 draft rules, friendly form (the two partial unique
        // indexes decide races; the catches rebuild the same 409s):
        // exactly one BILLING draft (on-account or final) per Work,
        // and one record draft per consignee — record sheets run in
        // parallel across consignees by design.
        if (kind === 'record') {
          const [existingRecord] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind = 'record'
                and consignee_contact_id = ${body.consigneeContactId ?? null}
            `;
          if (existingRecord) {
            throw draftConflictError(
              'MB_RECORD_DRAFT_EXISTS',
              'This consignee already has an open record Measurement Book on this Work; merge or delete it first.',
              existingRecord.id,
            );
          }
        } else {
          const [existingDraft] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind <> 'record'
            `;
          if (existingDraft) {
            throw draftConflictError(
              'MB_DRAFT_EXISTS',
              'This Work already has a draft Measurement Book; finalize or delete it first.',
              existingDraft.id,
            );
          }
        }
        // 0034 made is_final a GENERATED column: the insert names
        // `kind`, never is_final.
        const [row] = await tx<{ id: string }[]>`
            insert into measurement_books (
              organisation_id, work_id, mb_date, kind, consignee_contact_id,
              created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.mbDate}, ${kind},
              ${body.consigneeContactId ?? null}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              kind === 'record' ? 'MB_RECORD_DRAFT_EXISTS' : 'MB_DRAFT_EXISTS',
              kind === 'record'
                ? 'This consignee already has an open record Measurement Book on this Work; merge or delete it first.'
                : 'This Work already has a draft Measurement Book; finalize or delete it first.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('measurement book insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.created',
          'measurement_books',
          row.id,
          {
            workId,
            mbDate: body.mbDate,
            kind,
            isFinal: kind === 'final',
            ...(kind === 'record'
              ? { consigneeContactId: body.consigneeContactId }
              : {}),
          },
        );
        return readDetail(tx, row.id);
      }).catch(async (error: unknown) => {
        const conflictCode =
          kind === 'record' ? 'MB_RECORD_DRAFT_EXISTS' : 'MB_DRAFT_EXISTS';
        throw await nameDraftConflict(error, conflictCode, async () => {
          return tenant(async (tx) => {
            const [draft] =
              kind === 'record'
                ? await tx<{ id: string }[]>`
                    select id from measurement_books
                    where work_id = ${workId} and status = 'draft'
                      and kind = 'record'
                      and consignee_contact_id = ${body.consigneeContactId ?? null}
                  `
                : await tx<{ id: string }[]>`
                    select id from measurement_books
                    where work_id = ${workId} and status = 'draft'
                      and kind <> 'record'
                  `;
            return draft?.id ?? null;
          });
        });
      });
      return reply.status(201).send(detail);
    },
  );

  // Merge: record drafts -> ONE new on-account draft (0034). The design
  // note, because the mechanics matter: mb_sources claims cannot be
  // released outside a cancel (the 0024 release guard), so the merge
  // does NOT move rows — it DELETES the records' claims (legal while
  // they are still drafts) and INSERTS fresh claims on the new target
  // in the same transaction. At every commit point each source has
  // exactly one live claim (the partial unique index never lapses);
  // provenance — which source came from which record — is written into
  // a constrained tenant table. Audit JSON stays human-readable evidence,
  // but operational un-merge never depends on its mutable shape.

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/measurement-books/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const [book] = await tx<{ id: string; work_id: string; status: string }[]>`
          select id, work_id, status from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            book.status === 'merged'
              ? 'Merged record Measurement Books are not deleted — un-merge the Measurement Book that absorbed them instead.'
              : 'Only draft Measurement Books can be deleted; finalized ones cancel with a note.',
          );
        }
        // A draft that absorbed record MBs cannot simply vanish: the
        // records point at it (0034 RESTRICT FK) and their sources live
        // on it. The un-merge endpoint is the one honest way to take it
        // apart — it puts the records back first.
        const merged = await tx<{ id: string }[]>`
          select id from measurement_books
          where merged_into_id = ${id} and status = 'merged'
          order by id
        `;
        if (merged.length > 0) {
          const details: MbHasMergedRecordsDetails = {
            recordMbIds: merged.map((row) => row.id),
          };
          throw httpError(
            409,
            'MB_HAS_MERGED_RECORDS',
            'This Measurement Book absorbed record Measurement Books; un-merge it instead so the records and their sources are restored.',
            details,
          );
        }
        // Deleting the draft removes its claims entirely — the sources
        // return to the open pool with no residue. Its measured-quantity
        // adjustments go the same way: they are instructions to a
        // computation that is about to stop existing (migration 0106).
        await tx`delete from mb_measured_overrides where measurement_book_id = ${id}`;
        await tx`delete from mb_sources where measurement_book_id = ${id}`;
        await tx`delete from measurement_books where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.deleted',
          'measurement_books',
          id,
          {
            workId: book.work_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  // Bill preparation FROM a finalized, un-billed Measurement Book
  // (ADR-0006 decision 2; replaces the Milestone 5 sweep of unbilled
  // mb_entries). Amount = the MB's snapshotted total; lines_snapshot
  // carries the MB's lines verbatim; bills.mb_id links 1:1.
}
