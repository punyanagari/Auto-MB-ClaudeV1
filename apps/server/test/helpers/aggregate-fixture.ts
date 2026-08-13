import { randomUUID } from 'node:crypto';
import type { Sql } from '@auto-mb/db';

/**
 * A Work with enough evidence for the aggregate queries to have real
 * work to do: N schedule items, C issued delivery challans each carrying
 * every item, one recorded installation and one PAC certificate per
 * item, a finalized prior Measurement Book with a line per item, and a
 * draft Measurement Book claiming every source.
 *
 * Seeded as raw admin SQL rather than through the API — the same posture
 * the other integration fixtures take — because the subject under test
 * is the SHAPE of the read queries, and a few thousand rows through
 * ~ten thousand HTTP requests would make these suites unusable. Every
 * money and quantity value is a decimal string, cast by PostgreSQL to
 * the column's own numeric type.
 */
export interface AggregateFixture {
  readonly organisationId: string;
  readonly userId: string;
  readonly workId: string;
  /** The draft Measurement Book that claims every source. */
  readonly bookId: string;
  /** The finalized Measurement Book whose lines are the prior memory. */
  readonly priorBookId: string;
  readonly itemIds: readonly string[];
  readonly itemCount: number;
  readonly challanCount: number;
  /** Works in the organisation, including the measured one. */
  readonly workCount: number;
}

export interface AggregateFixtureOptions {
  readonly items: number;
  readonly challans: number;
  /** Additional Works in the same organisation, each with one issued
   * challan — the dashboard's per-Work shape only shows up with more
   * than one Work. */
  readonly siblingWorks: number;
  /** Distinguishes concurrently seeded organisations. */
  readonly label: string;
}

export async function seedAggregateFixture(
  admin: Sql,
  options: AggregateFixtureOptions,
): Promise<AggregateFixture> {
  // Work and document codes answer to `^[A-Z0-9][A-Z0-9_/-]*$`.
  const code = options.label.toUpperCase();
  const organisationId = randomUUID();
  const userId = `fixture-user-${randomUUID()}`;
  const workId = randomUUID();
  const scheduleId = randomUUID();
  const locationId = randomUUID();
  const contactId = randomUUID();
  const bookId = randomUUID();
  const priorBookId = randomUUID();
  const itemIds = Array.from({ length: options.items }, () => randomUUID());
  const challanIds = Array.from({ length: options.challans }, () => randomUUID());

  await admin`
    insert into organisations (id, name, slug)
    values (${organisationId}, ${`Aggregate ${options.label}`}, ${`agg-${options.label}`})
  `;
  await admin`
    insert into organisation_memberships (
      id, organisation_id, user_id, role, work_scope,
      can_issue_documents, can_cancel_documents, can_approve_amendments, status
    )
    values (
      ${randomUUID()}, ${organisationId}, ${userId}, 'owner', 'all',
      true, true, true, 'active'
    )
  `;
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      pbg_required_amount, pbg_submission_days, pbg_requirement_source
    )
    values (
      ${workId}, ${organisationId}, ${`AGG-${code}`},
      ${`L-AGG-${code}`}, '2026-01-05',
      ${`Aggregate budget work ${options.label}`},
      '10000000.00', '9000000.00', 'per_schedule', ${userId},
      '450000.00', 30, '{"provenance": "fixture"}'::jsonb
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_instruments (
      id, organisation_id, work_id, kind, reference, issued_on, expires_on,
      amount, status, created_by_user_id
    )
    values (
      ${randomUUID()}, ${organisationId}, ${workId}, 'pbg',
      ${`PBG-${code}`}, '2026-01-20', '2027-01-20', '400000.00',
      'active', ${userId}
    )
  `;
  await admin`
    insert into location_masters (id, organisation_id, name, kind, created_by_user_id)
    values (${locationId}, ${organisationId}, 'Site A', 'station', ${userId})
  `;
  await admin`
    insert into contacts (
      id, organisation_id, designation, is_consignee, created_by_user_id
    )
    values (${contactId}, ${organisationId}, 'SSE/Signal', true, ${userId})
  `;

  const itemNumber = (index: number): string =>
    `A-${String(index + 1).padStart(4, '0')}`;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    select item.id, ${organisationId}, ${workId}, ${scheduleId}, item.number,
           'Aggregate fixture item ' || item.number, 'nos', '1000.000',
           '250.500000', 'SUPPLY_AND_INSTALLATION'
    from unnest(
      ${itemIds}::uuid[],
      ${itemIds.map((_, index) => itemNumber(index))}::text[]
    ) as item(id, number)
  `;

  // One challan at a time: seeded as a draft, filled, then issued. The
  // one-draft-per-Work index and the line-mutability guard both hold
  // here exactly as they do for the API, so the fixture cannot drift
  // into a state the product cannot produce.
  for (const [index, challanId] of challanIds.entries()) {
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix, status,
        created_by_user_id
      )
      values (
        ${challanId}, ${organisationId}, ${workId}, '2026-02-10', 'DC',
        'draft', ${userId}
      )
    `;
    await admin`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      select ${organisationId}, ${challanId}, ${workId}, item.id,
             'Aggregate fixture item', 'nos', '3.000', '250.500000',
             (3.000 * 250.500000)::numeric(18,2), item.position
      from unnest(
        ${itemIds}::uuid[],
        ${itemIds.map((_, position) => position + 1)}::int[]
      ) as item(id, position)
    `;
    await admin`
      update delivery_challans
      set status = 'issued',
          challan_number = ${`AGG-${code}-DC-${String(index + 1)}`},
          sequence_number = ${index + 1},
          issued_at = now(),
          issued_by_user_id = ${userId},
          issued_snapshot = '{}'::jsonb
      where id = ${challanId}
    `;
  }

  await admin`
    insert into installations (
      organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, status, recorded_by_user_id
    )
    select ${organisationId}, ${workId}, item.id, '2.000', '2026-02-20',
           ${locationId}, 'Site A', 'recorded', ${userId}
    from unnest(${itemIds}::uuid[]) as item(id)
  `;

  const pacId = randomUUID();
  await admin`
    insert into pac_certificates (
      id, organisation_id, work_id, reference, issue_date, consignee_master_id,
      consignee_designation, status, recorded_by_user_id
    )
    values (
      ${pacId}, ${organisationId}, ${workId}, ${`PAC-${code}`},
      '2026-02-25', ${contactId}, 'SSE/Signal', 'recorded', ${userId}
    )
  `;
  await admin`
    insert into pac_certificate_items (
      organisation_id, pac_certificate_id, work_id, work_item_id,
      certified_quantity
    )
    select ${organisationId}, ${pacId}, ${workId}, item.id, '1.000'
    from unnest(${itemIds}::uuid[]) as item(id)
  `;

  // The prior memory: a finalized Measurement Book with one line per
  // item, so the `prior` aggregate has rows to sum.
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (
      ${priorBookId}, ${organisationId}, ${workId}, 'draft', '2026-02-01',
      ${userId}, 'on_account'
    )
  `;
  await admin`
    insert into measurement_book_lines (
      organisation_id, measurement_book_id, work_id, work_item_id, item_number,
      description, unit_code, payment_category, resolved_category,
      pct_supply, pct_installation, pct_pac, pct_final_bill, effective_rate,
      delta_supplied, delta_installed, delta_pac, delta_final_bill,
      prior_supplied, prior_installed, prior_pac, prior_final_bill,
      amount_supply, amount_installation, amount_pac, amount_final_bill,
      line_total, remark
    )
    select ${organisationId}, ${priorBookId}, ${workId}, item.id, item.number,
           'Aggregate fixture item', 'nos', 'SUPPLY_AND_INSTALLATION',
           'SUPPLY_AND_INSTALLATION', '80.00', '10.00', '0.00', '10.00',
           '250.500000', '1.000', '0.500', '0.250', '0.000',
           '0.000', '0.000', '0.000', '0.000',
           '200.40', '12.53', '0.00', '0.00', '212.93', 'prior memory'
    from unnest(
      ${itemIds}::uuid[],
      ${itemIds.map((_, index) => itemNumber(index))}::text[]
    ) as item(id, number)
  `;

  await admin`
    update measurement_books
    set status = 'finalized', mb_number = ${`AGG-${code}-MB-01`},
        sequence_number = 1, total_amount = '125250.00',
        remark_template_version = 'mb-remark-v1', finalized_at = now(),
        finalized_by_user_id = ${userId}
    where id = ${priorBookId}
  `;

  // The draft under measurement, claiming every source.
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (
      ${bookId}, ${organisationId}, ${workId}, 'draft', '2026-03-01',
      ${userId}, 'on_account'
    )
  `;
  await admin`
    insert into mb_sources (
      organisation_id, measurement_book_id, work_id, source_type, source_id
    )
    select ${organisationId}, ${bookId}, ${workId}, claim.source_type,
           claim.source_id
    from unnest(
      ${[...challanIds.map(() => 'delivery_challan'), 'pac_certificate']}::text[],
      ${[...challanIds, pacId]}::uuid[]
    ) as claim(source_type, source_id)
  `;
  const installationIds = await admin<{ id: string }[]>`
    select id from installations where work_id = ${workId} order by id
  `;
  await admin`
    insert into mb_sources (
      organisation_id, measurement_book_id, work_id, source_type, source_id
    )
    select ${organisationId}, ${bookId}, ${workId}, 'installation', claim.id
    from unnest(${installationIds.map((row) => row.id)}::uuid[]) as claim(id)
  `;

  await admin`
    insert into bills (
      organisation_id, work_id, bill_number, lines_snapshot, total_amount,
      prepared_by_user_id, mb_id
    )
    values (
      ${organisationId}, ${workId}, 1, '[]'::jsonb, '125250.00', ${userId},
      ${priorBookId}
    )
  `;

  // Sibling Works, each with its own issued challan. The dashboard's
  // retired shape hung a lateral off EVERY Work, so more than one Work
  // is what makes the per-Work re-execution visible in the plan.
  for (let sibling = 1; sibling <= options.siblingWorks; sibling += 1) {
    const siblingWorkId = randomUUID();
    const siblingScheduleId = randomUUID();
    const siblingItemId = randomUUID();
    const siblingChallanId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${siblingWorkId}, ${organisationId}, ${`AGG-${code}-S${String(sibling)}`},
        ${`L-AGG-${code}-S${String(sibling)}`}, '2026-01-06',
        ${`Aggregate sibling work ${String(sibling)}`},
        '500000.00', '450000.00', 'per_schedule', ${userId}
      )
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (
        ${siblingScheduleId}, ${organisationId}, ${siblingWorkId}, 'A',
        'Schedule A', 1
      )
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${siblingItemId}, ${organisationId}, ${siblingWorkId},
        ${siblingScheduleId}, 'A-0001', 'Sibling fixture item', 'nos',
        '100.000', '250.500000'
      )
    `;
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix, status,
        created_by_user_id
      )
      values (
        ${siblingChallanId}, ${organisationId}, ${siblingWorkId}, '2026-02-11',
        'DC', 'draft', ${userId}
      )
    `;
    await admin`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${organisationId}, ${siblingChallanId}, ${siblingWorkId},
        ${siblingItemId}, 'Sibling fixture item', 'nos', '5.000', '250.500000',
        (5.000 * 250.500000)::numeric(18,2), 1
      )
    `;
    await admin`
      update delivery_challans
      set status = 'issued',
          challan_number = ${`AGG-${code}-S${String(sibling)}-DC-1`},
          sequence_number = 1, issued_at = now(), issued_by_user_id = ${userId},
          issued_snapshot = '{}'::jsonb
      where id = ${siblingChallanId}
    `;
  }

  return {
    organisationId,
    userId,
    workId,
    bookId,
    priorBookId,
    itemIds,
    itemCount: options.items,
    challanCount: options.challans,
    workCount: options.siblingWorks + 1,
  };
}
