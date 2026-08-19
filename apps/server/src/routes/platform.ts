import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  EntitlementListResponseSchema,
  EntitlementResponseSchema,
  JobScheduleListResponseSchema,
  JobScheduleResponseSchema,
  OrganisationExportListResponseSchema,
  OrganisationExportResponseSchema,
  SetEntitlementRequestSchema,
  UpdateJobScheduleRequestSchema,
  type Entitlement,
  type ErrorCode,
  type JobRun,
  type JobSchedule,
  type OrganisationExport,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { FastifyBaseLogger } from 'fastify';
import type { ObjectStorage } from '@auto-mb/documents';
import { Type } from '@sinclair/typebox';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import { ENTITLEMENT_FLAGS } from '../entitlements.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { withBoundTenantSnapshot } from '../tenant-context.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { EXPORT_FORMAT_VERSION, writeExportPackage } from './export.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';

/**
 * The platform controls (migration 0096): which modules this organisation
 * may use, which recurring statutory checks run, and the organisation's
 * own copy of itself.
 *
 * ## Permissions, and why two authorities rather than one
 *
 * Entitlements and schedules carry `role: 'owner'` AND
 * `authority: 'entitlements'` together — 0091's kiosk layering, where the
 * authority gates the doing and the owner role gates who may do it at
 * all. Switching a module off changes what every member of the
 * organisation can reach, so it is not a thing to delegate.
 *
 * The export carries `authority: 'export'` and NOT the owner role,
 * deliberately: an owner who wants their accountant to pull the annual
 * package should not have to hand over the organisation to do it. The
 * synchronous `GET /api/export` stays owner-only and untouched.
 *
 * ## What the download route deliberately is not
 *
 * There is no token, no signed URL and no unbound route. The bundle is
 * every contract, price, payslip and bank detail the organisation holds,
 * so a link that works without a session is a copy of the whole business
 * with a longer half-life than the decision to make it — and the one
 * property a token cannot have is "revoked the moment the membership is".
 * The download is an ordinary session-authenticated, tenant-bound route
 * behind `can_export_org`; the row id in the path is not a secret,
 * because RLS scopes it to one organisation and the authority scopes it
 * to the members who may export. The expiry is enforced twice — here, and
 * by the worker sweep that deletes the bytes.
 *
 * ## The build runs HERE, not in the worker, and that is argued
 *
 * `writeExportPackage` must hold ONE REPEATABLE READ transaction open
 * across around sixty sequential reads or the package comes out
 * referentially broken, and it streams so that no table is ever fully
 * resident. The worker's execution model refuses both: `runtime.ts` hands
 * a handler a transaction CLOSURE precisely so that a slow job does not
 * pin a pooled connection, and `ObjectStorage.put` takes a Buffer, so a
 * worker-side build would have to buffer a whole organisation in memory
 * to hand it over — undoing the streaming at the last step.
 *
 * So the build is an in-process background task on the same snapshot
 * shape `GET /api/export` already uses, and the queue owns the part it is
 * uniquely good at: the recurring sweep that reconciles a build whose
 * process died and deletes the bytes of a lapsed artefact.
 *
 * ponytail: in-process build, no retry. A build interrupted by a restart
 * is reconciled to `failed` by the sweep and the operator asks again. If
 * exports ever need retry or progress, the upgrade is a queue kind plus a
 * streaming `putStream` on the worker side — `packages/documents` already
 * has the second half.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0096 raises with SQLSTATEs from the 23N block, one per rule,
 * so a guard that fires because the route's own check lost a race surfaces
 * as the same 409 an operator would have got from the route — not as an
 * unexplained 500.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  // The partial unique index on (organisation_id) WHERE state IN
  // ('queued','running'). The route pre-checks the same rule for the
  // friendlier message; this is the arm that holds when two requests both
  // read "nothing in flight" before either inserted.
  '23505': [
    'EXPORT_IN_PROGRESS',
    'An export of this organisation is already being built; wait for it to finish before asking for another.',
  ],
  '23N01': [
    'EXPORT_STATE',
    'The export moved on while this was being recorded; reload the list and try again.',
  ],
  '23N02': [
    'EXPORT_STATE',
    'The recorded facts of a built export cannot be changed; request a new export instead.',
  ],
  '23N03': [
    'JOB_SCHEDULE_STATE',
    'A schedule cannot be repointed at a different check; switch this one off and configure the other.',
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
 * How long a built artefact stays downloadable.
 *
 * Seven days, and the number is operational rather than round: an export
 * is usually taken for an accountant, a lender or a due-diligence request,
 * and those move at the pace of a working week. Long enough that a
 * Friday-afternoon export is still there on Monday; short enough that a
 * complete copy of the business is not sitting in object storage a month
 * after anybody remembered making it.
 */
const EXPORT_RETENTION_HOURS = 24 * 7;

/** The declared recurring checks. Prose lives here rather than in the
 * database because it is copy, and copy that changes with the product
 * should not need a migration. */
const SCHEDULE_DEFINITIONS = [
  {
    kind: 'instrument_expiry_review',
    label: 'Guarantee and certificate expiry',
    description:
      'Reports the performance guarantees and PAC certificates whose expiry falls inside the horizon. A lapsed PBG is a contract breach and no bank renews one retrospectively.',
    defaultCadence: 'weekly',
    defaultHorizonDays: 45,
  },
] as const;

interface EntitlementRow {
  readonly flag_key: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly set_by_user_id: string;
  readonly updated_at: Date;
}

interface ScheduleRow {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly cadence: string;
  readonly horizon_days: number;
  readonly next_run_at: Date;
  readonly last_run_at: Date | null;
  readonly authority_user_id: string;
  readonly disabled_reason: string | null;
}

interface ExportRow {
  readonly id: string;
  readonly state: string;
  readonly requested_by_user_id: string;
  readonly requested_at: Date;
  readonly completed_at: Date | null;
  readonly format_version: string | null;
  readonly object_key: string | null;
  readonly byte_size: string | null;
  readonly sha256: string | null;
  readonly expires_at: Date | null;
  readonly failure_reason: string | null;
  readonly download_count: number;
}

function toExport(row: ExportRow): OrganisationExport {
  return {
    id: row.id,
    state: row.state as OrganisationExport['state'],
    requestedBy: row.requested_by_user_id,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    formatVersion: row.format_version,
    // postgres.js hands a bigint back as a decimal string, which is what
    // the wire wants anyway — see the schema's note.
    byteSize: row.byte_size,
    sha256: row.sha256,
    expiresAt: row.expires_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
    downloadCount: row.download_count,
  };
}

const EXPORT_COLUMNS = `id, state, requested_by_user_id, requested_at,
  completed_at, format_version, object_key, byte_size, sha256, expires_at,
  failure_reason, download_count`;

export function registerPlatformRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- entitlements ------------------------------------------------------ */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/platform/entitlements',
      schema: { response: { 200: EntitlementListResponseSchema, ...errorResponses } },
      role: 'owner',
      authority: 'entitlements',
    },
    async ({ tenant }) =>
      tenant(async (tx) => ({ entitlements: await readEntitlements(tx) })),
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/platform/entitlements/:key',
      schema: {
        params: Type.Object(
          {
            key: Type.Union(ENTITLEMENT_FLAGS.map((flag) => Type.Literal(flag.key))),
          },
          { additionalProperties: false },
        ),
        body: SetEntitlementRequestSchema,
        response: { 200: EntitlementResponseSchema, ...errorResponses },
      },
      role: 'owner',
      authority: 'entitlements',
    },
    async ({ request, organisationId, user, tenant }) => {
      const { key } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Upsert on (organisation_id, flag_key): a flag has one answer per
        // organisation and the screen offers a switch, not a history.
        // AN ABSENT `note` KEEPS THE EXISTING ONE; an explicit `null`
        // clears it. The contract says so, and the reason is this table's
        // own argument for having the column: "off" without "waiting on
        // NIC re-certification" is a fact nobody can act on six months
        // later, and a screen that only sends `{ enabled }` when somebody
        // flips a switch would erase exactly that on the first toggle.
        await tx`
          insert into organisation_entitlements (
            organisation_id, flag_key, enabled, note, set_by_user_id
          )
          values (
            ${organisationId}, ${key}, ${body.enabled},
            ${body.note ?? null}, ${user.id}
          )
          on conflict (organisation_id, flag_key) do update
            set enabled = excluded.enabled,
                note = case
                  when ${body.note === undefined} then organisation_entitlements.note
                  else excluded.note
                end,
                set_by_user_id = excluded.set_by_user_id
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'entitlement.set',
          'organisation_entitlements',
          null,
          { flagKey: key, enabled: body.enabled },
        );
        const entitlements = await readEntitlements(tx);
        const changed = entitlements.find((candidate) => candidate.key === key);
        // Unreachable rather than defensive: the params schema admits only
        // declared keys and `readEntitlements` maps over the same
        // declaration, so a miss here is a broken invariant and not a
        // refusal an operator could act on. A plain Error keeps it out of
        // the refusal vocabulary, where a code nothing can really raise
        // would need a remedy nobody could write.
        /* c8 ignore next 3 */
        if (changed === undefined) {
          throw new Error(`entitlement ${key} is declared but was not read back`);
        }
        return { entitlement: changed };
      });
    },
  );

  /* --- recurring statutory checks ---------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/platform/job-schedules',
      schema: { response: { 200: JobScheduleListResponseSchema, ...errorResponses } },
      role: 'owner',
      authority: 'entitlements',
    },
    async ({ tenant }) =>
      tenant(async (tx) => ({
        schedules: await readSchedules(tx),
        runs: await readRuns(tx),
      })),
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/platform/job-schedules/:kind',
      schema: {
        params: Type.Object(
          {
            kind: Type.Union(
              SCHEDULE_DEFINITIONS.map((definition) => Type.Literal(definition.kind)),
            ),
          },
          { additionalProperties: false },
        ),
        body: UpdateJobScheduleRequestSchema,
        response: { 200: JobScheduleResponseSchema, ...errorResponses },
      },
      role: 'owner',
      authority: 'entitlements',
    },
    async ({ request, organisationId, user, tenant }) => {
      const { kind } = request.params;
      const body = request.body;
      const definition = SCHEDULE_DEFINITIONS.find(
        (candidate) => candidate.kind === kind,
      );
      /* c8 ignore next -- the params schema admits only declared kinds */
      if (definition === undefined) throw scheduleNotFound();
      return tenant(async (tx) => {
        // FULL WORK SCOPE, for the reason the export carries the same
        // test: the check reads every Work's instruments and puts what it
        // found on a screen. A member who sees only their assigned Works
        // must not be able to adopt a schedule whose outcome then reports
        // on all of them. The export precedent is the same shape and the
        // same refusal code.
        await requireFullWorkScope(tx, user.id, SCHEDULE_SCOPE_REFUSAL);

        // The authority is RE-STAMPED on every write, and that is the whole
        // remedy for a schedule whose member has left: the queue parks its
        // run in `refused_bind`, the scheduler pauses the schedule with a
        // stated reason, and a current member re-adopting it puts their own
        // membership behind it. `disabled_reason` clears here for the same
        // reason — it describes a state this write has just ended.
        await tx`
          insert into statutory_job_schedules (
            organisation_id, kind, enabled, cadence, horizon_days,
            authority_user_id
          )
          values (
            ${organisationId}, ${kind}, ${body.enabled ?? true},
            ${body.cadence ?? definition.defaultCadence},
            ${body.horizonDays ?? definition.defaultHorizonDays},
            ${user.id}
          )
          on conflict (organisation_id, kind) do update
            set enabled = coalesce(${body.enabled ?? null}, statutory_job_schedules.enabled),
                cadence = coalesce(${body.cadence ?? null}, statutory_job_schedules.cadence),
                horizon_days = coalesce(
                  ${body.horizonDays ?? null}, statutory_job_schedules.horizon_days
                ),
                authority_user_id = excluded.authority_user_id,
                disabled_reason = null,
                -- A schedule coming back from a pause starts its cadence
                -- again rather than firing on the next tick because its
                -- next run instant is months in the past. Only on
                -- re-enable: an operator changing the horizon of a
                -- running check must not silently postpone it.
                next_run_at = case
                  when ${body.enabled ?? true} and not statutory_job_schedules.enabled
                    then now()
                  else statutory_job_schedules.next_run_at
                end
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'job_schedule.set',
          'statutory_job_schedules',
          null,
          { kind, enabled: body.enabled ?? true },
        );
        const schedules = await readSchedules(tx);
        const changed = schedules.find((candidate) => candidate.kind === kind);
        /* c8 ignore next -- the upsert above guarantees the row exists */
        if (changed === undefined) throw scheduleNotFound();
        return { schedule: changed };
      });
    },
  );

  /* --- the organisation's own copy of itself ----------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/platform/exports',
      schema: {
        response: { 200: OrganisationExportListResponseSchema, ...errorResponses },
      },
      authority: 'export',
    },
    async ({ user, tenant }) =>
      tenant(async (tx) => {
        // The same wall the request and the download carry. The list is
        // metadata rather than the package, but it names who took a copy
        // of the whole organisation and when — and SECURITY.md states the
        // export surface as a whole is behind full Work scope, so the one
        // route without it would be the one that made that untrue.
        await requireFullWorkScope(tx, user.id);

        const rows = await tx<ExportRow[]>`
          select ${tx.unsafe(EXPORT_COLUMNS)} from organisation_export_requests
          order by requested_at desc, id desc
          limit 50
        `;
        return {
          exports: rows.map(toExport),
          retentionHours: EXPORT_RETENTION_HOURS,
        };
      }),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/platform/exports',
      schema: {
        response: { 202: OrganisationExportResponseSchema, ...errorResponses },
      },
      authority: 'export',
    },
    async ({ request, reply, organisationId, user, tenant }) => {
      const accepted = await tenant(async (tx) => {
        await requireFullWorkScope(tx, user.id);

        // One build at a time. Two concurrent snapshots over sixty tables
        // is a real cost for an operator who clicked twice, and the second
        // package would be indistinguishable from the first.
        //
        // This read is the FRIENDLY arm, not the enforcing one: two
        // requests can both pass it before either inserts. The partial
        // unique index in 0096 is what actually holds, and its 23505 maps
        // to the same refusal above — so the loser of a real race reads
        // the same sentence as the operator who was simply too early.
        const [inFlight] = await tx<{ id: string }[]>`
          select id from organisation_export_requests
          where state in ('queued', 'running')
          limit 1
        `;
        if (inFlight !== undefined) {
          throw httpError(
            409,
            'EXPORT_IN_PROGRESS',
            'An export of this organisation is already being built; wait for it to finish before asking for another.',
          );
        }

        const [row] = await tx<ExportRow[]>`
          insert into organisation_export_requests (
            organisation_id, requested_by_user_id
          )
          values (${organisationId}, ${user.id})
          returning ${tx.unsafe(EXPORT_COLUMNS)}
        `.catch(rethrowWriteRefusal);
        /* c8 ignore next -- an insert with returning either throws or returns */
        if (row === undefined) throw exportNotFound();
        return toExport(row);
      });

      // Started AFTER the request transaction committed, so the build's own
      // snapshot can see the row it is building for.
      void buildExport(
        database,
        storage,
        request.log,
        organisationId,
        user.id,
        accepted.id,
      );

      reply.code(202);
      return { export: accepted };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/platform/exports/:id/download',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Unknown(), ...errorResponses },
      },
      authority: 'export',
    },
    async ({ request, reply, organisationId, user, tenant }) => {
      // The ORDER of the three phases below is the point, and it is not
      // the obvious one.
      //
      //   1. read the row and refuse everything refusable, WITHOUT writing;
      //   2. OPEN the bytes;
      //   3. only then record the download and its audit event.
      //
      // The obvious order — count, audit, then fetch — records a
      // disclosure that never happened whenever the artefact is reclaimed
      // in the window between the two, and answers the operator with an
      // ENOENT 500 instead of a refusal they can act on. Opening first
      // makes a reclaimed artefact an ordinary EXPORT_EXPIRED.
      const artefact = await tenant(async (tx) => {
        // The SAME work-scope test the request carries, and it has to be
        // here too rather than only there: the artefact is one file for
        // the whole organisation, so a member who may not see every Work
        // must not be able to fetch one somebody else built. Enforcing it
        // only at request time would leave the download as the way round
        // it.
        await requireFullWorkScope(tx, user.id);

        const [row] = await tx<ExportRow[]>`
          select ${tx.unsafe(EXPORT_COLUMNS)} from organisation_export_requests
          where id = ${request.params.id}
        `;
        // 404 rather than 403 for a row this organisation does not have:
        // RLS has already hidden another tenant's, and a guessed id must
        // not tell the caller whether it exists somewhere else.
        if (row === undefined) throw exportNotFound();
        if (row.state === 'expired' || row.object_key === null) {
          throw httpError(
            409,
            'EXPORT_EXPIRED',
            'This export has expired and its file has been deleted. Request a new one.',
          );
        }
        if (row.state !== 'ready') {
          throw httpError(
            409,
            'EXPORT_NOT_READY',
            row.state === 'failed'
              ? 'This export did not finish. Request a new one.'
              : 'This export is still being built. Reload in a moment.',
          );
        }
        // The expiry, enforced here as well as by the sweep. The sweep runs
        // on the worker's tick, so between the instant an artefact lapses
        // and the instant the sweep reaches it there is a window in which
        // the bytes are still on disk — and this check is what makes that
        // window unreachable rather than merely short.
        if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
          throw httpError(
            409,
            'EXPORT_EXPIRED',
            'This export has expired. Request a new one.',
          );
        }
        return row;
      });

      /* c8 ignore next -- narrowed by the ready check above */
      if (artefact.object_key === null) throw exportNotFound();
      // STREAMED, not buffered. The package is built by streaming sixty
      // tables through a cursor so no table is ever fully resident;
      // reading it back into a Buffer would undo that at the last step,
      // once per concurrent download.
      const key = artefact.object_key;
      const artefactStream = await storage.getStream(key).catch(() => undefined);
      if (artefactStream === undefined) {
        // Reclaimed between the read above and this open. The row still
        // says `ready`, so the honest answer is the one the sweep would
        // have given a moment later rather than a 500 about a file.
        throw httpError(
          409,
          'EXPORT_EXPIRED',
          'This export is no longer available. Request a new one.',
        );
      }

      await tenant(async (tx) => {
        await tx`
          update organisation_export_requests
             set download_count = download_count + 1,
                 last_downloaded_at = now()
           where id = ${artefact.id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'organisation.export_downloaded',
          'organisation_export_requests',
          artefact.id,
          { sha256: artefact.sha256 },
        );
      });

      void reply.type('application/json; charset=utf-8');
      void reply.header('content-length', String(artefactStream.size));
      void reply.header(
        'content-disposition',
        `attachment; filename="auto-mb-export-${artefact.id}.json"`,
      );
      return reply.send(artefactStream.stream);
    },
  );
}

/* --- reads shared by several routes ---------------------------------------- */

async function readEntitlements(tx: TransactionSql): Promise<Entitlement[]> {
  const rows = await tx<EntitlementRow[]>`
    select flag_key, enabled, note, set_by_user_id, updated_at
    from organisation_entitlements
  `;
  const configured = new Map(rows.map((row) => [row.flag_key, row]));
  // Driven by the DECLARED flags, not by the rows: a flag with no row is
  // the normal state and the screen has to show it with its default rather
  // than not at all.
  return ENTITLEMENT_FLAGS.map((flag) => {
    const row = configured.get(flag.key);
    return {
      key: flag.key,
      label: flag.label,
      description: flag.description,
      enabled: row?.enabled ?? flag.default,
      defaultEnabled: flag.default,
      configured: row !== undefined,
      note: row?.note ?? null,
      setBy: row?.set_by_user_id ?? null,
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  });
}

async function readSchedules(tx: TransactionSql): Promise<JobSchedule[]> {
  const rows = await tx<ScheduleRow[]>`
    select id, kind, enabled, cadence, horizon_days, next_run_at,
           last_run_at, authority_user_id, disabled_reason
    from statutory_job_schedules
  `;
  const configured = new Map(rows.map((row) => [row.kind, row]));
  return SCHEDULE_DEFINITIONS.flatMap((definition) => {
    const row = configured.get(definition.kind);
    // A check that has never been configured has no row and therefore no
    // id, so it cannot be rendered as a schedule. The screen offers it as
    // an unconfigured definition instead; saving one creates the row.
    if (row === undefined) return [];
    return [
      {
        id: row.id,
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        enabled: row.enabled,
        cadence: row.cadence as JobSchedule['cadence'],
        horizonDays: row.horizon_days,
        nextRunAt: row.next_run_at.toISOString(),
        lastEnqueuedAt: row.last_run_at?.toISOString() ?? null,
        authorityUserId: row.authority_user_id,
        disabledReason: row.disabled_reason,
      },
    ];
  });
}

interface RunRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly created_at: Date;
  readonly finished_at: Date | null;
  readonly outcome: unknown;
  readonly last_error: string | null;
}

async function readRuns(tx: TransactionSql): Promise<JobRun[]> {
  // Through the definer function, because the application role holds no
  // privilege on `worker_jobs` at all (0072). It takes no organisation: it
  // reads the binding this transaction already proved.
  const rows = await tx<RunRow[]>`
    select * from app_private.organisation_job_history(25)
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as JobRun['kind'],
    state: row.state as JobRun['state'],
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    outcome: parseJsonbColumn(row.outcome) as Record<string, unknown> | null,
    lastError: row.last_error,
  }));
}

/**
 * The test the export authority cannot express.
 *
 * The package is not work-scoped: RLS scopes it to the organisation and
 * nothing filters it to assignments, so an assigned-scope member holding
 * `can_export_org` would receive every Work the product hides from them.
 * Refused by name rather than by silently exporting less, because a
 * partial package that calls itself the whole record is the worse
 * failure.
 *
 * Applied on BOTH the request and the download. One artefact serves the
 * whole organisation, so a check only at request time would leave the
 * download as the way round it.
 */
const SCHEDULE_SCOPE_REFUSAL =
  'A recurring check reports on every Work, so only a member who sees every Work may adopt one. Ask an owner for full Work access.';

async function requireFullWorkScope(
  tx: TransactionSql,
  userId: string,
  message = 'A whole-organisation export is only for a member who sees every Work. Ask an owner for full Work access, or for the export itself.',
): Promise<void> {
  if (await hasFullWorkScope(tx, userId)) return;
  throw httpError(403, 'EXPORT_SCOPE_REQUIRED', message);
}

function exportNotFound(): Error {
  return httpError(404, 'EXPORT_NOT_FOUND', 'No such export.');
}

function scheduleNotFound(): Error {
  return httpError(404, 'JOB_SCHEDULE_NOT_FOUND', 'No such recurring check.');
}

/* --- the background build -------------------------------------------------- */

/**
 * Builds one artefact, then records what it built.
 *
 * Two transactions and a storage write between them, in that order, and
 * the order is what makes every failure recoverable:
 *
 *   1. mark `running`, and stop if somebody else already did — the same
 *      row is the lock, so a duplicated call cannot produce two files;
 *   2. hold ONE repeatable-read snapshot open, stream the package into
 *      object storage, hashing as it goes;
 *   3. mark `ready` with the key, the size and the digest.
 *
 * A crash before (3) leaves a `running` row and an orphan file. The row is
 * reconciled to `failed` by the worker sweep and the file is inert — its
 * key is on no row, so nothing can fetch it. The reverse order, recording
 * before writing, would leave a `ready` row pointing at nothing.
 *
 * Nothing here throws to a caller: it is started with `void` after the
 * request has already answered 202, so a failure has to land in the row
 * rather than in an unhandled rejection.
 */
async function buildExport(
  database: Sql,
  storage: ObjectStorage,
  log: FastifyBaseLogger,
  organisationId: string,
  userId: string,
  exportId: string,
): Promise<void> {
  const objectKey = `${organisationId}/exports/${randomUUID()}.json`;
  try {
    const started = await withBoundTenantSnapshot(
      database,
      organisationId,
      userId,
      async (tx) => {
        const rows = await tx`
          update organisation_export_requests
             set state = 'running', started_at = now()
           where id = ${exportId} and state = 'queued'
          returning id
        `;
        return rows.length === 1;
      },
    );
    if (!started) return;

    const digest = createHash('sha256');
    const byteSize = await withBoundTenantSnapshot(
      database,
      organisationId,
      userId,
      async (tx) => {
        const stream = new PassThrough();
        const written = storage.putStream(objectKey, stream);
        try {
          await writeExportPackage(tx, organisationId, userId, async (chunk) => {
            digest.update(chunk, 'utf8');
            if (!stream.write(chunk)) {
              await new Promise<void>((resolve) => stream.once('drain', resolve));
            }
          });
          stream.end();
        } catch (error) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
          await written.catch(() => undefined);
          throw error;
        }
        return written;
      },
    );

    await withBoundTenantSnapshot(database, organisationId, userId, async (tx) => {
      await tx`
        update organisation_export_requests
           set state = 'ready',
               completed_at = now(),
               object_key = ${objectKey},
               byte_size = ${byteSize},
               sha256 = ${digest.digest('hex')},
               format_version = ${EXPORT_FORMAT_VERSION},
               expires_at = now() + make_interval(hours => ${EXPORT_RETENTION_HOURS})
         where id = ${exportId} and state = 'running'
      `;
    });
  } catch (error) {
    // OPERATOR-FACING SENTENCE FIRST, internal detail after, and never
    // empty. The column's CHECK demands at least one character, so an
    // `Error('')` — which a broken stream or an aborted socket really does
    // produce — would make this very UPDATE throw, the catch below would
    // swallow it, and the row would sit in `running` for ever. The fixed
    // prefix also means the screen shows a sentence rather than raw
    // internals; the detail is kept because an operator reporting a
    // failure has nothing else to quote.
    const detail = error instanceof Error ? error.message.trim() : String(error).trim();
    const reason = `The build did not finish.${detail === '' ? '' : ` ${detail}`}`;
    await withBoundTenantSnapshot(database, organisationId, userId, async (tx) => {
      await tx`
        update organisation_export_requests
           set state = 'failed',
               completed_at = now(),
               failure_reason = ${reason.slice(0, 500)}
         where id = ${exportId} and state in ('queued', 'running')
      `;
    }).catch((cause: unknown) => {
      // NOT swallowed. If the row could not be marked failed, the stall
      // sweep will reconcile it within the hour — but a build that failed
      // AND could not say so is the pair of faults an operator has to see
      // together, and this is the only place both are known.
      log.error(
        { exportId, organisationId, err: cause },
        'the export failed and its row could not be marked failed; the stall sweep will reconcile it',
      );
    });
    // Best effort, and deliberately unguarded by a state check: the bytes
    // belong to a row that will never point at them.
    await storage.remove(objectKey).catch(() => undefined);
  }
}
