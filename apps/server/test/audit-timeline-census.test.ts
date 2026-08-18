import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIMELINE_ENTITY_TYPES } from '@auto-mb/contracts';

/**
 * The standing check behind the received-railway-bill timeline repair.
 *
 * Pack P14 shipped a new document kind whose audit events were written
 * faithfully and shown nowhere: `received_railway_bills` was not in
 * `TIMELINE_ENTITY_TYPES`, so recording, discarding, or closing against
 * a railway bill left no trace on any operator-reachable screen. Pack
 * P15's `bill_payments` had the identical gap. Fixing each instance is
 * not the deliverable; the deliverable is that the NEXT document kind
 * cannot repeat it silently, which is what this census is.
 *
 * It scans the server's own source for every audit_events write —
 * the shared `audit()` helper, corrections-apply's local twin, and the
 * inline multi-row inserts — extracts the entity type each one records,
 * and holds the set against `TIMELINE_ENTITY_TYPES` plus the documented
 * exceptions below. A new entity type that joins neither list fails the
 * build, and joining the exception list means writing down why here.
 *
 * The scan is textual and deliberately simple, the same posture as
 * `query-write-loop-census.test.ts`: a cheap check that is honest about
 * being cheap beats a perfect one that does not exist. It relies on the
 * convention — held everywhere today — that the entity type at a write
 * site is a string literal; the few dynamic sites are frozen below and
 * a new one fails the census rather than slipping past it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = path.resolve(here, '..', 'src');

/**
 * Entity types that are written to audit_events but deliberately absent
 * from the Work timeline, each with the reason. Two families:
 *
 * - organisation-level facts with no single Work to hang them on; their
 *   trail belongs to Milestone 9's organisation-wide audit search, not
 *   to a Work's timeline;
 * - Work-linked document kinds recorded BEFORE the timeline learned to
 *   demand coverage — the same gap this census exists to stop. Each is
 *   a known hole, not an endorsement: promoting one means a whitelist
 *   entry, a scoping arm in routes/timeline.ts, web labels, and tests,
 *   exactly as `received_railway_bills` got.
 */
const NON_TIMELINE: Record<string, string> = {
  organisations: 'Organisation-level: the organisation itself, no Work.',
  organisation_memberships: 'Organisation-level: who belongs, not what a Work did.',
  work_assignments:
    'Access administration: who may see a Work is an identity fact, kept off the Work’s own paper trail.',
  contacts: 'Organisation-level master data.',
  unit_masters: 'Organisation-level master data.',
  location_masters: 'Organisation-level master data.',
  gst_rates: 'Organisation-level master data (notified rate history).',
  organisation_signatories: 'Organisation-level master data.',
  canonical_items: 'Organisation-level master data (the item catalogue).',
  production_items:
    'Organisation-level master data (0084): the OEM item master describes what the factory can build, not anything one Work did.',
  production_bom_lines:
    'Organisation-level master data (0084): a bill of material is a product design, and it outlives every Work built against it.',
  production_serials:
    'Deliberately off the Work timeline (0084): a job card for five hundred boards would put five hundred rows on the Work’s history. The card itself IS on the timeline (production_job_cards), and a unit is read on the card.',
  production_component_serials:
    'Deliberately off the Work timeline (0084): one row per component per unit, for the same flooding reason as production_serials. The genealogy is read on the unit.',
  production_dispatches:
    'Deliberately off the Work timeline (0084): a release from the factory floor is an internal handoff to stock, not an act on the contract. The Work’s trail picks the units up again at the Delivery Challan.',
  stock_movements:
    'Organisation-level (0087): one shelf serves every contract, so a movement is not a fact about a Work even when it names one. The ledger is its own trail, read on the part.',
  signing_agents:
    'Organisation-level (0091): a kiosk credential belongs to the company and outlives every Work it signs for. What it did to a Work IS on the timeline, as signing_requests.',
  organisation_bank_accounts:
    'Organisation-level: the company’s own accounts, not anything a Work did.',
  document_number_series: 'Organisation-level numbering configuration.',
  company_documents:
    'Organisation-level master data (0079): a reusable credential belongs to the company, not to any Work, so it has no Work timeline to join.',
  tenders:
    'Organisation-level (0083): a tender is pre-award, so there is no Work to hang it on — the Work is what winning it produces. Its own trail is tender_status_events, read on the tender.',
  tender_notices:
    'Organisation-level (0083): the NIT arrives months before any Work exists.',
  import_batches: 'The v1 import CLI’s own batch bookkeeping, org-level.',
  loa_documents:
    'KNOWN GAP (pre-timeline): contract-source uploads are Work-linked but never joined the timeline.',
  extension_requests:
    'KNOWN GAP (pre-timeline): completion extensions are Work-linked but never joined the timeline.',
  purchase_orders:
    'KNOWN GAP (pre-timeline): procurement is Work-linked but never joined the timeline.',
  budgetary_quotations:
    'KNOWN GAP (pre-timeline): procurement is Work-linked but never joined the timeline.',
  tax_invoices:
    'KNOWN GAP (pre-timeline): invoicing is Work-linked but never joined the timeline.',
  credit_notes:
    'KNOWN GAP (pre-timeline): invoicing is Work-linked but never joined the timeline.',
  eway_bills:
    'KNOWN GAP (pre-timeline): e-way bills hang off tax invoices, which are themselves a gap.',
  payment_request:
    'Outbound money (0080): an employee advance or reimbursement is a claim by a PERSON, and its Work link is optional attribution rather than an event in the Work’s execution. A Work’s timeline answers what happened to the contract; who was reimbursed for travel is not that.',
  vendor_invoice:
    'Outbound money (0080): what a vendor billed this organisation. Organisation-level by nature — the optional Work link is cost attribution, not a contract event, on the same reasoning as payment_request above.',
  vendor_payment:
    'Outbound money (0080): a payment against a vendor invoice, which is itself off the timeline.',
};

/**
 * Write sites the literal scan cannot read, frozen by exact location
 * family. Three are helper DEFINITIONS whose entity type is a parameter
 * (their callers are scanned as call sites); one drives a registry whose
 * `entityType:` properties the scan reads directly. A new dynamic site
 * fails here and earns either a rewrite to a literal or an entry with a
 * reason.
 */
const DYNAMIC_SITES: Record<
  string,
  { readonly sites: number; readonly reason: string }
> = {
  'routes/shared.ts': {
    sites: 2,
    reason: 'The shared audit() helper definition and its parameterised insert.',
  },
  'corrections-apply.ts': {
    sites: 2,
    reason: 'The module’s local audit helper definition and its parameterised insert.',
  },
  'routes/masters.ts': {
    sites: 1,
    reason:
      'The master-data route factory passes options.entityType; the registry’s `entityType:` literals are collected by the property scan.',
  },
};

/** Every place a row can enter audit_events: a call to an audit helper,
 * or an inline INSERT. */
const WRITE_SITE = /\baudit\(|insert into audit_events/g;

/** Pass 1 — the convention: an action literal (always dotted, e.g.
 * 'received_railway_bill.recorded') immediately followed by the entity
 * type literal. Precise, because the dot rules out other adjacent string
 * pairs. */
const LITERAL_PAIR = /'[a-z_][a-z_.-]*\.[a-z_.-]+'\s*,\s*'([a-z_]+)'\s*,/;

/** Pass 2, only for sites pass 1 missed: the action is an identifier
 * (`approvedAction`) or a template literal (`` `bill.${body.status}` ``),
 * still followed by the entity type literal. Looser, so it never runs on
 * a site the strict pattern already read. */
const DYNAMIC_ACTION_PAIR =
  /(?:`[^`\n]*\$\{[^`\n]*\}[^`\n]*`|[A-Za-z_$][\w$]*)\s*,\s*\n?\s*'([a-z_]+)'\s*,/;

/** The masters route registry hands `entityType:` values to the factory
 * above; read them where they are declared. Scoped to that one file —
 * `entityType:` properties elsewhere (the importer's exception records)
 * are not audit writes. */
const REGISTRY_PROPERTY = /entityType: '([a-z_]+)'/g;
const REGISTRY_FILE = 'routes/masters.ts';

/** How much source after a write site the pair may span. The widest real
 * site (an inline insert with its column list) fits well within this. */
const WINDOW = 700;

interface Census {
  readonly entityTypes: ReadonlyMap<string, readonly string[]>;
  readonly unreadableSites: ReadonlyMap<string, number>;
}

async function runCensus(): Promise<Census> {
  const entityTypes = new Map<string, string[]>();
  const unreadableSites = new Map<string, number>();
  const record = (entity: string, site: string): void => {
    entityTypes.set(entity, [...(entityTypes.get(entity) ?? []), site]);
  };

  for await (const match of glob('**/*.ts', { cwd: serverSource })) {
    const relative = match.split(path.sep).join('/');
    const source = await readFile(path.join(serverSource, match), 'utf8');

    WRITE_SITE.lastIndex = 0;
    let site: RegExpExecArray | null;
    while ((site = WRITE_SITE.exec(source)) !== null) {
      const window = source.slice(site.index, site.index + WINDOW);
      const line = source.slice(0, site.index).split('\n').length;
      const pair = LITERAL_PAIR.exec(window) ?? DYNAMIC_ACTION_PAIR.exec(window);
      if (pair?.[1] === undefined) {
        unreadableSites.set(relative, (unreadableSites.get(relative) ?? 0) + 1);
      } else {
        record(pair[1], `${relative}:${String(line)}`);
      }
    }

    if (relative === REGISTRY_FILE) {
      REGISTRY_PROPERTY.lastIndex = 0;
      let property: RegExpExecArray | null;
      while ((property = REGISTRY_PROPERTY.exec(source)) !== null) {
        if (property[1] !== undefined) record(property[1], `${relative} (registry)`);
      }
    }
  }
  return { entityTypes, unreadableSites };
}

describe('audit-events timeline census', () => {
  it('every audited entity type is on the timeline or documented off it', async () => {
    const { entityTypes, unreadableSites } = await runCensus();

    // The scan itself must stay able to read the source: a write site
    // neither regex can parse is a hole in the census, not a pass.
    const unexpectedDynamic = [...unreadableSites.entries()]
      .filter(([file, count]) => (DYNAMIC_SITES[file]?.sites ?? 0) !== count)
      .map(([file, count]) => `${file}: ${String(count)} unreadable write site(s)`);
    expect(unexpectedDynamic, unexpectedDynamic.join('\n')).toEqual([]);
    const vanishedDynamic = Object.keys(DYNAMIC_SITES).filter(
      (file) => !unreadableSites.has(file),
    );
    expect(
      vanishedDynamic,
      'frozen dynamic sites no longer exist — prune the table',
    ).toEqual([]);

    // The point: nothing writes an entity type the timeline has never
    // heard of. A failure here is pack P14's bug about to happen again —
    // either whitelist the new type (contract entry, scoping arm in
    // routes/timeline.ts, web labels, tests) or document why its events
    // do not belong on a Work's timeline.
    const timeline = new Set<string>(TIMELINE_ENTITY_TYPES);
    const undocumented = [...entityTypes.entries()]
      .filter(([entity]) => !timeline.has(entity) && NON_TIMELINE[entity] === undefined)
      .map(([entity, sites]) => `${entity} (written at ${sites.join(', ')})`);
    expect(undocumented, undocumented.join('\n')).toEqual([]);

    // Keep both lists honest: an exception for a type the timeline now
    // covers is stale, and a whitelist entry nothing writes any more is
    // a rename that silently emptied part of the timeline.
    const staleExceptions = Object.keys(NON_TIMELINE).filter(
      (entity) => timeline.has(entity) || !entityTypes.has(entity),
    );
    expect(staleExceptions, 'stale NON_TIMELINE entries — prune them').toEqual([]);
    const unwritten = TIMELINE_ENTITY_TYPES.filter(
      (entity) => !entityTypes.has(entity),
    );
    expect(unwritten, 'whitelisted entity types nothing writes').toEqual([]);
  });
});
