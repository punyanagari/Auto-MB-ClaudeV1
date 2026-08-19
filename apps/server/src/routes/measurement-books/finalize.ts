import {
  MB_NOT_SELECTED_CATEGORY,
  BillSchema,
  CancelMeasurementBookRequestSchema,
  MeasurementBookDetailResponseSchema,
  type Bill,
  type MbFinalSweepDetails,
  type MbNotNewestDetails,
  type MbPercentagesUnresolvedDetails,
  type MbSourceType,
  type MeasurementBookKind,
  type WorkCompletionBlocker,
  type WorkNotCleanDetails,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess } from '../../authz.js';
import { httpError } from '../../http.js';
import { parseJsonbColumn } from '../../jsonb-column.js';
import { lineHasQuantity } from '../../mb-compute.js';
import { MB_REMARK_TEMPLATE_VERSION } from '../../mb-remark.js';
import { assertWorkOperable } from '../../work-status.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  computeForBook,
  readDetail,
  readStoredLines,
  SOURCE_LABELS,
  validateSources,
} from './internal.js';

/** The money moments: finalize (numbering, the snapshotted lines and
 * their remark text, under the Work row lock), cancel (newest-only, with
 * a mandatory note, releasing its sources), and preparing the bill a
 * finalized Measurement Book supports. */
export function registerMeasurementBookFinalizeRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/finalize',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        // Finalizing assigns a legal number and freezes a financial
        // snapshot: issue authority required, like bill preparation.
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            kind: MeasurementBookKind;
            is_final: boolean;
          }[]
        >`
          select id, work_id, status, kind, is_final from measurement_books
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
        // A record MB is one consignee's parallel sheet — it never
        // takes a number and never bills (the 0034 status coherence
        // holds it in the database). Everything it gathers flows onward
        // through the merge.
        if (book.kind === 'record') {
          throw httpError(
            409,
            'MB_RECORD_NOT_BILLABLE',
            'Record Measurement Books are never finalized — merge them into an on-account Measurement Book and finalize that.',
          );
        }
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Only draft Measurement Books can be finalized (current status: ${book.status}).`,
          );
        }
        // The Work row lock serialises numbering AND the prior-
        // cumulative reads against every other finalize on this Work.
        const [work] = await tx<{ id: string; work_code: string }[]>`
          select id, work_code from works
          where id = ${book.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // Row-lock every selected source and revalidate its billable
        // state from live rows: a source cancelled between draft and
        // finalize surfaces here as a clean 409, never a broken write.
        const claimed = await tx<{ source_type: MbSourceType; source_id: string }[]>`
          select source_type, source_id from mb_sources
          where measurement_book_id = ${id}
          order by source_type, source_id
        `;
        await validateSources(
          tx,
          book.work_id,
          claimed.map((claim) => ({
            sourceType: claim.source_type,
            sourceId: claim.source_id,
          })),
          true,
        );

        // The final MB must sweep EVERY remaining open billable source
        // of the Work (spec §5.9). Open = billable state and no live
        // claim by any MB; this draft's own claims are already live.
        if (book.is_final) {
          // The adopted CLEAN-STATE rule, one layer over from Work
          // completion (completionBlockers in work-completion.ts): a
          // draft delivery or issue challan is invisible to the sweep
          // below, which only sees sources already in their billable
          // state. Finalizing over it strands it forever — the 0031
          // guard refuses its issue for as long as a live final MB
          // exists, so it can never become evidence, never reach the
          // ledger, and nothing tells the operator why. So refuse, and
          // name every one. Note the remedy: 'issue it instead' is NOT
          // available while this book exists, because that same guard
          // counts a DRAFT final MB as live — the drafts are deleted, or
          // this book is deleted first and raised again after they are
          // issued. The Work row lock above serialises the check against
          // a concurrent issue attempt on the same draft.
          const openDrafts = await tx<
            { kind: WorkCompletionBlocker['kind']; record_id: string; label: string }[]
          >`
            select 'draft_delivery_challan' as kind, dc.id as record_id,
                   'Draft delivery challan dated ' || dc.challan_date::text as label
            from delivery_challans dc
            where dc.work_id = ${book.work_id} and dc.status = 'draft'
            union all
            select 'draft_issue_challan', ic.id,
                   'Draft issue challan dated ' || ic.challan_date::text
            from issue_challans ic
            where ic.work_id = ${book.work_id} and ic.status = 'draft'
            order by 1, 3
          `;
          if (openDrafts.length > 0) {
            // Same details shape the Work-completion 409 answers with,
            // so a client renders one worklist for both refusals.
            const details: WorkNotCleanDetails = {
              blockers: openDrafts.map((row) => ({
                kind: row.kind,
                recordId: row.record_id,
                label: row.label,
              })),
            };
            const names = openDrafts.map((row) => row.label).join('; ');
            throw httpError(
              409,
              'MB_FINAL_DRAFTS_OPEN',
              `The final Measurement Book closes this Work's payment cycle, so nothing may still be open — ${names}. Delete each draft, or delete this Measurement Book, issue them, and raise the final Measurement Book again so the sweep picks them up.`,
              details,
            );
          }

          const missed = await tx<
            { source_type: MbSourceType; source_id: string; label: string | null }[]
          >`
            select 'delivery_challan' as source_type, dc.id as source_id,
                   dc.challan_number as label
            from delivery_challans dc
            where dc.work_id = ${book.work_id} and dc.status = 'issued'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'delivery_challan' and ms.source_id = dc.id
                  and ms.released_at is null
              )
            union all
            select 'installation', i.id,
                   (select wi.item_number from work_items wi
                     where wi.id = i.work_item_id) || ' x ' || i.quantity::text
            from installations i
            where i.work_id = ${book.work_id} and i.status = 'recorded'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'installation' and ms.source_id = i.id
                  and ms.released_at is null
              )
            union all
            select 'pac_certificate', pc.id, pc.reference
            from pac_certificates pc
            where pc.work_id = ${book.work_id} and pc.status = 'recorded'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'pac_certificate' and ms.source_id = pc.id
                  and ms.released_at is null
              )
            order by 1, 3
          `;
          if (missed.length > 0) {
            const details: MbFinalSweepDetails = {
              missedSources: missed.map((row) => ({
                sourceType: row.source_type,
                sourceId: row.source_id,
                label: row.label ?? row.source_id,
              })),
            };
            const names = missed
              .map(
                (row) =>
                  `${SOURCE_LABELS[row.source_type]} ${row.label ?? row.source_id}`,
              )
              .join('; ');
            throw httpError(
              409,
              'MB_FINAL_SWEEP_INCOMPLETE',
              `The final Measurement Book must sweep every open source of the Work — missing: ${names}.`,
              details,
            );
          }
        }

        // Recompute everything from live state under the locks.
        const computation = await computeForBook(tx, book);
        if (computation.unresolved.length > 0) {
          const details: MbPercentagesUnresolvedDetails = {
            items: [...computation.unresolved],
          };
          // Two different remedies, so two different sentences. An item
          // with no category chosen (migration 0105) needs a decision,
          // not a matrix row, and telling its operator to "add the
          // missing NOT_SELECTED row" would send them looking for a row
          // that cannot exist.
          const names = computation.unresolved
            .map((item) =>
              item.missingCategory === MB_NOT_SELECTED_CATEGORY
                ? `${item.itemNumber} (no payment category chosen)`
                : `${item.itemNumber} (missing ${item.missingCategory} row)`,
            )
            .join('; ');
          throw httpError(
            409,
            'MB_PERCENTAGES_UNRESOLVED',
            `The payment matrix cannot price every item on this Measurement Book — ${names}. Choose a payment category for every item named, add the missing matrix rows, and retry.`,
            details,
          );
        }
        // THE SANCTIONED QUANTITY BINDS THE MONEY, AND IT BINDS IT IN THE
        // COMPUTATION, NOT HERE (owner ruling, 2026-08-17: "Final MB can
        // be done even if excess installation variation is not processed
        // — sometimes we have to work free for the Railways"). Migration
        // 0077 lets site install past the sanction; `clampToSanctioned`
        // in mb-compute.ts then bills min(measured, sanctioned) on every
        // stage measured on physical work, so the excess is left unbilled
        // rather than refused. Nothing is checked at this route because
        // there is nothing left to refuse — and the operator's preview,
        // the draft PDF and this snapshot are the same numbers precisely
        // because the decision is made in one place upstream of all
        // three.
        //
        // An empty book is still refused, and the clamp cannot make a
        // FINAL book empty — which is what has to be true for the ruling
        // to hold with this check unchanged. A final book computes the
        // final-bill stage, whose base is the item's LIFETIME measurement
        // clamped at the sanction, not a delta over selected sources. So
        // an item that measured anything at all carries a positive
        // final-bill delta on the final book even when every other stage
        // clamps to nothing, and the book has a line. Only a Work that
        // measured nothing whatsoever reaches this refusal, which is what
        // it always meant.
        //
        // A LINE MAY NOW BE PRESENT AND MEASURE NOTHING (migration 0106):
        // an operator who adjusts an item's measured quantity down to
        // zero keeps its line in the preview, so the field they typed
        // into is still there to undo. That is a draft affordance, not a
        // book — so the refusal asks the question it always asked, "is
        // there anything to bill", of the quantities rather than of the
        // line count.
        if (!computation.lines.some(lineHasQuantity)) {
          throw httpError(
            409,
            'MB_EMPTY',
            'This Measurement Book has nothing to bill — select sources with unbilled quantities first.',
          );
        }

        // Gapless <work_code>-MB-NN under the counter row lock (0014
        // mechanics): concurrent finalizes serialise here; rollback
        // rolls the number back with the transaction.
        const [counter] = await tx<{ next_value: number }[]>`
          insert into measurement_book_counters (organisation_id, work_id)
          values (${organisationId}, ${book.work_id})
          on conflict (organisation_id, work_id)
          do update set next_value = measurement_book_counters.next_value + 1,
                        updated_at = now()
          returning next_value
        `;
        if (!counter)
          throw new Error('measurement book counter upsert returned no row');
        const sequence = counter.next_value;
        const mbNumber = `${work.work_code}-MB-${String(sequence).padStart(2, '0')}`;

        // Snapshot the lines while the book is still draft (the line
        // guard requires it), then stamp the finalized shape.
        //
        // ONE statement for every line, not one per line: a Work with a
        // few hundred items paid a round-trip each, inside the Work row
        // lock every other finalize of the Work is queued behind. Each
        // money and quantity figure travels as the exact decimal STRING
        // computeMeasurementBook produced and is cast by PostgreSQL to
        // the column's own numeric type — the same path a per-row
        // parameter took, and still never through a JS float.
        const lines = computation.lines;
        await tx`
          insert into measurement_book_lines (
            organisation_id, measurement_book_id, work_id, work_item_id,
            item_number, description, unit_code, payment_category,
            resolved_category, pct_supply, pct_installation, pct_pac,
            pct_final_bill, effective_rate,
            delta_supplied, delta_installed, delta_pac, delta_final_bill,
            prior_supplied, prior_installed, prior_pac, prior_final_bill,
            amount_supply, amount_installation, amount_pac, amount_final_bill,
            line_total, remark
          )
          select ${organisationId}, ${id}, ${book.work_id}, mbl.work_item_id,
                 mbl.item_number, mbl.description, mbl.unit_code,
                 mbl.payment_category, mbl.resolved_category,
                 mbl.pct_supply, mbl.pct_installation, mbl.pct_pac,
                 mbl.pct_final_bill, mbl.effective_rate,
                 mbl.delta_supplied, mbl.delta_installed, mbl.delta_pac,
                 mbl.delta_final_bill,
                 mbl.prior_supplied, mbl.prior_installed, mbl.prior_pac,
                 mbl.prior_final_bill,
                 mbl.amount_supply, mbl.amount_installation, mbl.amount_pac,
                 mbl.amount_final_bill,
                 mbl.line_total, mbl.remark
          from unnest(
            ${lines.map((line) => line.workItemId)}::uuid[],
            ${lines.map((line) => line.itemNumber)}::text[],
            ${lines.map((line) => line.description)}::text[],
            ${lines.map((line) => line.unitCode)}::text[],
            ${lines.map((line) => line.paymentCategory)}::text[],
            ${lines.map((line) => line.resolvedCategory)}::text[],
            ${lines.map((line) => line.percentages.pctSupply)}::numeric(5,2)[],
            ${lines.map((line) => line.percentages.pctInstallation)}::numeric(5,2)[],
            ${lines.map((line) => line.percentages.pctPac)}::numeric(5,2)[],
            ${lines.map((line) => line.percentages.pctFinalBill)}::numeric(5,2)[],
            ${lines.map((line) => line.effectiveRate)}::numeric(18,6)[],
            ${lines.map((line) => line.deltaSupplied)}::numeric(18,3)[],
            ${lines.map((line) => line.deltaInstalled)}::numeric(18,3)[],
            ${lines.map((line) => line.deltaPac)}::numeric(18,3)[],
            ${lines.map((line) => line.deltaFinalBill)}::numeric(18,3)[],
            ${lines.map((line) => line.priorSupplied)}::numeric(18,3)[],
            ${lines.map((line) => line.priorInstalled)}::numeric(18,3)[],
            ${lines.map((line) => line.priorPac)}::numeric(18,3)[],
            ${lines.map((line) => line.priorFinalBill)}::numeric(18,3)[],
            ${lines.map((line) => line.amountSupply)}::numeric(18,2)[],
            ${lines.map((line) => line.amountInstallation)}::numeric(18,2)[],
            ${lines.map((line) => line.amountPac)}::numeric(18,2)[],
            ${lines.map((line) => line.amountFinalBill)}::numeric(18,2)[],
            ${lines.map((line) => line.lineTotal)}::numeric(18,2)[],
            ${lines.map((line) => line.remark)}::text[]
          ) as mbl(
            work_item_id, item_number, description, unit_code, payment_category,
            resolved_category, pct_supply, pct_installation, pct_pac,
            pct_final_bill, effective_rate,
            delta_supplied, delta_installed, delta_pac, delta_final_bill,
            prior_supplied, prior_installed, prior_pac, prior_final_bill,
            amount_supply, amount_installation, amount_pac, amount_final_bill,
            line_total, remark
          )
        `;
        await tx`
          update measurement_books
          set status = 'finalized', mb_number = ${mbNumber},
              sequence_number = ${sequence},
              total_amount = ${computation.totalAmount},
              remark_template_version = ${MB_REMARK_TEMPLATE_VERSION},
              finalized_by_user_id = ${user.id}, finalized_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.finalized',
          'measurement_books',
          id,
          {
            before: { status: 'draft' },
            after: { status: 'finalized' },
            workId: book.work_id,
            mbNumber,
            sequence,
            totalAmount: computation.totalAmount,
            isFinal: book.is_final,
            lineCount: computation.lines.length,
            remarkTemplateVersion: MB_REMARK_TEMPLATE_VERSION,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelMeasurementBookRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            sequence_number: number | null;
            mb_number: string | null;
            closed_at: Date | null;
          }[]
        >`
          select id, work_id, status, sequence_number, mb_number, closed_at
          from measurement_books
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
        if (book.status === 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Draft Measurement Books are deleted, not cancelled.',
          );
        }
        // A merged record has no life of its own to cancel: its sources
        // moved into the on-account draft that absorbed it (0034 status
        // coherence — records only draft or merge).
        if (book.status === 'merged') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Merged record Measurement Books are not cancelled — un-merge the Measurement Book that absorbed them instead.',
          );
        }
        if (book.status === 'cancelled') {
          throw httpError(
            409,
            'MB_ALREADY_CANCELLED',
            'This Measurement Book is already cancelled.',
          );
        }
        // A measurement the railway has settled cannot be withdrawn: the
        // received bill that closed it would be left describing a
        // measurement that no longer exists. The 0066 guard refuses this
        // too — which is exactly why the check belongs here as well,
        // because a database refusal with no route in front of it reaches
        // the operator as a 500 rather than as a sentence.
        if (book.closed_at !== null) {
          throw httpError(
            409,
            'MB_ALREADY_CLOSED',
            'The railway has settled this measurement, so it can no longer be cancelled.',
          );
        }
        // The Work row lock serialises cancel against a concurrent
        // finalize of the same Work's draft (finalize holds this lock
        // for its prior-cumulative reads and numbering). Lock order
        // matches finalize — own MB row first, then the works row — so
        // the two transactions cannot deadlock, and the newest/billed
        // checks below always run against committed finalize state.
        // The 0027 guard_measurement_book_update backstops both checks
        // in the database against every writer.
        const [workRow] = await tx<{ id: string; status: string }[]>`
          select id, status from works
          where id = ${book.work_id} and deleted_at is null
          for update
        `;
        if (!workRow) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // R8: a completed Work's measurement record is frozen — releasing
        // this book's sources would reopen quantities the completion was
        // measured against. The works lock above serialises this against
        // completion, and the 0032 Measurement Book update guard backstops
        // the refusal in the database.
        assertWorkOperable(workRow.status, 'cancelling a Measurement Book');
        // Only the newest live MB may be cancelled (deltas must stay
        // coherent, spec §5.9).
        const [newer] = await tx<{ id: string; mb_number: string | null }[]>`
          select id, mb_number from measurement_books
          where work_id = ${book.work_id} and status = 'finalized'
            and sequence_number > ${book.sequence_number ?? 0}
          order by sequence_number desc
          limit 1
        `;
        if (newer) {
          const details: MbNotNewestDetails = {
            newerMeasurementBookId: newer.id,
            newerMbNumber: newer.mb_number,
          };
          throw httpError(
            409,
            'MB_NOT_NEWEST',
            `Only the newest live Measurement Book may be cancelled — cancel ${newer.mb_number ?? newer.id} first.`,
            details,
          );
        }
        // A billed MB is permanently locked (ADR-0006 decision 3: bills
        // cannot be cancelled, so corrections happen as compensating
        // entries on a subsequent MB).
        const [bill] = await tx<{ id: string; bill_number: number }[]>`
          select id, bill_number from bills where mb_id = ${id}
        `;
        if (bill) {
          throw httpError(
            409,
            'MB_BILLED',
            `Bill #${String(bill.bill_number)} was prepared from this Measurement Book; billed Measurement Books cannot be cancelled — correct with compensating entries on the next MB.`,
          );
        }
        await tx`
          update measurement_books
          set status = 'cancelled', cancellation_note = ${body.note},
              cancelled_by_user_id = ${user.id}, cancelled_at = now()
          where id = ${id}
        `;
        // Cancelling releases the sources for a corrected MB: the
        // claims stay as history with released_at stamped, and the
        // partial unique index frees the slots immediately.
        const released = await tx<{ id: string }[]>`
          update mb_sources
          set released_at = now()
          where measurement_book_id = ${id} and released_at is null
          returning id
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.cancelled',
          'measurement_books',
          id,
          {
            before: { status: 'finalized' },
            after: { status: 'cancelled' },
            workId: book.work_id,
            mbNumber: book.mb_number,
            note: body.note,
            releasedSourceCount: released.length,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/bill',
      schema: {
        params: IdParamsSchema,
        response: { 201: BillSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const bill = await tenant(async (tx) => {
        // Preparing a bill is a financial act: issue authority
        // required (Milestone 5 gate, unchanged).
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            mb_number: string | null;
            total_amount: string | null;
          }[]
        >`
            select id, work_id, status, mb_number, total_amount::text as total_amount
            from measurement_books
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
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Bills are prepared from finalized Measurement Books (current status: ${book.status}).`,
          );
        }
        const [existing] = await tx<{ id: string; bill_number: number }[]>`
            select id, bill_number from bills where mb_id = ${id}
          `;
        if (existing) {
          throw httpError(
            409,
            'MB_ALREADY_BILLED',
            `Bill #${String(existing.bill_number)} was already prepared from this Measurement Book.`,
          );
        }

        // The counter row lock serialises concurrent bill preparation
        // for the Work (0006 mechanics, unchanged).
        const [counter] = await tx<{ next_value: number }[]>`
            insert into bill_counters (organisation_id, work_id)
            values (${organisationId}, ${book.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = bill_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('bill counter upsert returned no row');

        const lines = await readStoredLines(tx, id);
        const [row] = await tx<
          {
            id: string;
            work_id: string;
            bill_number: number;
            status: Bill['status'];
            lines_snapshot: unknown;
            total_amount: string;
            mb_id: string | null;
            created_at: Date;
            submitted_at: Date | null;
            paid_at: Date | null;
          }[]
        >`
            insert into bills (
              organisation_id, work_id, bill_number, lines_snapshot,
              total_amount, prepared_by_user_id, mb_id
            )
            values (
              ${organisationId}, ${book.work_id}, ${counter.next_value},
              ${tx.json(lines as never)}, ${book.total_amount},
              ${user.id}, ${id}
            )
            returning id, work_id, bill_number, status, lines_snapshot,
                      total_amount::text as total_amount, mb_id, created_at,
                      submitted_at, paid_at
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_ALREADY_BILLED',
              'A bill was already prepared from this Measurement Book.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('bill insert returned no row');
        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id,
              details
            )
            values (
              ${organisationId}, ${user.id}, 'bill.prepared', 'bills', ${row.id},
              ${tx.json({
                billNumber: row.bill_number,
                totalAmount: row.total_amount,
                measurementBookId: id,
                mbNumber: book.mb_number,
                lineCount: lines.length,
              })}
            )
          `;
        return {
          id: row.id,
          workId: row.work_id,
          billNumber: row.bill_number,
          status: row.status,
          totalAmount: row.total_amount,
          linesSnapshot: parseJsonbColumn(row.lines_snapshot),
          createdAt: row.created_at.toISOString(),
          submittedAt: row.submitted_at?.toISOString() ?? null,
          paidAt: row.paid_at?.toISOString() ?? null,
          mbId: row.mb_id,
        } satisfies Bill;
      });
      return reply.status(201).send(bill);
    },
  );

  // The MB document (phase 3; spec §5.9 "MB document (PDF)"). A
  // FINALIZED MB renders from its IMMUTABLE stored lines to a
  // persisted, content-addressed PDF: object key + SHA-256 +
  // template_version recorded on the row, audit trail appended. The
  // snapshot read and the PDF write live in separate transactions so
  // the slow external call holds no database locks; the final write
  // re-checks the status so a race against cancel discards the orphan
  // render instead of stamping it (the challan render discipline).
}
