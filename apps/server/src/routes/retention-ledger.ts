import {
  AssessLdRequestSchema,
  DecideLdAssessmentRequestSchema,
  LdAssessmentSchema,
  RecordRetentionReleaseRequestSchema,
  RetentionReleaseSchema,
  SaveWorkRetentionTermsRequestSchema,
  VoidRetentionReleaseRequestSchema,
  WorkRetentionResponseSchema,
  WorkRetentionTermsSchema,
  type ErrorCode,
  type LdAssessment,
  type LdAssessmentStatus,
  type RetentionRelease,
  type RetentionReleaseBasis,
  type WorkRetentionPosition,
  type WorkRetentionResponse,
  type WorkRetentionTerms,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Retention money, and liquidated damages.
 *
 * The two things a railway keeps out of a bill for reasons that are not
 * tax, and they behave in opposite directions. Retention is WITHHELD and
 * comes back — at the Provisional Acceptance Certificate, at the end of
 * the defect-liability period, or all at once against a bank guarantee.
 * Liquidated damages are KEPT and do not come back, and are the one
 * deduction an agency argues about, which means the arithmetic behind
 * them has to be written down before the argument.
 *
 * WHAT THIS MODULE DOES NOT OWN. It does not record deductions. Migration
 * 0067's `bill_payment_deductions` already does, under the
 * `SECURITY_DEPOSIT` and `LIQUIDATED_DAMAGES` heads, and
 * `routes/bill-payments.ts` is where an operator enters a payment advice.
 * That stays exactly where it is: this module reads those rows to work
 * out what is HELD, and adds only what a deduction register cannot say —
 * what came back, and whether the damages were the right number.
 *
 * MONEY IS ENFORCED TWICE (0067 § ENFORCED TWICE, and the improvement
 * programme's recurring finding 2). Every rule below is also a trigger in
 * migration 0098, and the split is the same one `docs/PRODUCT.md` §5.5
 * states for the railway bill: the database owns the arithmetic and the
 * structure, this module owns authority, work scope, the audit entry, and
 * saying it in a sentence rather than a SQLSTATE.
 *
 * NOTHING HERE COMPUTES LIQUIDATED DAMAGES. The rate, the delay, the
 * period count and the cap are GENERATED COLUMNS on `ld_assessments`, so
 * the whole computation happens once, in PostgreSQL numeric, and this
 * module cannot disagree with it about a rounding or a boundary because
 * it never performs it. What this module does is choose the SNAPSHOT the
 * computation runs on and refuse a window that is not a window.
 */

/**
 * The refusals an operator can meet from either layer, written once
 * because they ARE one refusal each: the route catches the common case
 * under the Work's row lock and the trigger catches the concurrent one.
 * An operator meeting two different sentences for one situation would
 * reasonably conclude they were two different problems.
 */
const RELEASE_EXCEEDS_HELD =
  'This release is larger than the retention still held on this Work. Re-read the position: another release may have been recorded first, or a receipt that withheld retention may have been withdrawn.';
const RELEASE_IMMUTABLE =
  'A recorded release cannot be edited. Withdraw it with a reason and record the corrected one.';

interface TermsRow {
  readonly retention_percent: string | null;
  readonly retention_limit_percent: string | null;
  readonly defect_liability_months: number | null;
  readonly ld_rate_percent: string | null;
  readonly ld_period_days: number | null;
  readonly ld_cap_percent: string | null;
  readonly source_clause: string | null;
  readonly notes: string | null;
  readonly updated_at: Date;
}

function toTerms(row: TermsRow): WorkRetentionTerms {
  return {
    retentionPercent: row.retention_percent,
    retentionLimitPercent: row.retention_limit_percent,
    defectLiabilityMonths: row.defect_liability_months,
    ldRatePercent: row.ld_rate_percent,
    ldPeriodDays: row.ld_period_days,
    ldCapPercent: row.ld_cap_percent,
    sourceClause: row.source_clause,
    notes: row.notes,
    updatedAt: row.updated_at.toISOString(),
  };
}

const TERMS_COLUMNS = `retention_percent::text as retention_percent,
       retention_limit_percent::text as retention_limit_percent,
       defect_liability_months,
       ld_rate_percent::text as ld_rate_percent, ld_period_days,
       ld_cap_percent::text as ld_cap_percent, source_clause, notes,
       updated_at`;

interface ReleaseRow {
  readonly id: string;
  readonly work_id: string;
  readonly released_on: string;
  readonly amount: string;
  readonly basis: RetentionReleaseBasis;
  readonly work_instrument_id: string | null;
  readonly work_instrument_reference: string | null;
  readonly reference: string | null;
  readonly description: string | null;
  readonly remarks: string | null;
  readonly voided_at: Date | null;
  readonly void_reason: string | null;
  readonly created_at: Date;
}

function toRelease(row: ReleaseRow): RetentionRelease {
  return {
    id: row.id,
    workId: row.work_id,
    releasedOn: row.released_on,
    amount: row.amount,
    basis: row.basis,
    workInstrumentId: row.work_instrument_id,
    workInstrumentReference: row.work_instrument_reference,
    reference: row.reference,
    description: row.description,
    remarks: row.remarks,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

interface AssessmentRow {
  readonly id: string;
  readonly work_id: string;
  readonly assessed_on: string;
  readonly status: LdAssessmentStatus;
  readonly basis_amount: string;
  readonly basis_label: string;
  readonly scheduled_completion_date: string;
  readonly assessed_to_date: string;
  readonly ld_rate_percent: string;
  readonly ld_period_days: number;
  readonly ld_cap_percent: string;
  readonly delay_days: number;
  readonly chargeable_periods: number;
  readonly uncapped_amount: string;
  readonly cap_amount: string;
  readonly assessed_amount: string;
  readonly levied_amount: string | null;
  readonly levy_reference: string | null;
  readonly outcome_reason: string | null;
  readonly notes: string | null;
  readonly decided_at: Date | null;
  readonly created_at: Date;
}

function toAssessment(row: AssessmentRow): LdAssessment {
  return {
    id: row.id,
    workId: row.work_id,
    assessedOn: row.assessed_on,
    status: row.status,
    basisAmount: row.basis_amount,
    basisLabel: row.basis_label,
    scheduledCompletionDate: row.scheduled_completion_date,
    assessedToDate: row.assessed_to_date,
    ldRatePercent: row.ld_rate_percent,
    ldPeriodDays: row.ld_period_days,
    ldCapPercent: row.ld_cap_percent,
    delayDays: row.delay_days,
    chargeablePeriods: row.chargeable_periods,
    uncappedAmount: row.uncapped_amount,
    capAmount: row.cap_amount,
    assessedAmount: row.assessed_amount,
    leviedAmount: row.levied_amount,
    levyReference: row.levy_reference,
    outcomeReason: row.outcome_reason,
    notes: row.notes,
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const ASSESSMENT_COLUMNS = `id, work_id, assessed_on::text as assessed_on, status,
       basis_amount::text as basis_amount, basis_label,
       scheduled_completion_date::text as scheduled_completion_date,
       assessed_to_date::text as assessed_to_date,
       ld_rate_percent::text as ld_rate_percent, ld_period_days,
       ld_cap_percent::text as ld_cap_percent,
       delay_days, chargeable_periods,
       uncapped_amount::text as uncapped_amount,
       cap_amount::text as cap_amount,
       assessed_amount::text as assessed_amount,
       levied_amount::text as levied_amount, levy_reference,
       outcome_reason, notes, decided_at, created_at`;

interface PositionRow {
  readonly work_id: string;
  readonly contract_value: string;
  readonly retention_ceiling_amount: string | null;
  readonly retention_held_total: string;
  readonly retention_released_total: string;
  readonly retention_balance: string;
  readonly ld_levied_total: string;
  readonly ld_deducted_total: string;
  readonly ld_open_assessments: number;
}

function toPosition(row: PositionRow): WorkRetentionPosition {
  return {
    workId: row.work_id,
    contractValue: row.contract_value,
    retentionCeilingAmount: row.retention_ceiling_amount,
    retentionHeldTotal: row.retention_held_total,
    retentionReleasedTotal: row.retention_released_total,
    retentionBalance: row.retention_balance,
    ldLeviedTotal: row.ld_levied_total,
    ldDeductedTotal: row.ld_deducted_total,
    ldOpenAssessments: row.ld_open_assessments,
  };
}

/**
 * A free-text field as the column wants it: trimmed, or null when it was
 * omitted.
 *
 * Every text column in migration 0098 carries `btrim(x) = x`, and the
 * shared `nonBlankString` schema deliberately ADMITS surrounding spaces —
 * it asks that enough characters survive trimming, not that none were
 * typed. So a value that passes validation can still fail the CHECK as a
 * bare 23514, and the trim is what closes that gap. `bill-payments.ts`
 * does the same thing for the same reason.
 */
function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The database's refusals, restated as this module's own.
 *
 * Matched on SQLSTATE, never on the text of the RAISE. Migration 0098
 * gives each rule its own code in the 23P block for this one reason: a
 * reworded message must not be able to silently turn a 409 back into a
 * 500, and a substring match is a coupling nothing checks.
 * `constraint_name` rides along so a log line names the rule without
 * anybody decoding the number.
 *
 * 23P07 is deliberately absent from this map. It means the row named a
 * Work the transaction cannot read, which for a caller is a 404 and not a
 * 409 — and it is unreachable through these routes, because
 * `assertWorkAccess` has already refused with the register's own
 * indistinguishable 404. It is mapped explicitly below rather than left
 * to fall through to a 500.
 */
const DATABASE_REFUSALS: Readonly<Record<string, readonly [ErrorCode, string]>> = {
  '23P01': ['RETENTION_RELEASE_EXCEEDS_HELD', RELEASE_EXCEEDS_HELD],
  '23P02': ['RETENTION_RELEASE_ALREADY_WITHDRAWN', RELEASE_IMMUTABLE],
  '23P03': [
    'RETENTION_RELEASE_DATE_FUTURE',
    'A release cannot be dated in the future; check the year on the release letter.',
  ],
  '23P04': [
    'LD_TERMS_MISSING',
    'Record the contract’s liquidated-damages terms on this Work first — a rate, a period and a cap.',
  ],
  '23P05': [
    'LD_ASSESSMENT_STATUS_CONFLICT',
    'Reload the assessment; it was decided while this form was open.',
  ],
  '23P06': [
    'LD_LEVY_EXCEEDS_ASSESSMENT',
    'The levy cannot exceed the assessment. If the railway took more, assess again on the basis it used.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  if (code === '23P07') {
    // The Work vanished from under the transaction. A 404 with the
    // register's own wording, so a guessed id and a withdrawn Work are
    // indistinguishable — the same posture `assertWorkAccess` takes.
    throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  }
  if (code === '23505') {
    // The one-live-release-per-reference index and the one-draft-per-Work
    // index (0098). Both are checked first by the route under the Work's
    // lock, so this is the concurrent-insert arm of the same two rules.
    // They are told apart by the index name because the remedies are
    // different: one is a duplicate advice, the other is a second draft.
    const constraint =
      error !== null && typeof error === 'object' && 'constraint_name' in error
        ? String(error.constraint_name)
        : '';
    if (constraint === 'ld_assessments_one_draft_per_work') {
      throw httpError(
        409,
        'LD_DRAFT_EXISTS',
        'This Work already has a draft assessment. Levy, waive or cancel it before making another.',
      );
    }
    throw httpError(
      409,
      'RETENTION_RELEASE_DUPLICATE_REFERENCE',
      'A live release quoting this reference is already recorded against this Work.',
    );
  }
  throw error;
}

/**
 * The Work, locked, with the two facts an assessment is built from and
 * the organisation's own today.
 *
 * `for update of w` locks the Work alone; the joined organisations row is
 * read, not locked — the same shape every sibling child-creating route
 * takes (challans.ts, installations.ts, retention.ts § instruments). The
 * lock is what makes the ceiling check below non-racy, and it is taken in
 * the same order the trigger takes it so no lock order is inverted.
 */
async function lockWork(
  tx: TransactionSql,
  workId: string,
): Promise<{
  readonly contract_value: string;
  readonly current_completion_date: string | null;
  readonly today: string;
}> {
  const [work] = await tx<
    {
      contract_value: string;
      current_completion_date: string | null;
      today: string;
    }[]
  >`
    select w.contract_value::text as contract_value,
           w.current_completion_date::text as current_completion_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId} and w.deleted_at is null
    for update of w
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return work;
}

async function readPosition(
  tx: TransactionSql,
  workId: string,
): Promise<WorkRetentionPosition> {
  const [row] = await tx<PositionRow[]>`
    select work_id, contract_value::text as contract_value,
           retention_ceiling_amount::text as retention_ceiling_amount,
           retention_held_total::text as retention_held_total,
           retention_released_total::text as retention_released_total,
           retention_balance::text as retention_balance,
           ld_levied_total::text as ld_levied_total,
           ld_deducted_total::text as ld_deducted_total,
           ld_open_assessments
    from work_retention_positions
    where work_id = ${workId}
  `;
  // The view is over live Works only, so a missing row means the Work was
  // withdrawn between the access check and this read. Reported as the
  // register's own 404 rather than as an empty position, which would be
  // the empty-register lie about a Work that no longer exists.
  if (!row) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return toPosition(row);
}

async function readReleases(
  tx: TransactionSql,
  workId: string,
): Promise<RetentionRelease[]> {
  const rows = await tx<ReleaseRow[]>`
    select r.id, r.work_id, r.released_on::text as released_on,
           r.amount::text as amount, r.basis, r.work_instrument_id,
           i.reference as work_instrument_reference,
           r.reference, r.description, r.remarks, r.voided_at, r.void_reason,
           r.created_at
    from retention_releases r
    left join work_instruments i on i.id = r.work_instrument_id
    where r.work_id = ${workId}
    order by r.released_on desc, r.id desc
  `;
  return rows.map(toRelease);
}

async function readAssessments(
  tx: TransactionSql,
  workId: string,
): Promise<LdAssessment[]> {
  const rows = await tx<AssessmentRow[]>`
    select ${tx.unsafe(ASSESSMENT_COLUMNS)}
    from ld_assessments
    where work_id = ${workId}
    order by assessed_on desc, id desc
  `;
  return rows.map(toAssessment);
}

async function readTerms(
  tx: TransactionSql,
  workId: string,
): Promise<WorkRetentionTerms | null> {
  const [row] = await tx<TermsRow[]>`
    select ${tx.unsafe(TERMS_COLUMNS)}
    from work_retention_terms where work_id = ${workId}
  `;
  return row === undefined ? null : toTerms(row);
}

async function readWorkRetention(
  tx: TransactionSql,
  workId: string,
): Promise<WorkRetentionResponse> {
  const [work] = await tx<{ current_completion_date: string | null }[]>`
    select current_completion_date::text as current_completion_date
    from works where id = ${workId} and deleted_at is null
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  const instruments = await tx<
    { id: string; kind: string; reference: string; amount: string | null }[]
  >`
    select id, kind, reference, amount::text as amount
    from work_instruments
    where work_id = ${workId} and status = 'active'
    order by kind, issued_on, reference
  `;
  return {
    position: await readPosition(tx, workId),
    terms: await readTerms(tx, workId),
    releases: await readReleases(tx, workId),
    assessments: await readAssessments(tx, workId),
    currentCompletionDate: work.current_completion_date,
    instruments: instruments.map((row) => ({
      id: row.id,
      kind: row.kind,
      reference: row.reference,
      amount: row.amount,
    })),
  };
}

export function registerRetentionLedgerRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // --- The whole position, in one read ------------------------------------
  //
  // Deliberately one endpoint rather than four. A Work's retention story
  // is a position, a handful of releases and a handful of assessments —
  // it is read whole, on one screen, and four round-trips would buy
  // nothing but four chances for the screen to render a balance that
  // disagrees with the rows beneath it.
  //
  // REPEATABLE READ, for exactly that reason: the position is computed
  // from `bill_payment_deductions` and the releases are read from another
  // table, and a payment advice recorded between the two statements would
  // produce a page whose tiles and whose table describe different
  // moments.
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/retention',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkRetentionResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenantSnapshot }) => {
      const { id: workId } = request.params;
      return tenantSnapshot(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return readWorkRetention(tx, workId);
      });
    },
  );

  // --- The contract's terms -----------------------------------------------
  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/retention-terms',
      schema: {
        params: IdParamsSchema,
        body: SaveWorkRetentionTermsRequestSchema,
        response: { 200: WorkRetentionTermsSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'retention',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await lockWork(tx, workId);

        // The LD triple is all-or-nothing. The database says the same
        // thing with `work_retention_terms_ld_triple_coherent`; refusing
        // it here is what turns a 23514 an operator reads as a bare 500
        // into a sentence naming the two fields they still have to fill.
        const ldFields = [body.ldRatePercent, body.ldPeriodDays, body.ldCapPercent];
        const ldGiven = ldFields.filter((value) => value !== undefined).length;
        if (ldGiven !== 0 && ldGiven !== 3) {
          throw httpError(
            400,
            'RETENTION_TERMS_LD_INCOMPLETE',
            'Liquidated damages need a rate, a chargeable period and a cap together; an assessment cannot be computed from two of the three.',
          );
        }
        const anyTerm =
          body.retentionPercent !== undefined ||
          body.retentionLimitPercent !== undefined ||
          body.defectLiabilityMonths !== undefined ||
          ldGiven === 3;
        if (!anyTerm) {
          throw httpError(
            400,
            'RETENTION_TERMS_EMPTY',
            'Record at least one term — a retention rate, a retention ceiling, a defect-liability period, or the liquidated-damages triple.',
          );
        }

        const before = await readTerms(tx, workId);
        // A whole-record upsert. The request IS the record, so a field
        // the caller omitted is a field the contract does not state —
        // `coalesce`-style merging would make it impossible to clear a
        // term that was recorded in error.
        const [row] = await tx<(TermsRow & { id: string })[]>`
          insert into work_retention_terms (
            organisation_id, work_id, retention_percent, retention_limit_percent,
            defect_liability_months, ld_rate_percent, ld_period_days,
            ld_cap_percent, source_clause, notes, recorded_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${body.retentionPercent ?? null},
            ${body.retentionLimitPercent ?? null},
            ${body.defectLiabilityMonths ?? null}, ${body.ldRatePercent ?? null},
            ${body.ldPeriodDays ?? null}, ${body.ldCapPercent ?? null},
            ${trimmedOrNull(body.sourceClause)}, ${trimmedOrNull(body.notes)}, ${user.id}
          )
          on conflict (organisation_id, work_id) do update set
            retention_percent = excluded.retention_percent,
            retention_limit_percent = excluded.retention_limit_percent,
            defect_liability_months = excluded.defect_liability_months,
            ld_rate_percent = excluded.ld_rate_percent,
            ld_period_days = excluded.ld_period_days,
            ld_cap_percent = excluded.ld_cap_percent,
            source_clause = excluded.source_clause,
            notes = excluded.notes
          returning id, ${tx.unsafe(TERMS_COLUMNS)}
        `;
        if (!row) throw new Error('retention terms upsert returned no row');
        const terms = toTerms(row);
        // The audit entity id is the TERMS ROW's own id, not the Work's.
        // The Work timeline joins `entity_id` against each register's
        // primary key (`routes/timeline.ts`), so an event stamped with
        // the Work id would be written, counted by the census, and never
        // appear on the trail it was written for.
        await audit(
          tx,
          organisationId,
          user.id,
          'retention.terms.saved',
          'work_retention_terms',
          row.id,
          { workId, before, after: terms },
        );
        return terms;
      });
    },
  );

  // --- Recording a release -------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/retention-releases',
      schema: {
        params: IdParamsSchema,
        body: RecordRetentionReleaseRequestSchema,
        response: { 201: RetentionReleaseSchema, ...errorResponses },
      },
      authority: 'retention',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const release = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);

        if (body.basis === 'bank_guarantee_substitution') {
          if (body.workInstrumentId === undefined) {
            throw httpError(
              400,
              'RETENTION_INSTRUMENT_REQUIRED',
              'A release against a bank guarantee has to name the guarantee; record it on the Work’s instruments first if it is not there.',
            );
          }
          // The composite foreign key already refuses another
          // organisation's instrument. This refuses one belonging to
          // another WORK, which the key cannot see — a guarantee lodged
          // against one contract does not secure a different one.
          const [instrument] = await tx<{ id: string }[]>`
            select id from work_instruments
            where id = ${body.workInstrumentId} and work_id = ${workId}
          `;
          if (!instrument) {
            throw httpError(
              404,
              'INSTRUMENT_NOT_FOUND',
              'That guarantee does not belong to this Work.',
            );
          }
        }
        if (body.basis === 'other' && body.description === undefined) {
          throw httpError(
            400,
            'RETENTION_RELEASE_UNDESCRIBED',
            'A release recorded under "other" has to say what it is; an unnamed release cannot be reconciled later.',
          );
        }

        // The same window every other dated operational record obeys, in
        // the ORGANISATION'S timezone. The trigger holds the same rule;
        // this is what makes it a sentence naming today.
        if (body.releasedOn > work.today) {
          throw httpError(
            400,
            'RETENTION_RELEASE_DATE_FUTURE',
            `A release cannot be dated in the future (today is ${work.today}).`,
          );
        }

        // The ceiling, checked under the Work's lock so it cannot race.
        // The trigger checks it again for the writer that arrives another
        // way; both read the same two functions, so they cannot disagree.
        const [ledger] = await tx<{ held: string; released: string }[]>`
          select app_private.work_retention_held(${workId})::text as held,
                 app_private.work_retention_released(${workId})::text as released
        `;
        if (!ledger) throw new Error('retention ledger read returned no row');
        // Compared in SQL, not here: three decimal strings through
        // `Number()` is the float arithmetic engineering rule 5 forbids,
        // on the figure that decides whether money may be released.
        const [fits] = await tx<{ exceeds: boolean; balance: string }[]>`
          select (${ledger.released}::numeric + ${body.amount}::numeric)
                   > ${ledger.held}::numeric as exceeds,
                 (${ledger.held}::numeric - ${ledger.released}::numeric)::text
                   as balance
        `;
        if (fits?.exceeds === true) {
          throw httpError(
            409,
            'RETENTION_RELEASE_EXCEEDS_HELD',
            `Only ${fits.balance} of retention is still held on this Work; a release of ${body.amount} would take the ledger negative.`,
          );
        }

        const [row] = await tx<ReleaseRow[]>`
          insert into retention_releases (
            organisation_id, work_id, released_on, amount, basis,
            work_instrument_id, reference, description, remarks,
            recorded_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${body.releasedOn}, ${body.amount},
            ${body.basis}, ${body.workInstrumentId ?? null},
            ${trimmedOrNull(body.reference)},
            ${trimmedOrNull(body.description)},
            ${trimmedOrNull(body.remarks)}, ${user.id}
          )
          returning id, work_id, released_on::text as released_on,
                    amount::text as amount, basis, work_instrument_id,
                    null::text as work_instrument_reference,
                    reference, description, remarks, voided_at, void_reason,
                    created_at
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('retention release insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'retention.released',
          'retention_releases',
          row.id,
          {
            workId,
            amount: body.amount,
            basis: body.basis,
            releasedOn: body.releasedOn,
          },
        );
        // The instrument reference is re-read rather than returned by the
        // insert, because `returning` cannot join. One statement, only
        // when a guarantee was actually named.
        if (row.work_instrument_id === null) return toRelease(row);
        const [instrument] = await tx<{ reference: string }[]>`
          select reference from work_instruments where id = ${row.work_instrument_id}
        `;
        return toRelease({
          ...row,
          work_instrument_reference: instrument?.reference ?? null,
        });
      });
      return reply.status(201).send(release);
    },
  );

  // --- Withdrawing one -----------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/retention-releases/:id/void',
      schema: {
        params: IdParamsSchema,
        body: VoidRetentionReleaseRequestSchema,
        response: { 200: RetentionReleaseSchema, ...errorResponses },
      },
      authority: 'retention',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [existing] = await tx<
          { work_id: string; voided_at: Date | null; amount: string }[]
        >`
          select work_id, voided_at, amount::text as amount
          from retention_releases where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(
            404,
            'RETENTION_RELEASE_NOT_FOUND',
            'No such retention release.',
          );
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        if (existing.voided_at !== null) {
          throw httpError(
            409,
            'RETENTION_RELEASE_ALREADY_WITHDRAWN',
            'This release has already been withdrawn.',
          );
        }
        const [row] = await tx<ReleaseRow[]>`
          update retention_releases
          set voided_at = now(), voided_by_user_id = ${user.id},
              void_reason = ${body.reason.trim()}
          where id = ${id}
          returning id, work_id, released_on::text as released_on,
                    amount::text as amount, basis, work_instrument_id,
                    null::text as work_instrument_reference,
                    reference, description, remarks, voided_at, void_reason,
                    created_at
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('retention release void returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'retention.release.withdrawn',
          'retention_releases',
          id,
          { workId: existing.work_id, amount: existing.amount, reason: body.reason },
        );
        return toRelease(row);
      });
    },
  );

  // --- Assessing liquidated damages ----------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/ld-assessments',
      schema: {
        params: IdParamsSchema,
        body: AssessLdRequestSchema,
        response: { 201: LdAssessmentSchema, ...errorResponses },
      },
      authority: 'retention',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const assessment = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);

        // The delay is measured FROM the contractual completion date as
        // it currently stands, extensions included — an extension is
        // precisely the railway agreeing that those days are not a delay.
        // A Work whose letter stated no completion date cannot be
        // assessed at all, and saying so is better than defaulting to the
        // letter date and levying damages from the day of award.
        if (work.current_completion_date === null) {
          throw httpError(
            409,
            'COMPLETION_NOT_SET',
            'This Work has no contractual completion date, so there is nothing to measure a delay against. Record the completion dates on the Work first.',
          );
        }
        const scheduled = work.current_completion_date;

        const terms = await readTerms(tx, workId);
        if (
          terms === null ||
          terms.ldRatePercent === null ||
          terms.ldPeriodDays === null ||
          terms.ldCapPercent === null
        ) {
          throw httpError(
            409,
            'LD_TERMS_MISSING',
            'Record the contract’s liquidated-damages terms on this Work first — a rate, a chargeable period and a cap.',
          );
        }

        // The window has to run forwards, and the assessment cannot be
        // dated before the period it assesses or after today. All three
        // are also CHECKs or a trigger; refusing here is what names the
        // field. The most common shape of each is a mistyped year, which
        // is why the message quotes the date it is comparing against.
        if (body.assessedToDate < scheduled) {
          throw httpError(
            400,
            'LD_ASSESSMENT_WINDOW_INVALID',
            `The delay is measured to ${body.assessedToDate}, which is before the contractual completion date ${scheduled}. There is no delay to assess — check the year.`,
          );
        }
        if (body.assessedOn < body.assessedToDate) {
          throw httpError(
            400,
            'LD_ASSESSMENT_WINDOW_INVALID',
            `An assessment dated ${body.assessedOn} cannot measure a delay running to ${body.assessedToDate}.`,
          );
        }
        if (body.assessedOn > work.today) {
          throw httpError(
            400,
            'LD_ASSESSMENT_WINDOW_INVALID',
            `The assessment date cannot be in the future (today is ${work.today}).`,
          );
        }

        const [draft] = await tx<{ id: string }[]>`
          select id from ld_assessments
          where work_id = ${workId} and status = 'draft'
        `;
        if (draft) {
          throw httpError(
            409,
            'LD_DRAFT_EXISTS',
            'This Work already has a draft assessment. Levy, waive or cancel it before making another.',
          );
        }

        // The snapshot. The basis defaults to the Work's contract value
        // and is settable because LD is sometimes charged only on the
        // late PORTION of a contract; `basisLabel` is then what says so,
        // and it is what a reader sees years later instead of a bare
        // number. The rate, period and cap are NEVER taken from the
        // request — they come from the recorded terms, so an assessment
        // cannot quietly be computed at a rate the contract never stated.
        const basisAmount = body.basisAmount ?? work.contract_value;
        const basisLabel =
          trimmedOrNull(body.basisLabel) ??
          (body.basisAmount === undefined
            ? 'Contract value'
            : 'Value of the delayed portion');

        const [row] = await tx<AssessmentRow[]>`
          insert into ld_assessments (
            organisation_id, work_id, assessed_on, basis_amount, basis_label,
            scheduled_completion_date, assessed_to_date, ld_rate_percent,
            ld_period_days, ld_cap_percent, notes, assessed_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${body.assessedOn}, ${basisAmount},
            ${basisLabel}, ${scheduled}, ${body.assessedToDate},
            ${terms.ldRatePercent}, ${terms.ldPeriodDays}, ${terms.ldCapPercent},
            ${trimmedOrNull(body.notes)}, ${user.id}
          )
          returning ${tx.unsafe(ASSESSMENT_COLUMNS)}
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('ld assessment insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'ld.assessed',
          'ld_assessments',
          row.id,
          {
            workId,
            delayDays: row.delay_days,
            chargeablePeriods: row.chargeable_periods,
            assessedAmount: row.assessed_amount,
            capped: row.assessed_amount !== row.uncapped_amount,
          },
        );
        return toAssessment(row);
      });
      return reply.status(201).send(assessment);
    },
  );

  // --- Levying, waiving, cancelling ----------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/ld-assessments/:id/decision',
      schema: {
        params: IdParamsSchema,
        body: DecideLdAssessmentRequestSchema,
        response: { 200: LdAssessmentSchema, ...errorResponses },
      },
      authority: 'retention',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [existing] = await tx<
          {
            work_id: string;
            status: LdAssessmentStatus;
            assessed_amount: string;
            levied_amount: string | null;
          }[]
        >`
          select work_id, status, assessed_amount::text as assessed_amount,
                 levied_amount::text as levied_amount
          from ld_assessments where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(
            404,
            'LD_ASSESSMENT_NOT_FOUND',
            'No such liquidated-damages assessment.',
          );
        }
        await assertWorkAccess(tx, user.id, existing.work_id);

        const target: LdAssessmentStatus =
          body.decision === 'levy'
            ? 'levied'
            : body.decision === 'waive'
              ? 'waived'
              : 'cancelled';
        // The route's copy of the state machine in migration 0098's
        // guard. Stated as the allowed set rather than as a list of
        // refusals, so a state added later without a transition is
        // refused rather than silently reachable.
        const allowed =
          (existing.status === 'draft' &&
            (target === 'levied' || target === 'waived' || target === 'cancelled')) ||
          (existing.status === 'levied' &&
            (target === 'waived' || target === 'cancelled'));
        if (!allowed) {
          throw httpError(
            409,
            'LD_ASSESSMENT_STATUS_CONFLICT',
            `A ${existing.status} assessment cannot be ${target}.`,
          );
        }

        if (body.decision === 'levy') {
          // Compared in SQL for the reason the release ceiling is:
          // decimal strings through `Number()` is float arithmetic on the
          // figure that decides how much the railway may keep.
          const [check] = await tx<{ exceeds: boolean }[]>`
            select ${body.leviedAmount}::numeric
                     > ${existing.assessed_amount}::numeric as exceeds
          `;
          if (check?.exceeds === true) {
            throw httpError(
              409,
              'LD_LEVY_EXCEEDS_ASSESSMENT',
              `A levy of ${body.leviedAmount} exceeds the assessment of ${existing.assessed_amount}. If the railway took more, assess again on the basis it used.`,
            );
          }
        }

        const [row] = await tx<AssessmentRow[]>`
          update ld_assessments
          set status = ${target},
              levied_amount = ${
                body.decision === 'levy'
                  ? body.leviedAmount
                  : (existing.levied_amount ?? null)
              },
              levy_reference = case
                when ${body.decision === 'levy'}
                then ${body.decision === 'levy' ? trimmedOrNull(body.levyReference) : null}
                else levy_reference
              end,
              outcome_reason = ${body.decision === 'levy' ? null : body.reason.trim()},
              decided_by_user_id = ${user.id},
              decided_at = now()
          where id = ${id}
          returning ${tx.unsafe(ASSESSMENT_COLUMNS)}
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('ld assessment decision returned no row');
        await audit(tx, organisationId, user.id, `ld.${target}`, 'ld_assessments', id, {
          workId: existing.work_id,
          before: { status: existing.status },
          after: { status: target },
          ...(body.decision === 'levy'
            ? { leviedAmount: body.leviedAmount }
            : { reason: body.reason }),
        });
        return toAssessment(row);
      });
    },
  );
}
