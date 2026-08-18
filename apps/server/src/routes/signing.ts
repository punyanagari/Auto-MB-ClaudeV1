import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import {
  CancelSigningRequestSchema,
  ClaimSigningJobResponseSchema,
  CreateSigningRequestSchema,
  RegisterSigningAgentResponseSchema,
  RegisterSigningAgentSchema,
  SigningAgentResponseSchema,
  SigningQueueQuerySchema,
  SigningQueueResponseSchema,
  SigningRequestResponseSchema,
  SubmitSignatureResponseSchema,
  SubmitSignatureSchema,
  withKeysetQuery,
  type ErrorCode,
  type SigningAgent,
  type SigningDocumentType,
  type SigningRequest,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import {
  certificateThumbprint,
  CONTENTS_HEX_RESERVATION,
  detachedSignatureFits,
  finishDetachedPdfSignature,
  prepareDetachedPdfSignature,
  sha256Hex,
  verifyPdfSignatures,
  type ObjectStorage,
  type PreparedPdfSignature,
  type TrustAnchorStore,
} from '@auto-mb/documents';
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, membershipOf } from '../authz.js';
import { requireEntitlement } from '../entitlements.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { keysetPage, sqlLimit, workScopedCursorRowId } from '../pagination.js';
import { withBoundTenant } from '../tenant-context.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  audit,
  errorResponses,
  IdParamsSchema,
  upstreamErrorResponses,
} from './shared.js';

/**
 * The signing queue and the kiosk that empties it (migration 0091,
 * ADR-0012 lane 2).
 *
 * ## The shape of the thing
 *
 * A member raises a request against an issued document. The server
 * prepares the whole signature there and then — the PDF revision, the
 * ByteRange, the CMS signed attributes — and stores the one value the
 * token will be asked for: `sha256(signedAttrs)`. A kiosk agent polls,
 * claims the request, presents that digest to the USB token through
 * Windows CNG, and posts the raw RSA signature back. The server rebuilds
 * the preparation from the stored bytes, refuses if the digest it derives
 * is not the one it authorised, assembles the CMS, embeds it, verifies its
 * own output with the 0060 verifier, and stores the result under a new
 * key.
 *
 * ## What this file never holds
 *
 * A private key, a PIN, or a plaintext bearer token beyond the single
 * response that issues one. The kiosk holds the key and cannot be made to
 * sign anything but a 32-byte digest it was handed; the server holds the
 * documents and cannot produce a signature at all.
 *
 * ## Why the agent's routes are unbound
 *
 * They authenticate with a bearer token rather than a session cookie, so
 * they cannot go through `createTenantRouteRegistrar` — there is no
 * session for `requireUser` to prove. What they DO go through is the same
 * membership floor everything else does: `resolveAgent` turns the token
 * into an organisation and an operator, and every statement afterwards
 * runs inside `withBoundTenant` under that operator, so
 * `app_private.bind_tenant` re-proves the membership on every poll. An
 * operator removed from the organisation stops the kiosk without anyone
 * remembering to revoke it.
 *
 * The two addresses are listed in `test/route-inventory.integration.test.ts`'s
 * `UNBOUND_ROUTES`, and because that listing exempts them from the
 * inventory's own 401 and 403 sweeps, `test/signing.integration.test.ts`
 * carries the replacements: a tokenless request, a malformed one, a wrong
 * token and a revoked token are each proved to be refused.
 *
 * ## Permissions
 *
 * Raising and withdrawing a request carry the `sign` authority (owner
 * ruling 2026-08-18; migration 0091 adds the column). NOT `issue`, and
 * the distinction is load-bearing: the digest binding answers WHICH
 * DOCUMENT may be signed, and nothing in it stops the wrong member from
 * putting a perfectly valid request in front of a signer who then types
 * their PIN because the queue said to. The authority answers WHO MAY
 * QUEUE ONE. Registering and revoking a kiosk is owner-only on top of
 * that — it hands out a credential.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0091 raises with SQLSTATEs from the 23J block, one per rule,
 * so a guard that fires because the route's own check lost a race surfaces
 * as the same 409 an operator would have got from the route — not as an
 * unexplained 500.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23J01': [
    'SIGNING_REQUEST_STATE',
    'The signing request moved on while this was being recorded; reload the queue and try again.',
  ],
  '23J02': [
    'SIGNING_REQUEST_STATE',
    'The authorised facts of a signing request cannot be changed; cancel it and raise a new one.',
  ],
  '23J03': [
    'SIGNING_DOCUMENT_NOT_RENDERED',
    'The document stopped being issued while the signing request was being raised.',
  ],
  '23J04': [
    'SIGNING_AGENT_REVOKED',
    'The kiosk was revoked while this signature was in flight; register a kiosk and raise the request again.',
  ],
  '23J05': [
    'SIGNING_AGENT_REVOKED',
    'A kiosk credential cannot be edited or restored; register a new kiosk instead.',
  ],
  // A second open request against one document loses the race to the
  // partial unique index rather than to a guard, so it arrives as 23505.
  '23505': [
    'SIGNING_REQUEST_OPEN',
    'Another signing request against this document was raised while this one was being recorded.',
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

/** How long an authorisation stands before it lapses.
 *
 * ADR-0012 requires the authorisation to carry an expiry, and the value is
 * the operational one rather than a round number: a document raised on a
 * Friday has to survive a weekend at a kiosk nobody is sitting at, and a
 * request older than that is one whose source document has probably been
 * re-rendered since. */
const AUTHORISATION_TTL_DAYS = 7;

/** How many requests the queue returns when the caller asks for no page. */
const QUEUE_PAGE_LIMIT = 200;

/** The default `/Reason` when a request does not name one. Operational,
 * not decorative: it is what a counterparty reads in Adobe's signature
 * panel. */
const DEFAULT_SIGNING_REASON = 'Issued by the contractor';

/* --- the source document -------------------------------------------------- */

interface SigningSource {
  readonly workId: string;
  readonly documentNumber: string | null;
  readonly objectKey: string;
  readonly sha256: string;
}

/**
 * Where the bytes of an issued document live, per register.
 *
 * The two registers store their render differently — a challan carries the
 * key on its own row, an invoice keeps a versioned history in
 * `tax_invoice_renders` — and the signing queue deliberately does NOT
 * paper over that with a third store. It copies the key and the digest of
 * whichever version is current, and re-reads both at completion, so a
 * document re-rendered under a pending request fails the digest check
 * rather than being signed unreviewed.
 */
/** Which Work a document belongs to, and nothing else about it.
 *
 * Split out of `readSigningSource` so work-scope can be proved before any
 * refusal that describes the document's STATE. See the call site: the
 * other order lets a caller who may not see the Work distinguish a draft
 * challan from a nonexistent id. */
async function readSigningDocumentWork(
  tx: TransactionSql,
  documentType: SigningDocumentType,
  documentId: string,
): Promise<string> {
  const [row] =
    documentType === 'delivery_challan'
      ? await tx<{ work_id: string }[]>`
          select work_id from delivery_challans where id = ${documentId}
        `
      : await tx<{ work_id: string }[]>`
          select work_id from tax_invoices where id = ${documentId}
        `;
  if (!row) throw documentNotFound();
  return row.work_id;
}

async function readSigningSource(
  tx: TransactionSql,
  documentType: SigningDocumentType,
  documentId: string,
): Promise<SigningSource> {
  if (documentType === 'delivery_challan') {
    const [row] = await tx<
      {
        work_id: string;
        challan_number: string | null;
        status: string;
        rendered_object_key: string | null;
        rendered_sha256: string | null;
      }[]
    >`
      select work_id, challan_number, status, rendered_object_key, rendered_sha256
      from delivery_challans where id = ${documentId}
    `;
    if (!row) throw documentNotFound();
    if (row.status !== 'issued') {
      throw httpError(
        409,
        'SIGNING_DOCUMENT_NOT_RENDERED',
        'Only an issued challan can be signed; issue it first.',
      );
    }
    if (row.rendered_object_key === null || row.rendered_sha256 === null) {
      throw notRendered();
    }
    return {
      workId: row.work_id,
      documentNumber: row.challan_number,
      objectKey: row.rendered_object_key,
      sha256: row.rendered_sha256,
    };
  }

  const [row] = await tx<
    {
      work_id: string;
      invoice_number: string | null;
      status: string;
      object_key: string | null;
      pdf_sha256: string | null;
    }[]
  >`
    select i.work_id, i.invoice_number, i.status,
           r.object_key, r.pdf_sha256
    from tax_invoices i
    left join lateral (
      select object_key, pdf_sha256 from tax_invoice_renders
      where organisation_id = i.organisation_id and tax_invoice_id = i.id
      order by version desc limit 1
    ) r on true
    where i.id = ${documentId}
  `;
  if (!row) throw documentNotFound();
  if (row.status !== 'submitted') {
    throw httpError(
      409,
      'SIGNING_DOCUMENT_NOT_RENDERED',
      'Only a submitted tax invoice can be signed; submit it first.',
    );
  }
  if (row.object_key === null || row.pdf_sha256 === null) throw notRendered();
  return {
    workId: row.work_id,
    documentNumber: row.invoice_number,
    objectKey: row.object_key,
    sha256: row.pdf_sha256,
  };
}

function documentNotFound(): Error {
  // 404, not 403: a guessed id must not confirm the document exists, which
  // is the same posture `assertWorkAccess` holds.
  return httpError(404, 'SIGNING_REQUEST_NOT_FOUND', 'No such document.');
}

function notRendered(): Error {
  return httpError(
    409,
    'SIGNING_DOCUMENT_NOT_RENDERED',
    'This document has no rendered PDF to sign; render it first.',
  );
}

/* --- certificates --------------------------------------------------------- */

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

/** Every certificate in a PEM bundle, signer first, in the order written. */
function parseCertificateChain(pem: string): readonly X509Certificate[] {
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0) {
    throw httpError(
      400,
      'SIGNING_CERTIFICATE_INVALID',
      'The certificate chain must be one or more PEM certificate blocks, signer first.',
    );
  }
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    throw httpError(
      400,
      'SIGNING_CERTIFICATE_INVALID',
      'The certificate chain could not be read as X.509 certificates.',
    );
  }
}

/* --- the preparation, which happens twice --------------------------------- */

/**
 * Everything up to the digest, from the stored facts alone.
 *
 * Called once when the request is raised and again when the signature
 * comes back, and the second call is the security check rather than a
 * repetition: `prepareDetachedPdfSignature` is a pure function of the
 * source bytes, the certificate and the dictionary entries, so a digest
 * that differs from the stored one means the bytes changed underneath the
 * authorisation. See migration 0091's header for the concrete way that
 * happens — `POST /api/challans/:id/render` writes to the same object key
 * every time it runs.
 */
function prepare(
  source: Buffer,
  chain: readonly X509Certificate[],
  facts: {
    readonly signerName: string;
    readonly signingReason: string;
    readonly signingLocation: string;
    readonly claimedSigningTime: Date;
  },
): PreparedPdfSignature {
  return prepareDetachedPdfSignature(source, {
    certificateChain: chain,
    signerName: facts.signerName,
    reason: facts.signingReason,
    location: facts.signingLocation,
    claimedSigningTime: pdfDate(facts.claimedSigningTime),
  });
}

/** `D:20260818143000+05'30'` — the PDF date syntax, in IST.
 *
 * The offset is fixed rather than read from the host's timezone: a
 * container running in UTC would otherwise stamp a different string for
 * the same instant, and the string is inside the signed bytes, so the
 * preparation would stop being reproducible on a redeploy. */
function pdfDate(at: Date): string {
  // toISOString already zero-pads every field in exactly the order the PDF
  // date syntax wants, so stripping its separators and keeping the first
  // fourteen digits IS the format — no hand-rolled padding needed. The
  // shift is applied to the instant, then read back in UTC, so the host
  // timezone never enters.
  const ist = new Date(at.getTime() + 19_800_000).toISOString();
  return `D:${ist.replace(/\D/g, '').slice(0, 14)}+05'30'`;
}

/* --- row shapes ----------------------------------------------------------- */

interface RequestRow {
  id: string;
  document_type: SigningDocumentType;
  delivery_challan_id: string | null;
  tax_invoice_id: string | null;
  work_id: string;
  channel: 'kiosk_dsc' | 'esign';
  status: SigningRequest['status'];
  source_object_key: string;
  source_sha256: string;
  authorised_digest: string;
  claimed_signing_time: Date;
  signer_name: string;
  signing_reason: string;
  signing_location: string;
  expires_at: Date;
  signing_agent_id: string;
  certificate_thumbprint: string;
  signed_object_key: string | null;
  signed_sha256: string | null;
  signature_verdict: unknown;
  failure_reason: string | null;
  requested_by_user_id: string;
  requested_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  document_number: string | null;
  work_code: string | null;
}

const REQUEST_COLUMNS = `
  r.id, r.document_type, r.delivery_challan_id, r.tax_invoice_id, r.work_id,
  r.channel, r.status, r.source_object_key, r.source_sha256,
  r.authorised_digest, r.claimed_signing_time, r.signer_name, r.signing_reason,
  r.signing_location, r.expires_at, r.signing_agent_id, r.certificate_thumbprint,
  r.signed_object_key, r.signed_sha256, r.signature_verdict, r.failure_reason,
  r.requested_by_user_id, r.requested_at, r.claimed_at, r.completed_at,
  coalesce(c.challan_number, i.invoice_number) as document_number,
  w.work_code
`;

/** The joins `REQUEST_COLUMNS` reads its display names from. Both
 * registers, left-joined, because a row names exactly one of them. */
function requestSource(tx: TransactionSql) {
  return tx`
    signing_requests r
    join works w on w.organisation_id = r.organisation_id and w.id = r.work_id
    left join delivery_challans c
      on c.organisation_id = r.organisation_id and c.id = r.delivery_challan_id
    left join tax_invoices i
      on i.organisation_id = r.organisation_id and i.id = r.tax_invoice_id
  `;
}

function toRequest(row: RequestRow): SigningRequest {
  return {
    id: row.id,
    documentType: row.document_type,
    documentId: row.delivery_challan_id ?? row.tax_invoice_id ?? row.id,
    documentNumber: row.document_number,
    workCode: row.work_code,
    channel: row.channel,
    status: row.status,
    sourceSha256: row.source_sha256,
    signedSha256: row.signed_sha256,
    certificateThumbprint: row.certificate_thumbprint,
    signerName: row.signer_name,
    signingReason: row.signing_reason,
    signingLocation: row.signing_location,
    requestedByUserId: row.requested_by_user_id,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    claimedAt: row.claimed_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    signatureVerdict: parseJsonbColumn(
      row.signature_verdict,
    ) as SigningRequest['signatureVerdict'],
    failureReason: row.failure_reason,
  };
}

interface AgentRow {
  id: string;
  label: string;
  certificate_thumbprint: string;
  certificate_subject: string;
  certificate_not_after: Date;
  operator_user_id: string;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function toAgent(row: AgentRow): SigningAgent {
  return {
    id: row.id,
    label: row.label,
    certificateThumbprint: row.certificate_thumbprint,
    certificateSubject: row.certificate_subject,
    certificateNotAfter: row.certificate_not_after.toISOString(),
    operatorUserId: row.operator_user_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

async function readAgents(tx: TransactionSql): Promise<readonly SigningAgent[]> {
  const rows = await tx<AgentRow[]>`
    select id, label, certificate_thumbprint, certificate_subject,
           certificate_not_after, operator_user_id, created_at, last_seen_at,
           revoked_at
    from signing_agents order by created_at desc
  `;
  return rows.map(toAgent);
}

/* --- the module ------------------------------------------------------------ */

/** A kiosk whose token resolved, with the bound-transaction closure every
 * statement it causes must run inside. */
interface ResolvedAgent {
  readonly id: string;
  readonly organisationId: string;
  readonly operatorUserId: string;
  readonly bound: <T>(work: (tx: TransactionSql) => Promise<T>) => Promise<T>;
}

function agentUnauthenticated(): Error {
  return httpError(
    401,
    'SIGNING_UNAUTHENTICATED',
    'This kiosk credential is not recognised.',
  );
}

export function registerSigningRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  pdfTrustAnchors: TrustAnchorStore,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /**
   * Turns a bearer token into a bound tenant transaction.
   *
   * Two steps, and both are load-bearing. `app_private.resolve_signing_agent`
   * crosses tenancy exactly once, by exact hash, to learn WHICH
   * organisation and WHICH operator the token belongs to (migration 0091
   * § 2). `withBoundTenant` then proves that operator's membership through
   * the same floor a browser request passes, so everything the agent goes
   * on to read and write is scoped by RLS rather than by this function's
   * good intentions.
   *
   * The refusal is one sentence for every failure — no token, a malformed
   * header, an unknown token, a revoked agent — because telling them apart
   * tells an attacker which half of their guess was right.
   */
  async function resolveAgent(request: FastifyRequest): Promise<ResolvedAgent> {
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    if (token.length === 0) throw agentUnauthenticated();
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    const [resolved] = await database<
      { agent_id: string; organisation_id: string; operator_user_id: string }[]
    >`select * from app_private.resolve_signing_agent(${hash})`;
    if (!resolved) throw agentUnauthenticated();
    return {
      id: resolved.agent_id,
      organisationId: resolved.organisation_id,
      operatorUserId: resolved.operator_user_id,
      bound: (work) =>
        withBoundTenant(
          database,
          resolved.organisation_id,
          resolved.operator_user_id,
          work,
        ),
    };
  }

  /* --- the register a member sees ---------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/signing-requests',
      schema: {
        querystring: withKeysetQuery(SigningQueueQuerySchema),
        response: { 200: SigningQueueResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenantSnapshot }) => {
      const query = request.query;
      return tenantSnapshot(async (tx) => {
        const full = await hasFullWorkScope(tx, user.id);
        const scope = { userId: user.id, full };
        const cursor = await workScopedCursorRowId(
          tx,
          'signing_requests',
          query.cursor,
          scope,
        );
        const limit = query.limit ?? QUEUE_PAGE_LIMIT;
        const rows = await tx<RequestRow[]>`
          select ${tx.unsafe(REQUEST_COLUMNS)}
          from ${requestSource(tx)}
          where (${query.status ?? null}::text is null or r.status = ${query.status ?? null})
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = r.work_id and wa.user_id = ${user.id}
            ))
            and (
              ${cursor}::uuid is null
              or (r.requested_at, r.id) <
                 (select requested_at, id from signing_requests where id = ${cursor})
            )
          order by r.requested_at desc, r.id desc
          limit ${sqlLimit(limit)}
        `;
        const page = keysetPage(rows, limit, (row) => row.id);
        // THE KIOSK INVENTORY IS NOT PART OF THE REGISTER. The requests
        // are ordinary work-scoped records every member may read; the
        // agents are the organisation's security posture — which machine
        // holds the certificate, which thumbprint, when it last checked
        // in — and a viewer has no work that needs it. Empty for everyone
        // else, so the screen simply does not draw the panel rather than
        // refusing the whole page.
        const membership = await membershipOf(tx, user.id);
        const seesKiosks =
          membership?.role === 'owner' || membership?.can_sign_documents === true;
        return {
          requests: page.rows.map(toRequest),
          nextCursor: page.nextCursor,
          agents: seesKiosks ? await readAgents(tx) : [],
        };
      });
    },
  );

  /* --- raising one -------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/signing-requests',
      schema: {
        body: CreateSigningRequestSchema,
        response: { 201: SigningRequestResponseSchema, ...upstreamErrorResponses },
      },
      role: 'writer',
      authority: 'sign',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;

      // Three transactions with the object read between them, so the slow
      // storage call holds no database connection: the first proves what
      // may be signed and by which kiosk, the read fetches the bytes, and
      // the third writes the authorisation those bytes produced.
      const context = await tenant(async (tx) => {
        // The organisation must be entitled to the module at all (0096).
        // Gated on RAISING only: an organisation whose ESP/TSA
        // procurement has not landed cannot fill the queue with requests
        // nothing can fulfil, and can still read and withdraw whatever it
        // already raised. Before work-scope, because it is a property of
        // the organisation rather than of the document, and so discloses
        // nothing about the id in the body.
        await requireEntitlement(tx, 'outbound_signing');

        // WORK-SCOPE FIRST, then the document's state. The other order is
        // a status oracle: `readSigningSource` refuses a draft challan
        // with a 409 and a missing one with a 404, so a member who may
        // not see the Work at all could tell "this id is a draft challan"
        // from "this id is nothing" before `assertWorkAccess` ever runs.
        // Reading the Work id is the only thing that has to happen first,
        // and it discloses nothing on its own.
        const workId = await readSigningDocumentWork(
          tx,
          body.documentType,
          body.documentId,
        );
        await assertWorkAccess(tx, user.id, workId);
        const source = await readSigningSource(tx, body.documentType, body.documentId);
        const [agent] = await tx<
          {
            id: string;
            certificate_thumbprint: string;
            certificate_chain_pem: string;
          }[]
        >`
          select id, certificate_thumbprint, certificate_chain_pem
          from signing_agents where revoked_at is null
          order by created_at
        `;
        const active = await tx<{ count: number }[]>`
          select count(*)::int as count from signing_agents where revoked_at is null
        `;
        if (!agent || (active[0]?.count ?? 0) !== 1) {
          throw httpError(
            409,
            'SIGNING_KIOSK_UNAVAILABLE',
            (active[0]?.count ?? 0) === 0
              ? 'No signing kiosk is registered for this organisation; register one before raising a signing request.'
              : 'More than one signing kiosk is registered; revoke the ones no longer in use so a request names an unambiguous certificate.',
          );
        }
        const [signatory] = await tx<{ name: string }[]>`
          select name from organisation_signatories order by created_at limit 1
        `;
        const [organisation] = await tx<{ name: string; address: string | null }[]>`
          select name, address from organisations
          where id = app_private.current_organisation_id()
        `;
        return { source, agent, signatory, organisation };
      });

      const bytes = await storage.get(context.source.objectKey);
      const chain = parseCertificateChain(context.agent.certificate_chain_pem);
      const claimedSigningTime = new Date();
      const facts = {
        signerName:
          body.signerName?.trim() ??
          context.signatory?.name ??
          context.organisation?.name ??
          'Authorised Signatory',
        signingReason: body.signingReason?.trim() ?? DEFAULT_SIGNING_REASON,
        signingLocation:
          body.signingLocation?.trim() ??
          context.organisation?.address?.trim() ??
          'India',
        claimedSigningTime,
      };
      const preparation = prepareSafely(bytes, chain, facts);

      // The bytes as they were a moment ago, not as the register recorded
      // them: if a re-render landed between the two, the authorisation is
      // over what was actually read, and the register's own digest is the
      // one that has gone stale.
      const sourceSha256 = preparation.sourceSha256;
      const expiresAt = new Date(
        claimedSigningTime.getTime() + AUTHORISATION_TTL_DAYS * 24 * 60 * 60 * 1000,
      );

      const created = await tenant(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into signing_requests (
            organisation_id, document_type, delivery_challan_id, tax_invoice_id,
            work_id, source_object_key, source_sha256, authorised_digest,
            claimed_signing_time, signer_name, signing_reason, signing_location,
            expires_at, signing_agent_id, certificate_thumbprint,
            requested_by_user_id
          ) values (
            ${organisationId}, ${body.documentType},
            ${body.documentType === 'delivery_challan' ? body.documentId : null},
            ${body.documentType === 'tax_invoice' ? body.documentId : null},
            ${context.source.workId}, ${context.source.objectKey}, ${sourceSha256},
            ${preparation.digest.toString('hex')}, ${claimedSigningTime},
            ${facts.signerName}, ${facts.signingReason}, ${facts.signingLocation},
            ${expiresAt}, ${context.agent.id}, ${context.agent.certificate_thumbprint},
            ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!row)
          throw httpError(
            409,
            'SIGNING_REQUEST_STATE',
            'The request was not recorded.',
          );
        await audit(
          tx,
          organisationId,
          user.id,
          'signing_request.raised',
          'signing_requests',
          row.id,
          {
            documentType: body.documentType,
            documentId: body.documentId,
            sourceSha256,
            certificateThumbprint: context.agent.certificate_thumbprint,
          },
        );
        return readOne(tx, row.id);
      });

      reply.code(201);
      return { request: created };
    },
  );

  /* --- withdrawing one ---------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/signing-requests/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelSigningRequestSchema,
        response: { 200: SigningRequestResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'sign',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const reason = request.body.reason.trim();
      return tenant(async (tx) => {
        const existing = await lockRequest(tx, id);
        await assertWorkAccess(tx, user.id, existing.work_id);
        // A live claim is the kiosk's; a LAPSED one is nobody's, and this
        // is the operator's door out of it (migration 0091, `expires_at`).
        // Without it a kiosk that died mid-signature wedges the document
        // forever: the partial unique index refuses a replacement request
        // and nothing else can move the row.
        const withdrawable =
          existing.status === 'pending' ||
          (existing.status === 'claimed' && lapsed(existing));
        if (!withdrawable) {
          throw httpError(
            409,
            'SIGNING_REQUEST_STATE',
            existing.status === 'claimed'
              ? 'This request is at the kiosk; wait for it to finish or fail, or withdraw it once its lease lapses.'
              : 'This signing request has already finished and cannot be withdrawn.',
          );
        }
        await tx`
          update signing_requests
          set status = 'cancelled', completed_at = now(), failure_reason = ${reason}
          where id = ${id} and status in ('pending', 'claimed')
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'signing_request.cancelled',
          'signing_requests',
          id,
          { reason },
        );
        return { request: await readOne(tx, id) };
      });
    },
  );

  /* --- reading the signed document ---------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/signing-requests/:id/pdf',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      // Same authority as the unsigned document's own download: work
      // scope and nothing more. A signed challan is the SAME document
      // anyone who could read it already could read, plus a signature —
      // gating it harder than its own register would mean the people who
      // work the contract cannot see the copy that goes to the railway.
      const key = await tenant(async (tx) => {
        const row = await readRow(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.signed_object_key === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            'This request has not produced a signed document.',
          );
        }
        return row.signed_object_key;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header('content-disposition', `inline; filename="signed-${id}.pdf"`);
      return reply.send(bytes);
    },
  );

  /* --- registering and revoking a kiosk ----------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/signing-agents',
      schema: {
        body: RegisterSigningAgentSchema,
        response: { 201: RegisterSigningAgentResponseSchema, ...errorResponses },
      },
      role: 'owner',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;

      // 256 bits, base64url. The plaintext exists here and in the
      // response and nowhere else — never logged, never stored, never
      // recoverable.
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

      const agent = await tenant(async (tx) => {
        // Inside the binding, not before it. The registrar has proved
        // membership and the owner role by the time this runs, which is
        // the order that matters: a non-member asking about a malformed
        // certificate must be told they are not a member, not what is
        // wrong with their certificate.
        const chain = parseCertificateChain(body.certificateChainPem);
        const [leaf] = chain;
        if (leaf === undefined) {
          throw httpError(400, 'SIGNING_CERTIFICATE_INVALID', 'The chain is empty.');
        }
        const thumbprint = certificateThumbprint(leaf);
        if (thumbprint !== body.certificateThumbprint) {
          throw httpError(
            400,
            'SIGNING_CERTIFICATE_INVALID',
            'The pasted chain does not begin with the certificate whose thumbprint was given; the signer certificate must come first.',
          );
        }
        const notAfter = new Date(leaf.validTo);
        if (Number.isNaN(notAfter.getTime())) {
          throw httpError(
            400,
            'SIGNING_CERTIFICATE_INVALID',
            'The certificate does not carry a readable expiry date.',
          );
        }
        if (notAfter.getTime() <= Date.now()) {
          throw httpError(
            400,
            'SIGNING_CERTIFICATE_INVALID',
            'This certificate has already expired; a signature made with it would not verify.',
          );
        }

        // DOES A SIGNATURE MADE WITH THIS CHAIN FIT? Answered here, once,
        // rather than discovered after a token has already signed —
        // which is a 500 with the signature already made and the request
        // wedged `claimed`. Everything that decides the blob's size is
        // fixed the moment the chain is, so the rehearsal is exact.
        if (!detachedSignatureFits(chain)) {
          throw httpError(
            400,
            'SIGNING_CERTIFICATE_INVALID',
            `This certificate chain is too large: a signature made with it would not fit the ${String(CONTENTS_HEX_RESERVATION / 2)}-byte reservation this signer writes. Register the signer and the issuers above it only, without whatever extra certificates the export picked up.`,
          );
        }

        const [row] = await tx<AgentRow[]>`
          insert into signing_agents (
            organisation_id, label, token_hash, certificate_thumbprint,
            certificate_subject, certificate_serial, certificate_not_after,
            certificate_chain_pem, operator_user_id, created_by_user_id
          ) values (
            ${organisationId}, ${body.label.trim()}, ${tokenHash}, ${thumbprint},
            ${leaf.subject.replaceAll('\n', ', ')},
            ${leaf.serialNumber.toUpperCase()}, ${notAfter},
            ${chain.map((certificate) => certificate.toString()).join('')},
            ${user.id}, ${user.id}
          )
          returning id, label, certificate_thumbprint, certificate_subject,
                    certificate_not_after, operator_user_id, created_at,
                    last_seen_at, revoked_at
        `.catch(rethrowWriteRefusal);
        if (!row)
          throw httpError(
            409,
            'SIGNING_AGENT_NOT_FOUND',
            'The kiosk was not registered.',
          );
        await audit(
          tx,
          organisationId,
          user.id,
          'signing_agent.registered',
          'signing_agents',
          row.id,
          { label: row.label, certificateThumbprint: thumbprint },
        );
        return toAgent(row);
      });

      reply.code(201);
      return { agent, token };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/signing-agents/:id/revoke',
      schema: {
        params: IdParamsSchema,
        response: { 200: SigningAgentResponseSchema, ...errorResponses },
      },
      role: 'owner',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [row] = await tx<AgentRow[]>`
          update signing_agents
          set revoked_at = now(), revoked_by_user_id = ${user.id}
          where id = ${id} and revoked_at is null
          returning id, label, certificate_thumbprint, certificate_subject,
                    certificate_not_after, operator_user_id, created_at,
                    last_seen_at, revoked_at
        `.catch(rethrowWriteRefusal);
        if (!row) {
          throw httpError(
            404,
            'SIGNING_AGENT_NOT_FOUND',
            'No such kiosk, or it is revoked already.',
          );
        }
        // A revoked kiosk can never sign, so every request pointed at it
        // is dead. Failing them here is the difference between a queue
        // that says why nothing is happening and one that silently stops.
        await tx`
          update signing_requests
          set status = 'failed', completed_at = now(),
              failure_reason = 'The kiosk this request was raised for was revoked.'
          where signing_agent_id = ${id} and status in ('pending', 'claimed')
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'signing_agent.revoked',
          'signing_agents',
          id,
          { label: row.label },
        );
        return { agent: toAgent(row) };
      });
    },
  );

  /* --- what the kiosk calls ----------------------------------------------- */

  app.route({
    method: 'POST',
    url: '/api/signing/agent/claim',
    schema: {
      response: { 200: ClaimSigningJobResponseSchema, ...errorResponses },
    },
    handler: async (request) => {
      const agent = await resolveAgent(request);
      return agent.bound(async (tx) => {
        await tx`
          update signing_agents set last_seen_at = now() where id = ${agent.id}
        `;
        // The claim is a conditional update, so two kiosks — or one kiosk
        // restarted mid-poll — cannot both take the same request: the
        // second matches zero rows and is told there is nothing to do.
        // `skip locked` rather than a wait, because a poll that blocks is
        // a poll that times out.
        //
        // TWO KINDS OF ROW ARE CLAIMABLE, and the asymmetry in how they
        // read `expires_at` is the point (migration 0091, `expires_at`).
        // A PENDING request past its expiry is a lapsed authorisation:
        // nobody ever picked it up, ADR-0012 says it should be
        // re-reviewed, and it stays where it is. A CLAIMED request past
        // its expiry is an abandoned lease — a kiosk took it and died —
        // and leaving it there wedges the document forever, because the
        // partial unique index refuses any replacement request. So it is
        // offered again. Re-claiming is `claimed -> claimed`, which is
        // not a status change and rewinds nothing.
        const [claimed] = await tx<{ id: string }[]>`
          update signing_requests
          set status = 'claimed', claimed_at = now()
          where id = (
            select r.id from signing_requests r
            where r.signing_agent_id = ${agent.id}
              and (
                (r.status = 'pending' and r.expires_at > now())
                or (r.status = 'claimed' and r.expires_at <= now())
              )
            order by r.requested_at
            for update skip locked
            limit 1
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!claimed) return { job: null };
        const row = await readRow(tx, claimed.id);
        return {
          job: {
            requestId: row.id,
            documentType: row.document_type,
            documentNumber: row.document_number,
            sourceSha256: row.source_sha256,
            requestedByUserId: row.requested_by_user_id,
            requestedAt: row.requested_at.toISOString(),
            digest: Buffer.from(row.authorised_digest, 'hex').toString('base64'),
            certificateThumbprint: row.certificate_thumbprint,
          },
        };
      });
    },
  });

  app.route({
    method: 'POST',
    url: '/api/signing/agent/requests/:id/result',
    schema: {
      params: IdParamsSchema,
      body: SubmitSignatureSchema,
      response: { 200: SubmitSignatureResponseSchema, ...upstreamErrorResponses },
    },
    handler: async (request) => {
      const { id } = request.params;
      const body = request.body as
        | { signature: string; failureReason?: undefined }
        | { failureReason: string; signature?: undefined };

      const agent = await resolveAgent(request);

      /** Records why a signature was refused, then refuses. The failure
       * is written FIRST so the queue explains itself even though the
       * caller receives an error: a kiosk that retries into the same wall
       * must not leave the request looking like it is still being worked
       * on. */
      const fail = async (
        row: RequestRow,
        storedReason: string,
        refusal: Error,
      ): Promise<never> => {
        await agent.bound(async (tx) => {
          await tx`
            update signing_requests
            set status = 'failed', completed_at = now(),
                failure_reason = ${storedReason}
            where id = ${row.id} and status = 'claimed'
          `.catch(rethrowWriteRefusal);
          await audit(
            tx,
            agent.organisationId,
            row.requested_by_user_id,
            'signing_request.failed',
            'signing_requests',
            row.id,
            { reason: storedReason, agentId: agent.id },
          );
        });
        throw refusal;
      };

      // Read the authorisation and the certificate under the binding, let
      // go of the connection for the storage read and the arithmetic, then
      // come back to write. Assembling and verifying a PDF is pure CPU and
      // must not hold a pooled connection.
      const context = await agent.bound(async (tx) => ({
        row: await claimedRequest(tx, id, agent.id),
        chainPem: (
          await tx<{ certificate_chain_pem: string }[]>`
            select certificate_chain_pem from signing_agents where id = ${agent.id}
          `
        )[0]?.certificate_chain_pem,
      }));
      const { row } = context;

      // The kiosk reported a problem — a cancelled PIN dialog, a token
      // that is not plugged in. Recorded as a failure so the queue says
      // why it stopped instead of holding a claim until it lapses. It is
      // not an error for the caller: reporting a failure honestly is the
      // kiosk doing its job, and it is accepted even on a LAPSED claim,
      // because a kiosk that comes back after its lease ran out saying "I
      // could not do this" is the cheapest way the row ever terminates.
      if (body.signature === undefined) {
        return agent.bound(async (tx) => {
          await tx`
            update signing_requests
            set status = 'failed', completed_at = now(),
                failure_reason = ${body.failureReason.trim()}
            where id = ${row.id} and status = 'claimed'
          `.catch(rethrowWriteRefusal);
          await audit(
            tx,
            agent.organisationId,
            row.requested_by_user_id,
            'signing_request.failed',
            'signing_requests',
            row.id,
            { reason: body.failureReason.trim(), agentId: agent.id },
          );
          return { status: 'failed' as const, signedSha256: null };
        });
      }

      if (context.chainPem === undefined) throw agentUnauthenticated();

      // A SIGNATURE, unlike a failure report, needs a live lease. The
      // digest this kiosk holds was derived when the request was raised;
      // once the authorisation has lapsed, ADR-0012 says it is spent, and
      // the honest answer is to raise a new request so the digest is
      // re-derived against whatever the document says now. Terminal
      // rather than a bare refusal, so a kiosk that keeps retrying does
      // not re-wedge the row it was just re-offered.
      if (lapsed(row)) {
        return fail(
          row,
          'The authorisation lapsed before the kiosk returned a signature.',
          httpError(
            409,
            'SIGNING_REQUEST_EXPIRED',
            'This authorisation has lapsed; raise the signing request again.',
          ),
        );
      }

      // THE DOCUMENT IS STILL A DOCUMENT WE STAND BEHIND. Checked here as
      // well as at insert, because cancelling a challan does not change
      // the bytes of its render: the digest binding below would pass
      // cleanly and put the organisation's certificate on a document it
      // has withdrawn.
      if (!(await agent.bound((tx) => documentStillSignable(tx, row)))) {
        return fail(
          row,
          'The document left its issued state after this signature was authorised.',
          httpError(
            409,
            'SIGNING_DOCUMENT_NOT_RENDERED',
            'This document was cancelled after the signing request was raised, so it was not signed.',
          ),
        );
      }

      const signature = Buffer.from(body.signature, 'base64');
      const source = await storage.get(row.source_object_key);
      const preparation = prepareSafely(
        source,
        parseCertificateChain(context.chainPem),
        {
          signerName: row.signer_name,
          signingReason: row.signing_reason,
          signingLocation: row.signing_location,
          claimedSigningTime: row.claimed_signing_time,
        },
      );

      // THE BINDING, CHECKED. The digest covers everything — the bytes,
      // the certificate and the dictionary entries — so this one
      // comparison is the whole of ADR-0012's "verifies the
      // authorisation's hash against the bytes it is about to sign",
      // moved to the side of the wire that holds the record.
      if (
        preparation.sourceSha256 !== row.source_sha256 ||
        preparation.digest.toString('hex') !== row.authorised_digest
      ) {
        return fail(
          row,
          'The document changed after this signature was authorised, so the signature was refused.',
          httpError(
            409,
            'SIGNING_SOURCE_CHANGED',
            'The document was re-rendered after this request was raised, so the signature was refused; raise a new request against the current document.',
          ),
        );
      }

      // ASSEMBLY CAN THROW, AND THE TOKEN HAS ALREADY SIGNED. A CMS blob
      // larger than the `/Contents` reservation is the way it happens,
      // and an unhandled throw here is the worst outcome in the module: a
      // bare 500, no failure row, and a request stuck `claimed` with a
      // signature nobody can use. Registration pre-flights the chain so
      // this should be unreachable; it is caught anyway, because "should
      // be unreachable" is not a state to leave a wedge behind.
      let signed: Buffer;
      try {
        signed = finishDetachedPdfSignature(preparation, signature);
      } catch (error) {
        return fail(
          row,
          `The signature could not be embedded: ${error instanceof Error ? error.message : 'the document refused it'}.`,
          httpError(
            409,
            'SIGNED_OUTPUT_REJECTED',
            'The signature the kiosk produced could not be embedded in this document; register a kiosk whose certificate chain fits the signature reservation.',
          ),
        );
      }
      const verdict = verifyPdfSignatures(signed, {
        trustAnchors: pdfTrustAnchors,
        now: new Date(),
      });
      if (verdict.status !== 'signed_and_intact') {
        return fail(
          row,
          `The signed document did not verify (${verdict.status}).`,
          httpError(
            409,
            'SIGNED_OUTPUT_REJECTED',
            verdict.status === 'signed_chain_not_checked'
              ? 'The server holds no trust anchors, so it cannot confirm its own signature; install the CCA India root under AUTO_MB_PDF_TRUST_ANCHORS and retry.'
              : `The signature the kiosk produced verified as ${verdict.status} rather than signed_and_intact, so it was not stored.`,
          ),
        );
      }

      // A NEW KEY, ALWAYS. The unsigned render keeps its own, so the
      // document store holds both versions and the signature can still be
      // checked against the bytes it was computed over. Nothing is
      // overwritten in place.
      const signedSha256 = sha256Hex(signed);
      const signedKey = `${agent.organisationId}/sig/${randomUUID()}.pdf`;
      await storage.put(signedKey, signed);

      return agent.bound(async (tx) => {
        const updated = await tx`
          update signing_requests
          set status = 'signed', completed_at = now(),
              signed_object_key = ${signedKey}, signed_sha256 = ${signedSha256},
              signature_status = ${verdict.status},
              signature_verdict = ${tx.json(verdict as never)},
              signature_verified_at = now()
          where id = ${row.id} and status = 'claimed' and signing_agent_id = ${agent.id}
        `.catch(rethrowWriteRefusal);
        if (updated.count === 0) {
          // The request stopped being claimed while the PDF was assembled
          // — withdrawn, or its kiosk revoked. No audit row: the stored
          // object is not evidence of anything that happened.
          //
          // ponytail: the object stays on disk, unreferenced. Deleting it
          // here is the obvious fix and the wrong one — a delete on a
          // path this narrow is a delete nobody exercises, and the one
          // time it runs it will be against a key some other race has
          // just claimed. The upgrade path is a sweeper that reconciles
          // `<org>/sig/*` against `signing_requests.signed_object_key`,
          // which is the same shape the storage layer's orphan temp files
          // already need and should be built once for both.
          throw httpError(
            409,
            'SIGNING_REQUEST_STATE',
            'This request is no longer at the kiosk; the signature was discarded.',
          );
        }
        await audit(
          tx,
          agent.organisationId,
          row.requested_by_user_id,
          'signing_request.signed',
          'signing_requests',
          row.id,
          {
            signedSha256,
            certificateThumbprint: row.certificate_thumbprint,
            verdict: verdict.status,
            agentId: agent.id,
          },
        );
        return { status: 'signed' as const, signedSha256 };
      });
    },
  });
}

/* --- small shared readers -------------------------------------------------- */

/** `prepareDetachedPdfSignature`, with its structural refusals turned into
 * a named 409. A PDF this server cannot append a signature revision to is
 * a fact about the document, not a fault in the request. */
function prepareSafely(
  source: Buffer,
  chain: readonly X509Certificate[],
  facts: {
    readonly signerName: string;
    readonly signingReason: string;
    readonly signingLocation: string;
    readonly claimedSigningTime: Date;
  },
): PreparedPdfSignature {
  try {
    return prepare(source, chain, facts);
  } catch (error) {
    throw httpError(
      409,
      'SIGNING_DOCUMENT_NOT_RENDERED',
      `This PDF cannot carry a signature: ${error instanceof Error ? error.message : 'its structure could not be read'}.`,
    );
  }
}

async function readRow(tx: TransactionSql, id: string): Promise<RequestRow> {
  const [row] = await tx<RequestRow[]>`
    select ${tx.unsafe(REQUEST_COLUMNS)}
    from ${requestSource(tx)}
    where r.id = ${id}
  `;
  if (!row)
    throw httpError(404, 'SIGNING_REQUEST_NOT_FOUND', 'No such signing request.');
  return row;
}

async function lockRequest(tx: TransactionSql, id: string): Promise<RequestRow> {
  const [row] = await tx<RequestRow[]>`
    select ${tx.unsafe(REQUEST_COLUMNS)}
    from ${requestSource(tx)}
    where r.id = ${id}
    for no key update of r
  `;
  if (!row)
    throw httpError(404, 'SIGNING_REQUEST_NOT_FOUND', 'No such signing request.');
  return row;
}

/** True once the lease on a claim has run out. See migration 0091's
 * `expires_at` comment: the same instant is the authorisation's expiry
 * while a request is pending and the claim's lease once a kiosk holds it,
 * because a kiosk that crashed mid-signature and an authorisation nobody
 * acted on are the same problem — a row nothing will ever revisit. */
function lapsed(row: RequestRow): boolean {
  return row.expires_at.getTime() <= Date.now();
}

/**
 * The one request a kiosk is allowed to answer for: its own, and claimed.
 *
 * A LAPSED claim is still returned, and the distinction is the caller's to
 * act on — which is why this returns the row rather than throwing on it.
 * A kiosk whose lease ran out mid-PIN must still be able to say "I could
 * not sign this", or the row wedges and the operator is left guessing. It
 * must NOT be able to submit a signature, because the digest it holds was
 * derived against bytes that are now a week old. The result route makes
 * exactly that split.
 */
async function claimedRequest(
  tx: TransactionSql,
  id: string,
  agentId: string,
): Promise<RequestRow> {
  const row = await lockRequest(tx, id);
  if (row.signing_agent_id !== agentId) {
    throw httpError(
      404,
      'SIGNING_REQUEST_NOT_FOUND',
      'No such signing request for this kiosk.',
    );
  }
  if (row.status !== 'claimed') {
    throw httpError(
      409,
      'SIGNING_REQUEST_STATE',
      'This signing request is not at the kiosk.',
    );
  }
  return row;
}

/**
 * Whether the document a request names is still in the state that admitted
 * it, checked again at the moment the signature would land.
 *
 * The insert guard checks this once, and once is not enough: cancelling a
 * challan does not change the bytes of its render, so the digest binding
 * passes cleanly and the organisation's certificate goes onto a document
 * it has withdrawn. The binding answers "are these the authorised bytes";
 * only this answers "is this still a document we stand behind".
 */
async function documentStillSignable(
  tx: TransactionSql,
  row: RequestRow,
): Promise<boolean> {
  if (row.delivery_challan_id !== null) {
    const [challan] = await tx<{ status: string }[]>`
      select status from delivery_challans where id = ${row.delivery_challan_id}
    `;
    return challan?.status === 'issued';
  }
  const [invoice] = await tx<{ status: string }[]>`
    select status from tax_invoices where id = ${row.tax_invoice_id}
  `;
  return invoice?.status === 'submitted';
}

async function readOne(tx: TransactionSql, id: string): Promise<SigningRequest> {
  const [row] = await tx<RequestRow[]>`
    select ${tx.unsafe(REQUEST_COLUMNS)}
    from ${requestSource(tx)}
    where r.id = ${id}
  `;
  if (!row)
    throw httpError(404, 'SIGNING_REQUEST_NOT_FOUND', 'No such signing request.');
  return toRequest(row);
}
