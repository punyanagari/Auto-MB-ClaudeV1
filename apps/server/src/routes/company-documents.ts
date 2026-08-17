import { createHash, randomUUID } from 'node:crypto';
import {
  CompanyDocumentListResponseSchema,
  CompanyDocumentSchema,
  CompanyDocumentUploadQuerySchema,
  CompanyDocumentVersionUploadQuerySchema,
  type CompanyDocument,
  type CompanyDocumentCategory,
  type CompanyDocumentExpiryStatus,
  type CompanyDocumentVersion,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { ObjectStorage } from '@auto-mb/documents';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { isWriterRole, membershipOf } from '../authz.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import {
  audit,
  errorResponses,
  EXPIRY_WARNING_DAYS,
  IdParamsSchema,
  upstreamErrorResponses,
} from './shared.js';

/**
 * The company document library (migration 0079).
 *
 * Organisation-level credentials — GST registration, PAN, an ISO
 * certificate, a bank solvency letter, a completion certificate from a
 * contract three years ago — uploaded once, kept versioned, carrying the
 * validity window printed on the paper, and reused wherever they are
 * demanded.
 *
 * Three things distinguish it from every other document surface here and
 * are worth stating once rather than being inferred from the absence of
 * code:
 *
 *   1. **No Work.** The library is organisation-level by definition, so
 *      there is no `assertWorkAccess` and no work-scope predicate. The
 *      isolation is RLS on `organisation_id`, plus the one category rule
 *      below; nothing else is needed.
 *   2. **No issue lifecycle.** These are copies of documents somebody
 *      else issued. There is no number to reserve, no cancellation that
 *      retains one, and no signature verdict — the machinery that
 *      protects documents this organisation issues does not apply to
 *      documents it merely holds.
 *   3. **Expiry is derived, never stored.** `expiresOn` is a fact about
 *      the certificate; "expiring" is a fact about today, and a stored
 *      answer to a question about today is wrong by the next morning.
 *      The status below is computed in SQL against `current_date` on
 *      every read.
 *
 * ponytail: no notification when a credential is about to lapse — the
 * register colours it and the Dashboard does not know about it yet. Wave
 * D owns scheduled reminders; wire this list into it there rather than
 * growing a job here.
 *
 * Writes are `role: 'writer'` (owner or office). Deliberately NOT a new
 * membership authority: the three that exist — issue, cancel, statutory —
 * are authorities over documents this organisation puts its name to, and
 * filing a copy of one's own PAN card is not that act. It is ordinary
 * organisation master data and it is gated the way the rest of the
 * masters are.
 */

/** The storage area segment for this module. `assertSafeObjectKey`
 * accepts `[a-z]+` only, which is why it is one word and not
 * `company-documents`. */
const STORAGE_AREA = 'orgdoc';

/**
 * The one category that is not open to every member (owner decision,
 * 2026-08-18).
 *
 * Balance sheets, turnover certificates and bank solvency letters state
 * what the company is worth and who it banks with. Every other bucket in
 * the library is a document the agency hands to strangers on request — a
 * GST registration number is printed on its invoices — but this one is
 * commercially sensitive, and site staff and viewers have no work that
 * needs it.
 *
 * The gate is the writer role, the same one that governs writing here,
 * rather than a new grant: the people who file the financials are the
 * people who may read them.
 */
const RESTRICTED_CATEGORY = 'financial';

interface DocumentRow {
  id: string;
  title: string;
  category: CompanyDocumentCategory;
  archived_at: Date | null;
  created_at: Date;
}

interface VersionRow {
  id: string;
  company_document_id: string;
  version_number: number;
  original_filename: string;
  sha256: string;
  size_bytes: string;
  valid_from: string | null;
  expires_on: string | null;
  expiry_status: CompanyDocumentExpiryStatus;
  expires_in_days: number | null;
  uploaded_by_user_id: string;
  created_at: Date;
}

function toVersion(row: VersionRow): CompanyDocumentVersion {
  return {
    id: row.id,
    versionNumber: Number(row.version_number),
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    validFrom: row.valid_from,
    expiresOn: row.expires_on,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Credentials of the bound organisation with their whole version
 * history, newest version first. `documentId` narrows both statements to
 * one credential, which is what every mutation wants for its read-back —
 * those run inside the parent's row lock, and a whole-library scan under
 * a lock is a scan every other writer waits behind.
 *
 * The expiry reading is computed in SQL rather than in TypeScript on
 * purpose: `current_date` is the database's date, which is the same date
 * every reader of this organisation gets, whereas a browser clock is not
 * and a Node process in another region need not be. Date arithmetic on a
 * `date` column also cannot drift into a timezone round-trip, which
 * engineering rule 6 forbids for exactly this kind of legal date.
 *
 * ponytail: the list endpoint returns every version of every credential.
 * That is tens of rows against tens of rows and the register renders the
 * history inline from it, so one round trip beats a request per expanded
 * row. If a library ever grows past a few hundred versions, return the
 * newest version here and fetch the rest per credential on demand — the
 * response shape already isolates that change to `versions`.
 */
async function readLibrary(
  tx: TransactionSql,
  options: { readonly documentId?: string; readonly includeRestricted: boolean },
): Promise<CompanyDocument[]> {
  const { documentId, includeRestricted } = options;
  // The category rule is enforced in the WHERE clause of the credential
  // read, not by filtering the result: a non-writer's request never
  // selects a financial row, so there is one code path and no risk of an
  // unfiltered array escaping through a branch somebody adds later. The
  // version read joins back through it, so a hidden credential's versions
  // are hidden with it rather than by a second, separately-maintained
  // predicate.
  const visible = includeRestricted ? tx`true` : tx`category <> ${RESTRICTED_CATEGORY}`;
  const documents = await tx<DocumentRow[]>`
    select id, title, category, archived_at, created_at
    from company_documents
    where ${documentId === undefined ? tx`true` : tx`id = ${documentId}`}
      and ${visible}
    -- Live credentials before retired ones, alphabetical within each.
    -- Deliberately unindexed: see 0079 for why a library of tens of rows
    -- sorts in memory instead.
    order by (archived_at is not null), lower(title)
  `;
  if (documents.length === 0) return [];

  const versions = await tx<VersionRow[]>`
    select
      id,
      company_document_id,
      version_number,
      original_filename,
      sha256,
      size_bytes::text as size_bytes,
      valid_from::text as valid_from,
      expires_on::text as expires_on,
      case
        when expires_on is null then 'none'
        when expires_on < current_date then 'expired'
        when expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int
          then 'expiring'
        else 'valid'
      end as expiry_status,
      (expires_on - current_date)::int as expires_in_days,
      uploaded_by_user_id,
      created_at
    from company_document_versions
    where company_document_id in ${tx(documents.map((document) => document.id))}
    order by company_document_id, version_number desc
  `;

  const byDocument = new Map<string, VersionRow[]>();
  for (const version of versions) {
    const bucket = byDocument.get(version.company_document_id);
    if (bucket === undefined) byDocument.set(version.company_document_id, [version]);
    else bucket.push(version);
  }

  return documents.map((document) => {
    const history = byDocument.get(document.id) ?? [];
    // The NEWEST version is the one a bid would attach, so it is the one
    // whose validity the register reports. An older version having lapsed
    // is not news — that is what superseding it was for.
    const current = history[0];
    return {
      id: document.id,
      title: document.title,
      category: document.category,
      versions: history.map(toVersion),
      expiryStatus: current?.expiry_status ?? 'none',
      expiresInDays:
        current?.expires_in_days === undefined || current.expires_in_days === null
          ? null
          : Number(current.expires_in_days),
      archivedAt: document.archived_at?.toISOString() ?? null,
      createdAt: document.created_at.toISOString(),
    };
  });
}

/** The read-back after a mutation. Every caller runs under `role:
 * 'writer'`, which is also the role the restricted category answers to,
 * so a writer never gets a 404 for a credential they just wrote. */
async function readOne(
  tx: TransactionSql,
  documentId: string,
): Promise<CompanyDocument> {
  const [found] = await readLibrary(tx, { documentId, includeRestricted: true });
  if (found === undefined) {
    throw httpError(404, 'COMPANY_DOCUMENT_NOT_FOUND', 'No such company document.');
  }
  return found;
}

/** PostgreSQL's unique-violation SQLSTATE, which is how a lost race
 * arrives on both write paths: the partial unique index on the title and
 * the per-credential version-number unique in 0079 are the arbiters, not
 * a read-then-write check that two writers can both pass. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

export function registerCompanyDocumentRoutes(
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
      url: '/api/company-documents',
      schema: {
        response: { 200: CompanyDocumentListResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }) =>
      tenant(async (tx) => ({
        documents: await readLibrary(tx, {
          includeRestricted: isWriterRole(await membershipOf(tx, user.id)),
        }),
        expiryWarningDays: EXPIRY_WARNING_DAYS,
      })),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/company-documents',
      role: 'writer',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        querystring: CompanyDocumentUploadQuerySchema,
        response: { 201: CompanyDocumentSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { title, category, validFrom, expiresOn } = request.query;
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the company document',
      });
      const trimmedTitle = requireTrimmed(title, 'Give the company document a name.');
      const filename = requireTrimmed(request.query.filename, FILENAME_REFUSAL);
      assertValidityOrder(validFrom, expiresOn);

      // Authorisation and the name check BEFORE the expensive scan: an
      // unauthorised caller, or one re-adding a credential the library
      // already holds, must not spend scanner capacity. The `role`
      // above runs inside this transaction; the read below is the rest
      // of the answer. It is advisory only — the partial unique index is
      // what actually decides, below, under concurrency.
      await tenant(async (tx) => {
        await assertTitleFree(tx, trimmedTitle);
      });
      await assertNotMalware(scanner, bytes);

      const stored = await putVersionBytes(storage, organisationId, bytes);

      const created = await tenant(async (tx) => {
        let documentId: string;
        try {
          const [row] = await tx<{ id: string }[]>`
            insert into company_documents (
              organisation_id, title, category, created_by_user_id
            )
            values (
              ${organisationId}, ${trimmedTitle}, ${category}, ${user.id}
            )
            returning id
          `;
          if (!row) throw new Error('company document insert returned no row');
          documentId = row.id;
        } catch (error) {
          if (isUniqueViolation(error)) throw titleTakenError(trimmedTitle);
          throw error;
        }
        await insertVersion(tx, {
          organisationId,
          documentId,
          versionId: stored.versionId,
          versionNumber: 1,
          objectKey: stored.objectKey,
          filename,
          sha256: stored.sha256,
          sizeBytes: bytes.length,
          validFrom,
          expiresOn,
          userId: user.id,
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'company_document.created',
          'company_documents',
          documentId,
          { title: trimmedTitle, category, sha256: stored.sha256 },
        );
        return readOne(tx, documentId);
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/company-documents/:id/versions',
      role: 'writer',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: CompanyDocumentVersionUploadQuerySchema,
        response: { 201: CompanyDocumentSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { validFrom, expiresOn } = request.query;
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the renewed company document',
      });
      const filename = requireTrimmed(request.query.filename, FILENAME_REFUSAL);
      assertValidityOrder(validFrom, expiresOn);

      // Same ordering as the create above, and for the same reason: prove
      // the caller may write and that the credential is there and still
      // live before a 25 MB body reaches the scanner.
      await tenant(async (tx) => {
        await loadLiveDocument(tx, id);
      });
      await assertNotMalware(scanner, bytes);

      const stored = await putVersionBytes(storage, organisationId, bytes);

      const updated = await tenant(async (tx) => {
        // The row lock is what serialises two renewals uploaded in the
        // same second: the reader of `max(version_number)` holds the
        // parent until it has written its own row. The unique constraint
        // on (organisation, document, version_number) is the second
        // layer, so a lock that was somehow not taken still cannot
        // produce two v4s.
        await loadLiveDocument(tx, id, { forUpdate: true });
        const [highest] = await tx<{ next_number: string }[]>`
          select coalesce(max(version_number), 0) + 1 as next_number
          from company_document_versions
          where company_document_id = ${id}
        `;
        const versionNumber = Number(highest?.next_number ?? 1);
        try {
          await insertVersion(tx, {
            organisationId,
            documentId: id,
            versionId: stored.versionId,
            versionNumber,
            objectKey: stored.objectKey,
            filename,
            sha256: stored.sha256,
            sizeBytes: bytes.length,
            validFrom,
            expiresOn,
            userId: user.id,
          });
        } catch (error) {
          // The layer above says the constraint catches a lost race; this
          // is the layer that stops the caller learning about it as a 500.
          // Unreachable while the row lock holds, which is exactly why it
          // has to be here — the claim that the constraint is a real
          // second layer is only true if losing to it produces an answer.
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'COMPANY_DOCUMENT_VERSION_CONFLICT',
              'Another renewal of this document was stored at the same moment. Try the upload again.',
            );
          }
          throw error;
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'company_document.version_uploaded',
          'company_documents',
          id,
          { versionNumber, sha256: stored.sha256, sizeBytes: bytes.length },
        );
        return readOne(tx, id);
      });
      return reply.status(201).send(updated);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/company-documents/:id/archive',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        response: { 200: CompanyDocumentSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const document = await loadLiveDocument(tx, id, { forUpdate: true });
        await tx`
          update company_documents
          set archived_at = now(), archived_by_user_id = ${user.id}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'company_document.archived',
          'company_documents',
          id,
          { title: document.title },
        );
        return readOne(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      // Addressed by the VERSION's own id rather than as a child path of
      // the credential. A version id is a uuid and unique on its own, the
      // shared `IdParamsSchema` covers it verbatim, and the register
      // already holds the id of every version it can offer — the same
      // shape `/api/contract-source-documents/:id/file` uses.
      url: '/api/company-document-versions/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const version = await tenant(async (tx) => {
        const [row] = await tx<
          {
            object_key: string;
            original_filename: string;
            category: CompanyDocumentCategory;
          }[]
        >`
          select v.object_key, v.original_filename, d.category
          from company_document_versions v
          join company_documents d on d.id = v.company_document_id
          where v.id = ${id}
        `;
        if (!row) {
          throw httpError(
            404,
            'COMPANY_DOCUMENT_VERSION_NOT_FOUND',
            'No such company document version.',
          );
        }
        // 403, not 404 — and the difference is deliberate. A 404 is the
        // right answer for another TENANT's version, where the row's very
        // existence is theirs to keep; this caller is a member of the
        // organisation that owns the file, so the credential is not a
        // secret from them, only its contents are. Telling them the file
        // exists and that their role does not reach it is a refusal they
        // can act on; pretending it is missing sends them looking for a
        // document their colleague can see.
        if (
          row.category === RESTRICTED_CATEGORY &&
          !isWriterRole(await membershipOf(tx, user.id))
        ) {
          throw httpError(
            403,
            'ROLE_FORBIDDEN',
            'Financial documents are readable by owner or office members only.',
          );
        }
        return row;
      });
      const bytes = await storage.get(version.object_key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(version.original_filename)}`,
      );
      return reply.send(bytes);
    },
  );
}

function titleTakenError(title: string): Error {
  return httpError(
    409,
    'COMPANY_DOCUMENT_TITLE_EXISTS',
    `The library already holds a document called "${title}". Upload the renewal as a new version of it instead.`,
  );
}

const FILENAME_REFUSAL = 'The uploaded file needs a name.';

/**
 * A querystring field the schema bounded but did not trim.
 *
 * `minLength: 1` admits a string of spaces, and 0079 refuses both an
 * untrimmed title and a blank filename with CHECK constraints. Without
 * this the refusal arrives as SQLSTATE 23514 — a 500 rather than a 400,
 * and one raised AFTER the bytes have already been written to object
 * storage, so a caller who typed a space into the filename gets an
 * unexplained server error and leaves an orphan object behind.
 */
function requireTrimmed(value: string, refusal: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw httpError(400, 'FIELD_TOO_SHORT', refusal);
  return trimmed;
}

/** The validity window has to open before it closes. Checked here as well
 * as by the CHECK constraint in 0079 so the operator gets a sentence
 * rather than a constraint name. */
function assertValidityOrder(
  validFrom: string | undefined,
  expiresOn: string | undefined,
): void {
  if (validFrom !== undefined && expiresOn !== undefined && expiresOn < validFrom) {
    throw httpError(
      400,
      'COMPANY_DOCUMENT_DATE_INVALID',
      'The expiry date cannot be earlier than the date the document takes effect.',
    );
  }
}

async function assertTitleFree(tx: TransactionSql, title: string): Promise<void> {
  const [existing] = await tx<{ id: string }[]>`
    select id from company_documents
    where lower(title) = lower(${title}) and archived_at is null
  `;
  if (existing) throw titleTakenError(title);
}

async function loadLiveDocument(
  tx: TransactionSql,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<{ id: string; title: string }> {
  // Two statements rather than an interpolated `FOR UPDATE`: the lock
  // clause is a structural choice of the caller, and this keeps the SQL
  // built by the tagged template alone.
  const [row] = options.forUpdate
    ? await tx<{ id: string; title: string; archived_at: Date | null }[]>`
        select id, title, archived_at from company_documents
        where id = ${id}
        for update
      `
    : await tx<{ id: string; title: string; archived_at: Date | null }[]>`
        select id, title, archived_at from company_documents
        where id = ${id}
      `;
  if (!row) {
    throw httpError(404, 'COMPANY_DOCUMENT_NOT_FOUND', 'No such company document.');
  }
  if (row.archived_at !== null) {
    throw httpError(
      409,
      'COMPANY_DOCUMENT_ARCHIVED',
      'This company document is archived. Add it to the library again to keep using it.',
    );
  }
  return { id: row.id, title: row.title };
}

/** Writes the bytes under a server-generated key and hands back the id
 * the row will carry, so the object and its row are the same uuid.
 *
 * Deliberately OUTSIDE the transaction, exactly as `routes/loa.ts` does
 * it: a failure after this point leaves an orphan object under a uuid
 * nothing points at, which is inert, where the opposite ordering would
 * leave a row promising bytes that are not there. */
async function putVersionBytes(
  storage: ObjectStorage,
  organisationId: string,
  bytes: Buffer,
): Promise<{ versionId: string; objectKey: string; sha256: string }> {
  const versionId = randomUUID();
  const objectKey = `${organisationId}/${STORAGE_AREA}/${versionId}.pdf`;
  await storage.put(objectKey, bytes);
  return {
    versionId,
    objectKey,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

interface VersionInsert {
  readonly organisationId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly objectKey: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly validFrom: string | undefined;
  readonly expiresOn: string | undefined;
  readonly userId: string;
}

async function insertVersion(tx: TransactionSql, insert: VersionInsert): Promise<void> {
  await tx`
    insert into company_document_versions (
      id, organisation_id, company_document_id, version_number, object_key,
      original_filename, sha256, media_type, size_bytes, valid_from,
      expires_on, uploaded_by_user_id
    )
    values (
      ${insert.versionId}, ${insert.organisationId}, ${insert.documentId},
      ${insert.versionNumber}, ${insert.objectKey}, ${insert.filename},
      ${insert.sha256}, 'application/pdf', ${insert.sizeBytes},
      ${insert.validFrom ?? null}, ${insert.expiresOn ?? null},
      ${insert.userId}
    )
  `;
}
