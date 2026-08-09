import { randomUUID } from 'node:crypto';
import { jsonb, type Sql, type TransactionSql } from '@auto-mb/db';
import { CHALLAN_TEMPLATE_VERSION, type ChallanSnapshot } from '../challan-html.js';
import { fingerprintOf } from './canonical.js';
import { quantize } from './decimal.js';
import { resolveCompany, type MappingConfig } from './mapping.js';
import {
  isIsoDate,
  normaliseUnit,
  normaliseWorkCode,
  parseChallanNumber,
  parseSerials,
  timestampFromV1Id,
} from './parse.js';
import type {
  ChallanSeriesReport,
  CompanyTally,
  EntityCounts,
  ImportException,
  OrganisationReport,
  QuantizationClassStats,
  QuantizationDrift,
  RunReport,
  VariationRateDivergence,
} from './report.js';
import type {
  V1Backup,
  V1Challan,
  V1ChallanItem,
  V1ItemVariation,
  V1Work,
  V1WorkItem,
} from './v1-backup.js';

export const IMPORTER_VERSION = 'import-v1/1.0.0';
export const SOURCE_SYSTEM = 'auto-mb-v1';

/** All imported rows are stamped with this systemic actor: identity is
 * never migrated, so no human user id exists to claim them. */
export const IMPORT_ACTOR = 'import:auto-mb-v1';

/** v1 recorded no consignee address; the target snapshot shape requires
 * one, so imported documents carry this explicit sentinel instead of a
 * fabricated address. */
export const ADDRESS_NOT_RECORDED = 'Not recorded in Auto-MB v1';

const ORGANISATION_TIMEZONE_OFFSET = '+05:30'; // Asia/Kolkata, the org default.

export interface ImportOptions {
  readonly backup: V1Backup;
  readonly mapping: MappingConfig;
  readonly mode: 'dry-run' | 'apply';
  readonly inputDigest: string;
  readonly operatorNote?: string | undefined;
}

interface ProvenanceRow {
  entity_type: string;
  source_id: string;
  target_id: string;
  payload_fingerprint: string;
}

type ProvenanceMap = Map<string, { targetId: string; fingerprint: string }>;

const ENTITY_ORDER = [
  'organisation',
  'consignee_master',
  'work',
  'work_schedule',
  'work_item',
  'item_variation',
  'delivery_challan',
  'delivery_challan_item',
  'challan_item_serial',
] as const;

class OrgRun {
  readonly counts: Record<string, EntityCounts> = {};
  readonly exceptions: ImportException[] = [];
  readonly quantization: Record<string, QuantizationClassStats> = {};
  readonly quantizationWorst: QuantizationDrift[] = [];
  readonly variationRateDivergences: VariationRateDivergence[] = [];
  readonly challanSeries: ChallanSeriesReport[] = [];
  serialsSource = 0;
  serialsImported = 0;
  serialsUnchanged = 0;
  serialsExcepted = 0;

  constructor(readonly provenance: ProvenanceMap) {
    for (const entity of ENTITY_ORDER) {
      this.counts[entity] = {
        source: 0,
        imported: 0,
        unchanged: 0,
        drifted: 0,
        excepted: 0,
      };
    }
  }

  count(entity: string): EntityCounts {
    return (this.counts[entity] ??= {
      source: 0,
      imported: 0,
      unchanged: 0,
      drifted: 0,
      excepted: 0,
    });
  }

  except(entityType: string, sourceId: string, rule: string, detail: string): void {
    this.exceptions.push({ entityType, sourceId, rule, detail });
    this.count(entityType).excepted += 1;
  }

  quantized(
    fieldClass: string,
    sourceId: string,
    value: number,
    scale: number,
  ): string {
    const result = quantize(value, scale);
    const stats = (this.quantization[fieldClass] ??= { quantized: 0, changed: 0 });
    stats.quantized += 1;
    if (result.changed) {
      stats.changed += 1;
      this.quantizationWorst.push({
        fieldClass,
        sourceId,
        original: value,
        quantized: result.text,
        relativeDelta: result.relativeDelta,
      });
      this.quantizationWorst.sort((a, b) => b.relativeDelta - a.relativeDelta);
      if (this.quantizationWorst.length > 10) this.quantizationWorst.length = 10;
    }
    return result.text;
  }
}

function provenanceKey(entityType: string, sourceId: string): string {
  return `${entityType} ${sourceId}`;
}

/** Checks a source row against the org's provenance ledger.
 * - 'new': not imported before — write it.
 * - 'unchanged': fingerprints match — a no-op by design (0025).
 * - 'drift': the source row changed since it was imported — reported,
 *   never silently repaired. */
function reconcileProvenance(
  run: OrgRun,
  entityType: string,
  sourceId: string,
  fingerprint: string,
): { state: 'new' } | { state: 'unchanged' | 'drift'; targetId: string } {
  const existing = run.provenance.get(provenanceKey(entityType, sourceId));
  if (!existing) return { state: 'new' };
  if (existing.fingerprint === fingerprint) {
    run.count(entityType).unchanged += 1;
    return { state: 'unchanged', targetId: existing.targetId };
  }
  run.count(entityType).drifted += 1;
  run.exceptions.push({
    entityType,
    sourceId,
    rule: 'source-drift',
    detail:
      'source row changed since it was imported; the imported row was left untouched — resolve manually',
  });
  return { state: 'drift', targetId: existing.targetId };
}

async function insertProvenance(
  tx: TransactionSql,
  organisationId: string,
  batchId: string,
  entityType: string,
  sourceId: string,
  targetId: string,
  fingerprint: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into import_records (
      organisation_id, entity_type, source_system, source_id, target_id,
      batch_id, payload_fingerprint, payload
    )
    values (
      ${organisationId}, ${entityType}, ${SOURCE_SYSTEM}, ${sourceId},
      ${targetId}, ${batchId}, ${fingerprint}, ${jsonb(tx, payload)}
    )
  `;
}

function istMidnight(date: string): string {
  return `${date}T00:00:00${ORGANISATION_TIMEZONE_OFFSET}`;
}

function todayInKolkata(): string {
  const shifted = new Date(Date.now() + (5 * 60 + 30) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

interface OrgSources {
  readonly slug: string;
  readonly name: string;
  readonly works: V1Work[];
  /** workId -> that work's challans (all statuses, source order). */
  readonly challansByWork: Map<string, V1Challan[]>;
}

const differs = (a: number, b: number): boolean =>
  Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b), 1) * 1e-9;

export async function runV1Import(
  sql: Sql,
  options: ImportOptions,
): Promise<RunReport> {
  await assertAdministratorRole(sql);
  const startedAt = new Date().toISOString();
  const { backup, mapping, mode } = options;

  // ---- Pre-pass: resolve companies, group source rows. --------------------
  const orgBySlug = new Map<string, OrgSources>();
  for (const organisation of mapping.organisations) {
    orgBySlug.set(organisation.slug, {
      slug: organisation.slug,
      name: organisation.name,
      works: [],
      challansByWork: new Map(),
    });
  }
  const excludedTally = new Map<string, { works: number; challans: number }>();
  const unmappedTally = new Map<string, { works: number; challans: number }>();
  const runExceptions: ImportException[] = [];
  const workById = new Map(backup.works.map((work) => [work.id, work]));
  const workOrgSlug = new Map<string, string>();

  const bumpTally = (
    map: Map<string, { works: number; challans: number }>,
    company: string,
    field: 'works' | 'challans',
  ): void => {
    const tally = map.get(company) ?? { works: 0, challans: 0 };
    tally[field] += 1;
    map.set(company, tally);
  };

  for (const work of backup.works) {
    const resolution = resolveCompany(mapping, work.contractorName);
    if (resolution.kind === 'organisation') {
      orgBySlug.get(resolution.slug)?.works.push(work);
      workOrgSlug.set(work.id, resolution.slug);
      continue;
    }
    bumpTally(
      resolution.kind === 'excluded' ? excludedTally : unmappedTally,
      work.contractorName,
      'works',
    );
    if (resolution.kind === 'unmapped') {
      runExceptions.push({
        entityType: 'work',
        sourceId: work.id,
        rule: 'unmapped-company',
        detail: `contractorName ${JSON.stringify(work.contractorName)} is neither mapped nor excluded`,
      });
    }
  }

  const challanAgreementExceptions = new Map<string, ImportException[]>();
  for (const challan of backup.challans) {
    const work = workById.get(challan.workId);
    if (!work) {
      runExceptions.push({
        entityType: 'delivery_challan',
        sourceId: challan.id,
        rule: 'orphan-challan',
        detail: `references unknown work ${challan.workId}`,
      });
      continue;
    }
    const workSlug = workOrgSlug.get(challan.workId);
    if (workSlug === undefined) {
      // The work itself is excluded/unmapped; its challans follow it.
      const workResolution = resolveCompany(mapping, work.contractorName);
      bumpTally(
        workResolution.kind === 'excluded' ? excludedTally : unmappedTally,
        work.contractorName,
        'challans',
      );
      continue;
    }
    const challanResolution = resolveCompany(mapping, challan.company);
    if (
      challanResolution.kind !== 'organisation' ||
      challanResolution.slug !== workSlug
    ) {
      const detail =
        challanResolution.kind === 'organisation'
          ? `challan company ${JSON.stringify(challan.company)} maps to ${challanResolution.slug} but its Work ${work.fileNo} belongs to ${workSlug}`
          : `challan company ${JSON.stringify(challan.company)} is ${challanResolution.kind} while its Work ${work.fileNo} belongs to ${workSlug}`;
      const list = challanAgreementExceptions.get(workSlug) ?? [];
      list.push({
        entityType: 'delivery_challan',
        sourceId: challan.id,
        rule: 'challan-work-company-disagreement',
        detail,
      });
      challanAgreementExceptions.set(workSlug, list);
      continue;
    }
    const org = orgBySlug.get(workSlug);
    if (org) {
      const list = org.challansByWork.get(challan.workId) ?? [];
      list.push(challan);
      org.challansByWork.set(challan.workId, list);
    }
  }

  const itemsByWork = new Map<string, V1WorkItem[]>();
  for (const item of backup.workItems) {
    const list = itemsByWork.get(item.workId) ?? [];
    list.push(item);
    itemsByWork.set(item.workId, list);
  }
  const variationsByItem = new Map<string, V1ItemVariation[]>();
  for (const variation of backup.itemVariations) {
    const list = variationsByItem.get(variation.workItemId) ?? [];
    list.push(variation);
    variationsByItem.set(variation.workItemId, list);
  }
  const linesByChallan = new Map<string, V1ChallanItem[]>();
  for (const line of backup.challanItems) {
    const list = linesByChallan.get(line.challanId) ?? [];
    list.push(line);
    linesByChallan.set(line.challanId, list);
  }

  // ---- Import, per organisation. -----------------------------------------
  const organisationReports: OrganisationReport[] = [];
  const contextFor = (slug: string): OrgContext => ({
    itemsByWork,
    variationsByItem,
    linesByChallan,
    consignees: backup.consignees,
    users: backup.users,
    agreementExceptions: challanAgreementExceptions.get(slug) ?? [],
  });

  if (mode === 'dry-run') {
    // The WHOLE pipeline runs in one transaction and rolls back: the
    // report is real, the database is untouched (batch rows included).
    class DryRunRollback extends Error {}
    try {
      await sql.begin(async (tx) => {
        for (const organisation of mapping.organisations) {
          const sources = orgBySlug.get(organisation.slug);
          if (!sources) continue;
          organisationReports.push(
            await importOrganisation(
              tx,
              sources,
              contextFor(organisation.slug),
              options,
            ),
          );
        }
        throw new DryRunRollback('dry-run rollback');
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  } else {
    // Apply: one transaction per organisation, as the controls demand.
    for (const organisation of mapping.organisations) {
      const sources = orgBySlug.get(organisation.slug);
      if (!sources) continue;
      await sql.begin(async (tx) => {
        organisationReports.push(
          await importOrganisation(tx, sources, contextFor(organisation.slug), options),
        );
      });
    }
  }

  const tallies = (
    map: Map<string, { works: number; challans: number }>,
  ): CompanyTally[] =>
    [...map.entries()]
      .map(([company, tally]) => ({ company, ...tally }))
      .sort((a, b) => a.company.localeCompare(b.company));

  return {
    mode,
    sourceSystem: SOURCE_SYSTEM,
    importerVersion: IMPORTER_VERSION,
    inputDigest: options.inputDigest,
    startedAt,
    finishedAt: new Date().toISOString(),
    organisations: organisationReports,
    excludedCompanies: tallies(excludedTally),
    unmappedCompanies: tallies(unmappedTally),
    runExceptions,
  };
}

/** The importer is an operational administrator tool: it must see rows
 * across organisations (provenance lookups, slug lookups) and its writes
 * are audited through import_batches/import_records. Every schema guard
 * and trigger still runs — session_replication_role tricks are forbidden
 * and not used. */
async function assertAdministratorRole(sql: Sql): Promise<void> {
  const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user
  `;
  if (!role || (!role.rolsuper && !role.rolbypassrls)) {
    throw new Error(
      'the importer must run as the database administrator role (superuser or BYPASSRLS); ' +
        'point DATABASE_ADMIN_URL at the owner connection',
    );
  }
}

interface OrgContext {
  readonly itemsByWork: Map<string, V1WorkItem[]>;
  readonly variationsByItem: Map<string, V1ItemVariation[]>;
  readonly linesByChallan: Map<string, V1ChallanItem[]>;
  readonly consignees: readonly string[];
  readonly users: Map<string, string>;
  readonly agreementExceptions: readonly ImportException[];
}

async function importOrganisation(
  tx: TransactionSql,
  sources: OrgSources,
  context: OrgContext,
  options: ImportOptions,
): Promise<OrganisationReport> {
  // 1. Ensure the organisation exists — created idle: no memberships; the
  // operator invites users after cutover. The systemic creator is recorded
  // through the audit trail (organisations carries no created_by column).
  const [existingOrg] = await tx<{ id: string }[]>`
    select id from organisations where slug = ${sources.slug}
  `;
  let organisationId: string;
  if (existingOrg) {
    organisationId = existingOrg.id;
  } else {
    organisationId = randomUUID();
    await tx`
      insert into organisations (id, name, slug)
      values (${organisationId}, ${sources.name}, ${sources.slug})
    `;
    await tx`
      insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id, details)
      values (${organisationId}, ${IMPORT_ACTOR}, 'import.organisation-created',
              'organisations', ${organisationId},
              ${jsonb(tx, { slug: sources.slug, sourceSystem: SOURCE_SYSTEM })})
    `;
  }

  // 2. Open the batch.
  const [batch] = await tx<{ id: string }[]>`
    insert into import_batches (
      organisation_id, source_system, importer_version, input_digest,
      dry_run, operator_note
    )
    values (${organisationId}, ${SOURCE_SYSTEM}, ${IMPORTER_VERSION},
            ${options.inputDigest}, ${options.mode === 'dry-run'},
            ${options.operatorNote ?? null})
    returning id
  `;
  if (!batch) throw new Error('import batch insert returned no row');
  const batchId = batch.id;

  // 3. Load the provenance ledger for idempotent re-runs.
  const provenanceRows = await tx<ProvenanceRow[]>`
    select entity_type, source_id, target_id, payload_fingerprint
    from import_records
    where organisation_id = ${organisationId} and source_system = ${SOURCE_SYSTEM}
  `;
  const run = new OrgRun(
    new Map(
      provenanceRows.map((row) => [
        provenanceKey(row.entity_type, row.source_id),
        { targetId: row.target_id, fingerprint: row.payload_fingerprint },
      ]),
    ),
  );
  for (const exception of context.agreementExceptions) {
    run.exceptions.push(exception);
    run.count(exception.entityType).excepted += 1;
    run.count(exception.entityType).source += 1;
  }

  const writer: Writer = {
    tx,
    organisationId,
    batchId,
    run,
    context,
  };
  await importConsignees(writer, sources);
  const workTargets = await importWorks(writer, sources);
  await importChallans(writer, sources, workTargets);

  // Value totals: source floats summed as-read vs exact numeric sums of
  // what this organisation now holds under import provenance.
  const sourceContractTotal = sources.works.reduce(
    (sum, work) => sum + work.totalCost,
    0,
  );
  let sourceLineTotal = 0;
  for (const challans of sources.challansByWork.values()) {
    for (const challan of challans) {
      for (const line of context.linesByChallan.get(challan.id) ?? []) {
        sourceLineTotal += line.qty * line.rate;
      }
    }
  }
  const [importedTotals] = await tx<{ contract_total: string; line_total: string }[]>`
    select
      (select coalesce(sum(w.contract_value), 0)::text
       from works w
       where w.organisation_id = ${organisationId}
         and w.id in (select target_id from import_records
                      where organisation_id = ${organisationId}
                        and entity_type = 'work')) as contract_total,
      (select coalesce(sum(dci.line_amount), 0)::text
       from delivery_challan_items dci
       where dci.organisation_id = ${organisationId}
         and dci.id in (select target_id from import_records
                        where organisation_id = ${organisationId}
                          and entity_type = 'delivery_challan_item')) as line_total
  `;

  const report: OrganisationReport = {
    slug: sources.slug,
    name: sources.name,
    organisationId,
    batchId,
    counts: run.counts,
    valueTotals: {
      contractValueSource: quantize(sourceContractTotal, 2).text,
      contractValueImported: importedTotals?.contract_total ?? '0',
      challanLineTotalSource: quantize(sourceLineTotal, 2).text,
      challanLineTotalImported: importedTotals?.line_total ?? '0',
    },
    challanSeries: run.challanSeries,
    serials: {
      sourceTokens: run.serialsSource,
      imported: run.serialsImported,
      unchanged: run.serialsUnchanged,
      excepted: run.serialsExcepted,
    },
    quantization: run.quantization,
    quantizationWorst: run.quantizationWorst,
    variationRateDivergences: {
      count: run.variationRateDivergences.length,
      sample: run.variationRateDivergences.slice(0, 10),
    },
    exceptions: run.exceptions,
  };

  // 4. Close the batch with the reconciliation record and an audit event.
  await tx`
    update import_batches
    set finished_at = now(), reconciliation = ${jsonb(tx, report)}
    where organisation_id = ${organisationId} and id = ${batchId}
  `;
  await tx`
    insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id, details)
    values (${organisationId}, ${IMPORT_ACTOR}, 'import.batch-completed',
            'import_batches', ${batchId},
            ${jsonb(tx, {
              mode: options.mode,
              exceptions: run.exceptions.length,
              works: run.count('work').imported,
              challans: run.count('delivery_challan').imported,
            })})
  `;
  return report;
}

interface Writer {
  readonly tx: TransactionSql;
  readonly organisationId: string;
  readonly batchId: string;
  readonly run: OrgRun;
  readonly context: OrgContext;
}

async function importConsignees(writer: Writer, sources: OrgSources): Promise<void> {
  const { tx, run, organisationId, batchId, context } = writer;
  // v1's consignee master list was installation-wide; each imported
  // organisation receives it, plus every distinct trimmed 'to' value on
  // its own challans. Retire-not-delete semantics: all created active.
  const designations = new Map<string, string>();
  for (const name of context.consignees) {
    const trimmed = name.trim();
    if (trimmed.length >= 2) designations.set(trimmed.toLowerCase(), trimmed);
  }
  for (const challans of sources.challansByWork.values()) {
    for (const challan of challans) {
      const trimmed = challan.to.trim();
      if (trimmed.length >= 2 && !designations.has(trimmed.toLowerCase())) {
        designations.set(trimmed.toLowerCase(), trimmed);
      }
    }
  }

  for (const [key, designation] of [...designations.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entity = 'consignee_master';
    run.count(entity).source += 1;
    const sourceId = `consignee:${key}`;
    const fingerprint = fingerprintOf({ designation });
    const state = reconcileProvenance(run, entity, sourceId, fingerprint);
    if (state.state !== 'new') continue;
    // The master may already exist (created by hand before the import);
    // reuse it rather than duplicating.
    const [existing] = await tx<{ id: string }[]>`
      select id from consignee_masters
      where organisation_id = ${organisationId}
        and lower(designation) = ${key} and address is null
    `;
    let targetId: string;
    if (existing) {
      targetId = existing.id;
    } else {
      const [inserted] = await tx<{ id: string }[]>`
        insert into consignee_masters (organisation_id, designation, created_by_user_id)
        values (${organisationId}, ${designation}, ${IMPORT_ACTOR})
        returning id
      `;
      if (!inserted) throw new Error('consignee master insert returned no row');
      targetId = inserted.id;
    }
    await insertProvenance(
      tx,
      organisationId,
      batchId,
      entity,
      sourceId,
      targetId,
      fingerprint,
      {},
    );
    run.provenance.set(provenanceKey(entity, sourceId), { targetId, fingerprint });
    run.count(entity).imported += 1;
  }
}

interface WorkTarget {
  readonly targetId: string;
  readonly workCode: string;
  readonly letterDate: string;
  readonly itemTargets: Map<string, string>;
}

async function importWorks(
  writer: Writer,
  sources: OrgSources,
): Promise<Map<string, WorkTarget>> {
  const { tx, run, organisationId, batchId, context } = writer;
  const targets = new Map<string, WorkTarget>();
  const seenCodes = new Set<string>();
  const seenLetterNumbers = new Set<string>();

  for (const work of [...sources.works].sort((a, b) =>
    a.fileNo.localeCompare(b.fileNo),
  )) {
    run.count('work').source += 1;
    const items = context.itemsByWork.get(work.id) ?? [];
    for (const item of items) {
      run.count('work_item').source += 1;
      run.count('item_variation').source += (
        context.variationsByItem.get(item.id) ?? []
      ).length;
    }

    const code = normaliseWorkCode(work.fileNo);
    if (!code) {
      run.except(
        'work',
        work.id,
        'work-code-shape (R1)',
        `fileNo ${JSON.stringify(work.fileNo)} cannot satisfy the work_code CHECK even uppercased`,
      );
      continue;
    }
    const letterNumber = work.loaNo.trim();
    const title = work.name.trim();
    if (!isIsoDate(work.loaDate)) {
      run.except(
        'work',
        work.id,
        'letter-date-required',
        `loaDate ${JSON.stringify(work.loaDate)} is not a date; completion/letter dates are never guessed`,
      );
      continue;
    }
    if (letterNumber.length < 1 || letterNumber.length > 200) {
      run.except(
        'work',
        work.id,
        'letter-number-length',
        `loaNo length ${String(letterNumber.length)} outside 1..200`,
      );
      continue;
    }
    if (title.length < 3 || title.length > 1000) {
      run.except(
        'work',
        work.id,
        'title-length',
        `name length ${String(title.length)} outside 3..1000`,
      );
      continue;
    }
    if (seenCodes.has(code.code)) {
      run.except(
        'work',
        work.id,
        'duplicate-work-code',
        `normalised code ${code.code} already imported for another work`,
      );
      continue;
    }
    if (seenLetterNumbers.has(letterNumber)) {
      run.except(
        'work',
        work.id,
        'duplicate-letter-number',
        'loaNo already imported for another work',
      );
      continue;
    }

    const createdAt = timestampFromV1Id(work.id) ?? istMidnight(work.loaDate);
    const fingerprint = fingerprintOf(work);
    const state = reconcileProvenance(run, 'work', work.id, fingerprint);
    let workTargetId: string;
    if (state.state === 'new') {
      const contractValue = run.quantized('contract_value', work.id, work.totalCost, 2);
      workTargetId = randomUUID();
      try {
        await tx.savepoint(async (sp) => {
          await sp`
            insert into works (
              id, organisation_id, work_code, letter_number, letter_date, title,
              advertised_value, contract_value, pricing_shape,
              created_by_user_id, created_at, updated_at
            )
            values (
              ${workTargetId}, ${organisationId}, ${code.code}, ${letterNumber},
              ${work.loaDate}, ${title}, ${contractValue}, ${contractValue},
              'per_schedule', ${IMPORT_ACTOR}, ${createdAt}, ${createdAt}
            )
          `;
          await insertProvenance(
            sp,
            organisationId,
            batchId,
            'work',
            work.id,
            workTargetId,
            fingerprint,
            {
              originalFileNo: code.changed ? code.original : undefined,
              zone: work.zone,
              division: work.division,
              tenderIssuingAuthority: work.tenderIssuingAuthority,
              caNo: work.caNo,
              caDate: work.caDate,
              // 0016 PBG requirement columns need the submission window,
              // which v1 never recorded — the amounts stay in provenance
              // instead of half-filling the all-or-nothing requirement.
              pbgLoa: work.pbgLoa,
              pbgActual: work.pbgActual,
              // Free-text completion periods: kept verbatim, never guessed
              // into the target's date columns.
              actualCompletionPeriod: work.actualCompletionPeriod,
              workExtensionPeriod: work.workExtensionPeriod,
              pbgCompletionPeriod: work.pbgCompletionPeriod,
              excelFilename: work.excelFilename,
              contractorName: work.contractorName,
            },
          );
        });
      } catch (error) {
        run.except('work', work.id, 'database-guard', guardMessage(error));
        continue;
      }
      run.count('work').imported += 1;
      run.provenance.set(provenanceKey('work', work.id), {
        targetId: workTargetId,
        fingerprint,
      });
    } else {
      // Unchanged or drifted: children are still reconciled below so
      // re-runs account for every source row.
      workTargetId = state.targetId;
    }
    seenCodes.add(code.code);
    seenLetterNumbers.add(letterNumber);

    const itemTargets = await importWorkItems(
      writer,
      sources,
      work,
      workTargetId,
      createdAt,
      items,
    );
    targets.set(work.id, {
      targetId: workTargetId,
      workCode: code.code,
      letterDate: work.loaDate,
      itemTargets,
    });
  }
  return targets;
}

function collectSerialItems(
  sources: OrgSources,
  context: OrgContext,
  workId: string,
): Set<string> {
  const flagged = new Set<string>();
  for (const challan of sources.challansByWork.get(workId) ?? []) {
    for (const line of context.linesByChallan.get(challan.id) ?? []) {
      if (parseSerials(line.serialNo).length > 0) flagged.add(line.itemId);
    }
  }
  return flagged;
}

async function importWorkItems(
  writer: Writer,
  sources: OrgSources,
  work: V1Work,
  workTargetId: string,
  workCreatedAt: string,
  items: readonly V1WorkItem[],
): Promise<Map<string, string>> {
  const { tx, run, organisationId, batchId, context } = writer;
  const itemTargets = new Map<string, string>();
  const requiresSerialsItemIds = collectSerialItems(sources, context, work.id);

  // One work_schedule per distinct schedule string, lexicographic order.
  const scheduleCodes = [...new Set(items.map((item) => item.schedule.trim()))].sort(
    (a, b) => a.localeCompare(b),
  );
  const scheduleTargets = new Map<string, string>();
  let position = 0;
  for (const scheduleCode of scheduleCodes) {
    position += 1;
    run.count('work_schedule').source += 1;
    if (scheduleCode.length < 1 || scheduleCode.length > 50) {
      run.except(
        'work_schedule',
        `${work.id}:${scheduleCode}`,
        'schedule-code-length',
        `schedule ${JSON.stringify(scheduleCode)} outside 1..50 chars`,
      );
      continue;
    }
    const sourceId = `${work.id}:${scheduleCode}`;
    const fingerprint = fingerprintOf({ workId: work.id, schedule: scheduleCode });
    const state = reconcileProvenance(run, 'work_schedule', sourceId, fingerprint);
    if (state.state !== 'new') {
      scheduleTargets.set(scheduleCode, state.targetId);
      continue;
    }
    const targetId = randomUUID();
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          insert into work_schedules (
            id, organisation_id, work_id, schedule_code, title, position, created_at
          )
          values (${targetId}, ${organisationId}, ${workTargetId}, ${scheduleCode},
                  ${`Schedule ${scheduleCode}`}, ${position}, ${workCreatedAt})
        `;
        await insertProvenance(
          sp,
          organisationId,
          batchId,
          'work_schedule',
          sourceId,
          targetId,
          fingerprint,
          {},
        );
      });
    } catch (error) {
      run.except('work_schedule', sourceId, 'database-guard', guardMessage(error));
      continue;
    }
    run.provenance.set(provenanceKey('work_schedule', sourceId), {
      targetId,
      fingerprint,
    });
    run.count('work_schedule').imported += 1;
    scheduleTargets.set(scheduleCode, targetId);
  }

  for (const item of items) {
    const variations = context.variationsByItem.get(item.id) ?? [];
    const fingerprint = fingerprintOf({ item, variations });
    const state = reconcileProvenance(run, 'work_item', item.id, fingerprint);
    if (state.state !== 'new') {
      itemTargets.set(item.id, state.targetId);
      for (const variation of variations) {
        reconcileProvenance(
          run,
          'item_variation',
          variation.id,
          fingerprintOf(variation),
        );
      }
      continue;
    }

    const scheduleTarget = scheduleTargets.get(item.schedule.trim());
    if (scheduleTarget === undefined) {
      run.except(
        'work_item',
        item.id,
        'schedule-not-imported',
        `schedule ${JSON.stringify(item.schedule)} was not imported`,
      );
      continue;
    }
    const unit = normaliseUnit(item.unit);
    if (!unit) {
      run.except(
        'work_item',
        item.id,
        'unit-code-shape',
        `unit ${JSON.stringify(item.unit)} has no deterministic <=20-char form`,
      );
      continue;
    }
    const description = item.description.trim();
    if (description.length < 3) {
      run.except(
        'work_item',
        item.id,
        'description-length',
        'description shorter than 3 characters',
      );
      continue;
    }
    const awardedQuantity = run.quantized('awarded_quantity', item.id, item.qty, 3);
    if (Number(awardedQuantity) <= 0) {
      run.except(
        'work_item',
        item.id,
        'awarded-quantity-positive',
        `qty ${String(item.qty)} violates awarded_quantity > 0 (v1 variation-only non-schedule item)`,
      );
      continue;
    }
    // DOCUMENTED DECISION (verified against the backup): v1's agtRate is
    // the awarded AGREEMENT rate — every delivery challan line bills at it
    // (1360/1360 lines match agtRate, 0 match only `rate`) and
    // work_items.total = qty*agtRate + Σ(variation qty×rate) on all 3127
    // rows; the v1 `rate` column is the pre-award estimate. The target's
    // effective_rate therefore takes agtRate, the estimate stays in
    // provenance, and the 0012 amendment overlay (effective_unit_rate)
    // stays NULL — the agreement rate is the ORIGINAL award, not a
    // sanctioned amendment, so writing it into the amendment overlay
    // would fabricate an amendment that never happened.
    const effectiveRate = run.quantized('effective_rate', item.id, item.agtRate, 2);
    // Variation semantics (verified): work_items.variation equals the sum
    // of item_variations qty deltas on all 346 items that have variation
    // rows, so the net effective quantity is qty + variation. Variation
    // rows carrying their own rate are recorded in provenance and
    // surfaced in the report (the single-rate target model carries their
    // quantity effect; their price effect lives in provenance).
    const netQuantity = item.qty + item.variation;
    let effectiveQuantity: string | null = null;
    if (differs(netQuantity, item.qty)) {
      if (netQuantity < 0) {
        run.except(
          'work_item',
          item.id,
          'effective-quantity-negative',
          `qty ${String(item.qty)} + variation ${String(item.variation)} is negative`,
        );
        continue;
      }
      effectiveQuantity = run.quantized('effective_quantity', item.id, netQuantity, 3);
    }
    for (const variation of variations) {
      if (differs(variation.rate, item.agtRate)) {
        run.variationRateDivergences.push({
          workItemSourceId: item.id,
          variationSourceId: variation.id,
          variationRate: variation.rate,
          agreementRate: item.agtRate,
        });
      }
    }

    const itemNumber = `${item.schedule.trim()}/${String(item.srNo)}`;
    const targetId = randomUUID();
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          insert into work_items (
            id, organisation_id, work_id, schedule_id, item_number,
            description, unit_code, awarded_quantity, effective_rate,
            effective_quantity, requires_serials, source_evidence,
            created_at, updated_at
          )
          values (
            ${targetId}, ${organisationId}, ${workTargetId}, ${scheduleTarget},
            ${itemNumber}, ${description}, ${unit.unit}, ${awardedQuantity},
            ${effectiveRate}, ${effectiveQuantity},
            ${requiresSerialsItemIds.has(item.id)},
            ${jsonb(sp, { import: { sourceSystem: SOURCE_SYSTEM, sourceId: item.id } })},
            ${workCreatedAt}, ${workCreatedAt}
          )
        `;
        await insertProvenance(
          sp,
          organisationId,
          batchId,
          'work_item',
          item.id,
          targetId,
          fingerprint,
          {
            estimateRate: item.rate,
            agreementRate: item.agtRate,
            variationTotal: item.variation,
            v1Total: item.total,
            originalUnit: unit.changed ? unit.original : undefined,
            variations,
          },
        );
        for (const variation of variations) {
          await insertProvenance(
            sp,
            organisationId,
            batchId,
            'item_variation',
            variation.id,
            targetId,
            fingerprintOf(variation),
            { ...variation },
          );
        }
      });
    } catch (error) {
      run.except('work_item', item.id, 'database-guard', guardMessage(error));
      continue;
    }
    run.count('work_item').imported += 1;
    run.count('item_variation').imported += variations.length;
    run.provenance.set(provenanceKey('work_item', item.id), { targetId, fingerprint });
    for (const variation of variations) {
      run.provenance.set(provenanceKey('item_variation', variation.id), {
        targetId,
        fingerprint: fingerprintOf(variation),
      });
    }
    itemTargets.set(item.id, targetId);
  }
  return itemTargets;
}

interface PreparedChallan {
  readonly challan: V1Challan;
  readonly sequence: number | null;
  readonly prefix: string | null;
}

type SerialAction =
  | { readonly kind: 'import'; readonly token: string }
  | { readonly kind: 'duplicate'; readonly token: string; readonly ownerLineId: string }
  | { readonly kind: 'too-long'; readonly token: string };

/** Deterministic serial plan for one challan's lines: the first
 * occurrence in (series order, line order, token order) owns a serial;
 * later occurrences are named exceptions — never a silent dedup. */
function planChallanSerials(
  lines: readonly V1ChallanItem[],
  ownerByToken: Map<string, string>,
): Map<string, SerialAction[]> {
  const plan = new Map<string, SerialAction[]>();
  for (const line of lines) {
    const seenOnLine = new Set<string>();
    const actions: SerialAction[] = [];
    for (const token of parseSerials(line.serialNo)) {
      if (token.length > 100) {
        actions.push({ kind: 'too-long', token });
        continue;
      }
      const owner = ownerByToken.get(token);
      if ((owner !== undefined && owner !== line.id) || seenOnLine.has(token)) {
        actions.push({
          kind: 'duplicate',
          token,
          ownerLineId: owner ?? line.id,
        });
        continue;
      }
      seenOnLine.add(token);
      actions.push({ kind: 'import', token });
    }
    plan.set(line.id, actions);
  }
  return plan;
}

async function importChallans(
  writer: Writer,
  sources: OrgSources,
  workTargets: Map<string, WorkTarget>,
): Promise<void> {
  const { tx, run, organisationId, context } = writer;
  const today = todayInKolkata();

  for (const [workId, challans] of [...sources.challansByWork.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const workTarget = workTargets.get(workId);
    for (const challan of challans) {
      run.count('delivery_challan').source += 1;
      run.count('delivery_challan_item').source += (
        context.linesByChallan.get(challan.id) ?? []
      ).length;
    }
    if (!workTarget) {
      for (const challan of challans) {
        run.except(
          'delivery_challan',
          challan.id,
          'work-not-imported',
          `its Work ${workId} was not imported`,
        );
      }
      continue;
    }

    const confirmed: PreparedChallan[] = [];
    const pending: PreparedChallan[] = [];
    for (const challan of challans) {
      const parsed = parseChallanNumber(challan.challanNo);
      const prepared: PreparedChallan = {
        challan,
        sequence: parsed?.sequence ?? null,
        prefix: parsed?.prefix ?? null,
      };
      if (challan.status === 'confirmed') confirmed.push(prepared);
      else pending.push(prepared);
    }
    const seriesOrder = [
      ...[...confirmed].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
      ...[...pending].sort((a, b) =>
        (a.challan.createdAt || a.challan.id).localeCompare(
          b.challan.createdAt || b.challan.id,
        ),
      ),
    ];

    // Serial ownership across the whole Work, in deterministic order.
    const ownerByToken = new Map<string, string>();
    for (const prepared of seriesOrder) {
      for (const line of context.linesByChallan.get(prepared.challan.id) ?? []) {
        for (const token of parseSerials(line.serialNo)) {
          run.serialsSource += 1;
          run.count('challan_item_serial').source += 1;
          if (!ownerByToken.has(token)) ownerByToken.set(token, line.id);
        }
      }
    }

    // R2 sharp edge: no two challans in one Work may share a sequence.
    const bySequence = new Map<number, PreparedChallan[]>();
    for (const prepared of confirmed) {
      if (prepared.sequence === null) continue;
      const list = bySequence.get(prepared.sequence) ?? [];
      list.push(prepared);
      bySequence.set(prepared.sequence, list);
    }
    const duplicateSequences = [...bySequence.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([sequence]) => sequence)
      .sort((a, b) => a - b);
    const duplicated = new Set<string>();
    for (const sequence of duplicateSequences) {
      for (const prepared of bySequence.get(sequence) ?? []) {
        duplicated.add(prepared.challan.id);
        run.except(
          'delivery_challan',
          prepared.challan.id,
          'duplicate-sequence-in-work',
          `challanNo ${JSON.stringify(prepared.challan.challanNo)} shares sequence ${String(sequence)} with another challan of Work ${workTarget.workCode}; neither is imported`,
        );
      }
    }

    const importedSequences: number[] = [];
    const prefixes = new Set<string>();
    let maxConfirmedSequence = 0;
    for (const prepared of confirmed) {
      if (prepared.sequence !== null && !duplicated.has(prepared.challan.id)) {
        maxConfirmedSequence = Math.max(maxConfirmedSequence, prepared.sequence);
      }
    }

    for (const prepared of [...confirmed].sort(
      (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
    )) {
      if (duplicated.has(prepared.challan.id)) continue;
      const outcome = await importOneChallan(writer, workTarget, prepared, {
        today,
        ownerByToken,
        kind: 'issued',
      });
      if (outcome !== null) {
        importedSequences.push(outcome);
        if (prepared.prefix) prefixes.add(prepared.prefix);
      }
    }

    // Pending rows become UNNUMBERED drafts. Their abandoned numbers are
    // never re-minted; a pending number that is not above every confirmed
    // number is a reconciliation exception (the series moved past it).
    let draftPresent = await tx<{ present: boolean }[]>`
      select exists (
        select 1 from delivery_challans
        where organisation_id = ${organisationId}
          and work_id = ${workTarget.targetId} and status = 'draft'
      ) as present
    `.then((rows) => rows[0]?.present ?? false);
    for (const prepared of [...pending].sort((a, b) =>
      (a.challan.createdAt || a.challan.id).localeCompare(
        b.challan.createdAt || b.challan.id,
      ),
    )) {
      if (prepared.sequence === null) {
        run.except(
          'delivery_challan',
          prepared.challan.id,
          'pending-number-unparseable',
          `pending challanNo ${JSON.stringify(prepared.challan.challanNo)} has no trailing integer; cannot prove its series position`,
        );
        continue;
      }
      if (prepared.sequence <= maxConfirmedSequence) {
        run.exceptions.push({
          entityType: 'delivery_challan',
          sourceId: prepared.challan.id,
          rule: 'pending-below-series-head',
          detail: `pending challanNo ${JSON.stringify(prepared.challan.challanNo)} (sequence ${String(prepared.sequence)}) is not above every confirmed number (max ${String(maxConfirmedSequence)}); its number is abandoned, the draft carries none`,
        });
      }
      const alreadyImported = run.provenance.has(
        provenanceKey('delivery_challan', prepared.challan.id),
      );
      if (draftPresent && !alreadyImported) {
        run.except(
          'delivery_challan',
          prepared.challan.id,
          'one-draft-per-work',
          `Work ${workTarget.workCode} already carries a draft challan; this pending challan was not imported`,
        );
        continue;
      }
      await importOneChallan(writer, workTarget, prepared, {
        today,
        ownerByToken,
        kind: 'draft',
      });
      if (run.provenance.has(provenanceKey('delivery_challan', prepared.challan.id))) {
        draftPresent = true;
      }
    }

    // Counter placement: the live issue route increments-then-reads
    // (`next_value = next_value + 1 ... returning next_value`), so storing
    // the HIGHEST IMPORTED SEQUENCE makes the next issued challan take
    // highest + 1 — R2 continuity, no number skipped, none re-minted. The
    // counter-decrease guard allows only growth, hence greatest().
    const highest = importedSequences.length > 0 ? Math.max(...importedSequences) : 0;
    if (highest > 0) {
      await tx`
        insert into delivery_challan_counters (organisation_id, work_id, next_value)
        values (${organisationId}, ${workTarget.targetId}, ${highest})
        on conflict (organisation_id, work_id) do update
          set next_value = greatest(delivery_challan_counters.next_value, ${highest}),
              updated_at = now()
      `;
    }

    const gaps: number[] = [];
    const sequenceSet = new Set(importedSequences);
    for (let sequence = 1; sequence <= highest; sequence += 1) {
      if (!sequenceSet.has(sequence)) gaps.push(sequence);
    }
    if (confirmed.length > 0 || pending.length > 0) {
      run.challanSeries.push({
        workCode: workTarget.workCode,
        prefixes: [...prefixes].sort((a, b) => a.localeCompare(b)),
        highestSequence: highest,
        counterValue: highest,
        nextIssueSequence: highest + 1,
        gapCount: gaps.length,
        gaps,
        duplicateSequences,
      });
    }
  }
}

interface ChallanImportSettings {
  readonly today: string;
  readonly ownerByToken: Map<string, string>;
  readonly kind: 'issued' | 'draft';
}

function pushSerialExceptions(
  run: OrgRun,
  workCode: string,
  lineId: string,
  actions: readonly SerialAction[],
): void {
  for (const action of actions) {
    if (action.kind === 'too-long') {
      run.except(
        'challan_item_serial',
        `${lineId}#${action.token.slice(0, 60)}`,
        'serial-length',
        `serial token of ${String(action.token.length)} chars exceeds the 100-char CHECK`,
      );
      run.serialsExcepted += 1;
    } else if (action.kind === 'duplicate') {
      run.except(
        'challan_item_serial',
        `${lineId}#${action.token}`,
        'duplicate-serial-in-work',
        `serial ${JSON.stringify(action.token)} appears on v1 lines ${action.ownerLineId} and ${lineId} of Work ${workCode}; imported once (line ${action.ownerLineId}), duplicate reported`,
      );
      run.serialsExcepted += 1;
    }
  }
}

/** Imports one challan (draft first, then the issue flip for confirmed
 * rows) inside a savepoint; returns the issued sequence number, or null
 * for drafts and exceptions. */
async function importOneChallan(
  writer: Writer,
  workTarget: WorkTarget,
  prepared: PreparedChallan,
  settings: ChallanImportSettings,
): Promise<number | null> {
  const { tx, run, organisationId, batchId, context } = writer;
  const { challan } = prepared;
  const lines = context.linesByChallan.get(challan.id) ?? [];
  const fingerprint = fingerprintOf({ challan, lines });
  const state = reconcileProvenance(run, 'delivery_challan', challan.id, fingerprint);
  if (state.state !== 'new') {
    // Re-run: account for lines and serials so the report covers every
    // source row, and re-report source-side serial defects for parity.
    const serialPlan = planChallanSerials(lines, settings.ownerByToken);
    for (const line of lines) {
      reconcileProvenance(run, 'delivery_challan_item', line.id, fingerprintOf(line));
      const actions = serialPlan.get(line.id) ?? [];
      pushSerialExceptions(run, workTarget.workCode, line.id, actions);
      for (const action of actions) {
        if (action.kind !== 'import') continue;
        const serialState = reconcileProvenance(
          run,
          'challan_item_serial',
          `${line.id}#${action.token}`,
          fingerprintOf({ line: line.id, serial: action.token }),
        );
        if (serialState.state === 'unchanged') run.serialsUnchanged += 1;
      }
    }
    return settings.kind === 'issued' ? prepared.sequence : null;
  }

  if (settings.kind === 'issued' && prepared.sequence === null) {
    run.except(
      'delivery_challan',
      challan.id,
      'sequence-unparseable (R2)',
      `challanNo ${JSON.stringify(challan.challanNo)} has no trailing integer sequence; issued challans require one and numbers are never fabricated`,
    );
    return null;
  }
  if (!isIsoDate(challan.date)) {
    run.except(
      'delivery_challan',
      challan.id,
      'challan-date-shape',
      `date ${JSON.stringify(challan.date)} is not a date`,
    );
    return null;
  }
  if (challan.date < workTarget.letterDate) {
    run.except(
      'delivery_challan',
      challan.id,
      'challan-date-precedes-loa (0010)',
      `challan ${JSON.stringify(challan.challanNo)} dated ${challan.date} precedes the LOA letter date ${workTarget.letterDate}`,
    );
    return null;
  }
  if (challan.date > settings.today) {
    run.except(
      'delivery_challan',
      challan.id,
      'challan-date-in-future (0010)',
      `challan ${JSON.stringify(challan.challanNo)} dated ${challan.date} is after today (${settings.today}, organisation timezone)`,
    );
    return null;
  }
  const prefix = prepared.prefix ?? deriveFallbackPrefix(workTarget.workCode);

  interface LinePlan {
    readonly line: V1ChallanItem;
    readonly itemTargetId: string;
    readonly quantity: string;
    readonly rate: string;
  }
  const linePlans: LinePlan[] = [];
  for (const line of lines) {
    const itemTargetId = workTarget.itemTargets.get(line.itemId);
    if (itemTargetId === undefined) {
      run.except(
        'delivery_challan_item',
        line.id,
        'work-item-not-imported',
        `line of challan ${JSON.stringify(challan.challanNo)} references v1 item ${line.itemId}, which was not imported`,
      );
      continue;
    }
    const quantity = run.quantized('line_quantity', line.id, line.qty, 3);
    if (Number(quantity) <= 0) {
      run.except(
        'delivery_challan_item',
        line.id,
        'line-quantity-positive',
        `qty ${String(line.qty)} violates quantity > 0`,
      );
      continue;
    }
    const rate = run.quantized('line_rate', line.id, line.rate, 2);
    linePlans.push({ line, itemTargetId, quantity, rate });
  }
  if (linePlans.length === 0) {
    run.except(
      'delivery_challan',
      challan.id,
      'no-importable-lines',
      `challan ${JSON.stringify(challan.challanNo)} has no importable lines`,
    );
    return null;
  }
  const serialPlan = planChallanSerials(
    linePlans.map((plan) => plan.line),
    settings.ownerByToken,
  );

  const createdAt =
    challan.createdAt && Number.isFinite(Date.parse(challan.createdAt))
      ? new Date(challan.createdAt).toISOString()
      : (timestampFromV1Id(challan.id) ?? istMidnight(challan.date));
  const consigneeName =
    challan.to.trim().length >= 2 ? challan.to.trim() : 'Not recorded';
  const consignee = { name: consigneeName, address: ADDRESS_NOT_RECORDED };

  const targetId = randomUUID();
  let importedSerials = 0;
  let importedLines = 0;
  try {
    await tx.savepoint(async (sp) => {
      await sp`
        insert into delivery_challans (
          id, organisation_id, work_id, status, challan_date, prefix,
          consignee_snapshot, created_by_user_id, created_at, updated_at
        )
        values (
          ${targetId}, ${organisationId}, ${workTarget.targetId}, 'draft',
          ${challan.date}, ${prefix}, ${jsonb(sp, consignee)}, ${IMPORT_ACTOR},
          ${createdAt}, ${createdAt}
        )
      `;
      let position = 0;
      for (const plan of linePlans) {
        position += 1;
        const lineTargetId = randomUUID();
        await sp`
          insert into delivery_challan_items (
            id, organisation_id, delivery_challan_id, work_id, work_item_id,
            description_snapshot, unit_snapshot, quantity, rate_snapshot,
            line_amount, source_evidence, position
          )
          values (
            ${lineTargetId}, ${organisationId}, ${targetId}, ${workTarget.targetId},
            ${plan.itemTargetId}, ${plan.line.description}, ${plan.line.unit},
            ${plan.quantity}, ${plan.rate},
            (${plan.quantity}::numeric(18,3) * ${plan.rate}::numeric(18,2))::numeric(18,2),
            ${jsonb(sp, { import: { sourceSystem: SOURCE_SYSTEM, sourceId: plan.line.id } })},
            ${position}
          )
        `;
        importedLines += 1;
        await insertProvenance(
          sp,
          organisationId,
          batchId,
          'delivery_challan_item',
          plan.line.id,
          lineTargetId,
          fingerprintOf(plan.line),
          {
            scheduleNo: plan.line.scheduleNo,
            remark: plan.line.remark || undefined,
            variation: plan.line.variation || undefined,
            warrantyQty: plan.line.warrantyQty,
            serialNoRaw: plan.line.serialNo || undefined,
          },
        );

        // Serials are recorded while the challan is a draft — the same
        // order the live issue route requires.
        for (const action of serialPlan.get(plan.line.id) ?? []) {
          if (action.kind !== 'import') continue;
          const serialSourceId = `${plan.line.id}#${action.token}`;
          const serialTargetId = randomUUID();
          await sp`
            insert into challan_item_serials (
              id, organisation_id, work_id, delivery_challan_id,
              delivery_challan_item_id, serial_number, created_at, updated_at
            )
            values (${serialTargetId}, ${organisationId}, ${workTarget.targetId},
                    ${targetId}, ${lineTargetId}, ${action.token},
                    ${createdAt}, ${createdAt})
          `;
          await insertProvenance(
            sp,
            organisationId,
            batchId,
            'challan_item_serial',
            serialSourceId,
            serialTargetId,
            fingerprintOf({ line: plan.line.id, serial: action.token }),
            {},
          );
          importedSerials += 1;
        }
      }

      if (settings.kind === 'issued') {
        // Issue flip: the exact snapshot shape the issue route writes,
        // with the historical number preserved EXACTLY as printed.
        const [organisation] = await sp<{ name: string }[]>`
          select name from organisations where id = ${organisationId}
        `;
        const [workRow] = await sp<{ title: string; letter_number: string }[]>`
          select title, letter_number from works
          where organisation_id = ${organisationId} and id = ${workTarget.targetId}
        `;
        const numericLines = await sp<
          {
            quantity: string;
            rate_snapshot: string;
            line_amount: string;
            position: number;
            description_snapshot: string;
            unit_snapshot: string;
            item_number: string;
          }[]
        >`
          select dci.quantity::text as quantity,
                 dci.rate_snapshot::text as rate_snapshot,
                 dci.line_amount::text as line_amount, dci.position,
                 dci.description_snapshot, dci.unit_snapshot, wi.item_number
          from delivery_challan_items dci
          join work_items wi on wi.id = dci.work_item_id
          where dci.delivery_challan_id = ${targetId}
          order by dci.position
        `;
        const [total] = await sp<{ amount: string }[]>`
          select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
          from delivery_challan_items where delivery_challan_id = ${targetId}
        `;
        const issuedAt = istMidnight(challan.date);
        const snapshot: ChallanSnapshot = {
          templateVersion: CHALLAN_TEMPLATE_VERSION,
          organisationName: organisation?.name ?? '',
          challanNumber: challan.challanNo,
          challanDate: challan.date,
          issuedAt,
          work: {
            workCode: workTarget.workCode,
            title: workRow?.title ?? '',
            letterNumber: workRow?.letter_number ?? '',
            letterDate: workTarget.letterDate,
          },
          consignee,
          items: numericLines.map((line) => ({
            position: line.position,
            itemNumber: line.item_number,
            description: line.description_snapshot,
            unit: line.unit_snapshot,
            quantity: line.quantity,
            rate: line.rate_snapshot,
            lineAmount: line.line_amount,
          })),
          totalAmount: total?.amount ?? '0.00',
        };
        await sp`
          update delivery_challans
          set status = 'issued', challan_number = ${challan.challanNo},
              sequence_number = ${prepared.sequence},
              issued_snapshot = ${jsonb(sp, snapshot)},
              issued_by_user_id = ${IMPORT_ACTOR}, issued_at = ${issuedAt},
              template_version = ${CHALLAN_TEMPLATE_VERSION}
          where id = ${targetId}
        `;
      }

      await insertProvenance(
        sp,
        organisationId,
        batchId,
        'delivery_challan',
        challan.id,
        targetId,
        fingerprint,
        {
          company: challan.company,
          siteEngineer: challan.siteEngineer || undefined,
          remark: challan.remark || undefined,
          v1Status: challan.status,
          v1ChallanNo: challan.challanNo,
          createdBy: challan.createdBy
            ? {
                v1UserId: challan.createdBy,
                username: context.users.get(challan.createdBy) ?? null,
              }
            : null,
        },
      );
    });
  } catch (error) {
    run.except('delivery_challan', challan.id, 'database-guard', guardMessage(error));
    return null;
  }

  run.count('delivery_challan').imported += 1;
  run.count('delivery_challan_item').imported += importedLines;
  run.provenance.set(provenanceKey('delivery_challan', challan.id), {
    targetId,
    fingerprint,
  });
  run.serialsImported += importedSerials;
  run.count('challan_item_serial').imported += importedSerials;
  for (const plan of linePlans) {
    pushSerialExceptions(
      run,
      workTarget.workCode,
      plan.line.id,
      serialPlan.get(plan.line.id) ?? [],
    );
  }
  return settings.kind === 'issued' ? prepared.sequence : null;
}

/** A draft imported from a pending row still needs a prefix (NOT NULL);
 * when its own number could not be parsed the prefix derives from the
 * Work code — the number itself is never minted here. */
function deriveFallbackPrefix(workCode: string): string {
  const candidate = `${workCode}-DC`.toUpperCase();
  return candidate.length <= 25 ? candidate : 'DC';
}

function guardMessage(error: unknown): string {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    return withCode.code !== undefined
      ? `${withCode.code}: ${error.message}`
      : error.message;
  }
  return String(error);
}
