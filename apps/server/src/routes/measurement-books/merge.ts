import {
  MeasurementBookDetailResponseSchema,
  MergeMeasurementBooksRequestSchema,
  type MbSourceRef,
  type MbSourceType,
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
import { readDetail, validateSources } from './internal.js';

/** Merging record Measurement Books into one on-account draft, and
 * unmerging it: the draft's claims are rebuilt from normalised merge
 * provenance rather than recomputed from scratch. */
export function registerMeasurementBookMergeRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/measurement-books/merge',
      schema: {
        params: IdParamsSchema,
        body: MergeMeasurementBooksRequestSchema,
        response: { 201: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      if (new Set(body.recordMbIds).size !== body.recordMbIds.length) {
        throw httpError(
          400,
          'MB_MERGE_DUPLICATED',
          'The same record Measurement Book appears more than once.',
        );
      }
      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // The works lock serialises the merge against create, another
        // merge, finalize, and completion — the create-route lock
        // order (work first, then MB rows).
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
        assertWorkOperable(work.status, 'merging record Measurement Books');
        // The created draft is a BILLING draft: the full register-date
        // discipline of the create route applies to it.
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
        // One billing draft per Work still applies to the draft the
        // merge creates; the friendly check names the open one.
        const [existingDraft] = await tx<{ id: string }[]>`
            select id from measurement_books
            where work_id = ${workId} and status = 'draft' and kind <> 'record'
          `;
        if (existingDraft) {
          throw draftConflictError(
            'MB_DRAFT_EXISTS',
            'This Work already has a draft Measurement Book; finalize or delete it before merging.',
            existingDraft.id,
          );
        }
        // Lock the named record MBs (id order — the un-merge locks
        // them the same way) and hold every one to the rule: a record
        // draft of THIS Work. Another Work's or tenant's MB answers
        // exactly like an unknown id.
        const records = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            kind: string;
            consignee_contact_id: string | null;
          }[]
        >`
            select id, work_id, status, kind, consignee_contact_id
            from measurement_books
            where id = any(${body.recordMbIds}::uuid[])
            order by id
            for update
          `;
        const byId = new Map(records.map((row) => [row.id, row]));
        for (const recordId of body.recordMbIds) {
          const row = byId.get(recordId);
          if (!row || row.work_id !== workId) {
            throw httpError(
              404,
              'MEASUREMENT_BOOK_NOT_FOUND',
              'No such Measurement Book in this Work.',
            );
          }
          if (row.kind !== 'record' || row.status !== 'draft') {
            throw httpError(
              409,
              'MB_MERGE_NOT_RECORD_DRAFT',
              `Only record Measurement Book drafts merge — ${recordId} is a ${row.status} ${row.kind.replace('_', '-')} Measurement Book.`,
            );
          }
        }
        // Everything the records gathered, with its provenance. A
        // record draft's claims are always live (release needs a
        // cancel, and records never cancel), but the filter states
        // the invariant.
        const claims = await tx<
          {
            measurement_book_id: string;
            source_type: MbSourceType;
            source_id: string;
          }[]
        >`
            select measurement_book_id, source_type, source_id
            from mb_sources
            where measurement_book_id = any(${body.recordMbIds}::uuid[])
              and released_at is null
            order by measurement_book_id, source_type, source_id
          `;
        if (claims.length === 0) {
          throw httpError(
            409,
            'MB_MERGE_EMPTY',
            'There is nothing to merge — the record Measurement Books claim no sources.',
          );
        }
        // Row-lock the sources and revalidate their billable state
        // (the finalize discipline), serialising against the source
        // cancel routes.
        const refs = claims.map((claim) => ({
          sourceType: claim.source_type,
          sourceId: claim.source_id,
        }));
        await validateSources(tx, workId, refs, true);
        // The new on-account draft. The partial unique index decides
        // a billing-draft race; the insert guard backstops the final-
        // MB freeze.
        const [target] = await tx<{ id: string }[]>`
            insert into measurement_books (
              organisation_id, work_id, mb_date, kind, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.mbDate}, 'on_account',
              ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_DRAFT_EXISTS',
              'This Work already has a draft Measurement Book; finalize or delete it before merging.',
            );
          }
          throw error;
        });
        if (!target) throw new Error('merge target insert returned no row');
        // Capture ownership while every claim still sits on its source
        // record. The insert guard can therefore prove exact provenance;
        // after the records become merged this ledger accepts no additions.
        // One row per transferred claim, plus a source-less marker row
        // for a record that claimed nothing — written as ONE statement
        // rather than a round-trip per claim.
        const provenanceRows: {
          readonly recordId: string;
          readonly sourceType: MbSourceType | null;
          readonly sourceId: string | null;
        }[] = records.flatMap((record) => {
          const recordClaims = claims.filter(
            (claim) => claim.measurement_book_id === record.id,
          );
          const rows: {
            readonly recordId: string;
            readonly sourceType: MbSourceType | null;
            readonly sourceId: string | null;
          }[] =
            recordClaims.length === 0
              ? [{ recordId: record.id, sourceType: null, sourceId: null }]
              : recordClaims.map((claim) => ({
                  recordId: record.id,
                  sourceType: claim.source_type,
                  sourceId: claim.source_id,
                }));
          return rows;
        });
        await tx`
            insert into measurement_book_merge_provenance (
              organisation_id, target_measurement_book_id,
              record_measurement_book_id, work_id, source_type, source_id,
              created_by_user_id
            )
            select ${organisationId}, ${target.id}, prov.record_id, ${workId},
                   prov.source_type, prov.source_id, ${user.id}
            from unnest(
              ${provenanceRows.map((entry) => entry.recordId)}::uuid[],
              ${provenanceRows.map((entry) => entry.sourceType)}::text[],
              ${provenanceRows.map((entry) => entry.sourceId)}::uuid[]
            ) as prov(record_id, source_type, source_id)
          `;
        // The claim transfer: delete off the records (draft-time
        // claims delete cleanly, 0024), then claim the union on the
        // target. The union has no duplicates — the partial unique
        // index guarantees one live claim per source.
        await tx`
            delete from mb_sources
            where measurement_book_id = any(${body.recordMbIds}::uuid[])
          `;
        const types = claims.map((claim) => claim.source_type);
        const ids = claims.map((claim) => claim.source_id);
        await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, ${target.id}, ${workId}, req.source_type,
                   req.source_id
            from unnest(${types as string[]}::text[], ${ids}::uuid[])
              as req(source_type, source_id)
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_SOURCE_ALREADY_BILLED',
              'A source was claimed by another live Measurement Book while merging.',
            );
          }
          throw error;
        });
        // Mark the records merged, pointing at the draft that
        // absorbed them.
        await tx`
            update measurement_books
            set status = 'merged', merged_into_id = ${target.id}
            where id = any(${body.recordMbIds}::uuid[])
          `;
        // Keep the same rich audit evidence for investigators and export.
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.merged',
          'measurement_books',
          target.id,
          {
            workId,
            mbDate: body.mbDate,
            recordMbIds: records.map((row) => row.id),
            records: records.map((row) => ({
              recordMbId: row.id,
              consigneeContactId: row.consignee_contact_id,
              sources: claims
                .filter((claim) => claim.measurement_book_id === row.id)
                .map((claim) => ({
                  sourceType: claim.source_type,
                  sourceId: claim.source_id,
                })),
            })),
            sourceCount: claims.length,
          },
        );
        return readDetail(tx, target.id);
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'MB_DRAFT_EXISTS', async () => {
          return tenant(async (tx) => {
            const [draft] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind <> 'record'
            `;
            return draft?.id ?? null;
          });
        });
      });
      return reply.status(201).send(detail);
    },
  );

  // Un-merge: the ONLY way to take apart an on-account draft that
  // absorbed record MBs (DELETE answers MB_HAS_MERGED_RECORDS while any
  // exist). Restores each record MB to draft and re-claims, on each
  // record, exactly the sources the merge took from it — read back from
  // normalized merge provenance. Claims the operator added to the target
  // AFTER the merge are simply released with the deleted draft, like
  // any draft deletion. One live claim per source holds at every commit
  // point: the target's claims are deleted and the records' re-inserted
  // inside one transaction.

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/unmerge',
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
            `Only a draft Measurement Book can be un-merged (current status: ${book.status}); once finalized, the merged records are billed for good.`,
          );
        }
        // The absorbed records, locked in id order (the merge's order).
        const absorbed = await tx<
          { id: string; consignee_contact_id: string | null }[]
        >`
          select id, consignee_contact_id from measurement_books
          where merged_into_id = ${id} and status = 'merged'
          order by id
          for update
        `;
        if (absorbed.length === 0) {
          throw httpError(
            409,
            'MB_NO_MERGED_RECORDS',
            'This Measurement Book absorbed no record Measurement Books; delete it instead.',
          );
        }
        // Operational restore state is normalized and constrained. Audit
        // JSON remains evidence only, so format drift cannot strand a merge.
        const provenanceRows = await tx<
          {
            record_measurement_book_id: string;
            source_type: MbSourceType | null;
            source_id: string | null;
          }[]
        >`
          select record_measurement_book_id, source_type, source_id
          from measurement_book_merge_provenance
          where target_measurement_book_id = ${id}
          order by record_measurement_book_id, source_type nulls first, source_id
        `;
        const provenance = new Map<string, MbSourceRef[]>();
        for (const row of provenanceRows) {
          const sources = provenance.get(row.record_measurement_book_id) ?? [];
          if (row.source_type !== null && row.source_id !== null) {
            sources.push({ sourceType: row.source_type, sourceId: row.source_id });
          }
          provenance.set(row.record_measurement_book_id, sources);
        }
        for (const record of absorbed) {
          if (!provenance.has(record.id)) {
            // The merge writes provenance in the same transaction that
            // marks the records, so a hole is corruption, not user error.
            throw new Error(
              `merge provenance for record Measurement Book ${record.id} is missing`,
            );
          }
        }
        // A record draft slot may have been re-occupied since the merge
        // (same Work, same consignee): name it before the index does.
        const [occupied] = await tx<
          { id: string; consignee_contact_id: string | null }[]
        >`
          select id, consignee_contact_id from measurement_books
          where work_id = ${book.work_id} and status = 'draft'
            and kind = 'record'
            and consignee_contact_id = any(${absorbed
              .map((record) => record.consignee_contact_id)
              .filter((value): value is string => value !== null)}::uuid[])
          limit 1
        `;
        if (occupied) {
          throw draftConflictError(
            'MB_RECORD_DRAFT_EXISTS',
            'A newer record Measurement Book draft exists for one of the merged consignees; merge or delete it first.',
            occupied.id,
          );
        }
        // Restore the records to draft. merged_into_id clears in the
        // same statement (the 0034 merged-shape CHECK holds them
        // together); the per-consignee index decides any remaining
        // race.
        await tx`
          update measurement_books
          set status = 'draft', merged_into_id = null
          where merged_into_id = ${id} and status = 'merged'
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_RECORD_DRAFT_EXISTS',
              'A newer record Measurement Book draft exists for one of the merged consignees; merge or delete it first.',
            );
          }
          throw error;
        });
        // Release everything the target claims by deleting its rows
        // (draft-deletion semantics), then re-claim each transferred
        // source on the record it came from. Row-locking the sources
        // revalidates billable state and serialises against cancels —
        // a source deselected from the target after the merge could
        // have moved on, and answers a clean 409 here.
        const restored: MbSourceRef[] = absorbed.flatMap(
          (record) => provenance.get(record.id) ?? [],
        );
        // ACCEPTED DEAD END. This validation is all-or-nothing over the
        // provenance set, and the provenance set is fixed at merge time,
        // so one sequence puts un-merge permanently out of reach: deselect
        // a transferred source from the target (PUT /sources releases its
        // mb_sources claim while its provenance row stays), then cancel
        // that now-unclaimed source document. From then on validateSources
        // answers 409 MB_SOURCE_NOT_BILLABLE on every un-merge attempt,
        // and there is no way back:
        //   - the merged records cannot be cancelled or deleted (both
        //     refuse with MB_STATUS_CONFLICT, pointing at un-merge);
        //   - the target draft cannot be deleted while they point at it
        //     (MB_HAS_MERGED_RECORDS, backed by the 0034 RESTRICT FK);
        //   - un-merge itself is the blocked operation.
        // The operator's ONLY exit is to finalise the target, after which
        // the records stay merged and billed for good (the un-merge route
        // refuses a non-draft book above with exactly that explanation).
        //
        // This is deliberate, not an oversight. A partial restore would
        // silently drop billable work from the record MB it belonged to,
        // and restoring the claim anyway would leave a live Measurement
        // Book claiming a cancelled document. Finalising the target bills
        // the work that is still live and closes the merge honestly, which
        // is the correct answer to "a source I merged has since been
        // cancelled". If this ever needs an operator-facing escape, it
        // belongs in a route that re-derives provenance from the
        // still-billable subset with its own audit trail, not in a
        // loosened check here.
        await validateSources(tx, book.work_id, restored, true);
        await tx`delete from mb_sources where measurement_book_id = ${id}`;
        // Every restored claim in ONE statement: the record each source
        // returns to travels in the array beside it, so the number of
        // round-trips no longer grows with the number of merged records.
        const restoredClaims = absorbed.flatMap((record) =>
          (provenance.get(record.id) ?? []).map((source) => ({
            recordId: record.id,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
          })),
        );
        if (restoredClaims.length > 0) {
          await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, req.record_id, ${book.work_id},
                   req.source_type, req.source_id
            from unnest(
              ${restoredClaims.map((claim) => claim.recordId)}::uuid[],
              ${restoredClaims.map((claim) => claim.sourceType)}::text[],
              ${restoredClaims.map((claim) => claim.sourceId)}::uuid[]
            ) as req(record_id, source_type, source_id)
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MB_SOURCE_ALREADY_BILLED',
                'A transferred source is claimed by another live Measurement Book; resolve that claim first.',
              );
            }
            throw error;
          });
        }
        // The emptied target draft goes, like any deleted draft.
        await tx`delete from measurement_books where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.unmerged',
          'measurement_books',
          id,
          {
            workId: book.work_id,
            recordMbIds: absorbed.map((record) => record.id),
            restoredSourceCount: restored.length,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );
}
