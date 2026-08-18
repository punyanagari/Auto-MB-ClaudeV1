SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0091: the signing queue — a request to put the organisation's
-- own digital signature on a document it has already issued, and the
-- kiosk credential that fulfils one.
--
-- ADR-0012 settled outbound signing as TWO LANES BEHIND ONE WORKFLOW:
-- Aadhaar eSign by default, and a kiosk-held Class 3 DSC by exception,
-- for the document classes where a counterparty mandates the
-- organisation's own certificate. This migration builds the workflow and
-- the kiosk lane. The eSign lane is gated on ESP onboarding and is not
-- built; what is built for it is the `channel` column and nothing else,
-- because a second lane that arrives to find the model already shaped for
-- it is a route file, and one that arrives to find a single-lane model is
-- a migration.
--
-- TWO TABLES.
--
--   signing_agents    the kiosk's credential and its pinned certificate
--   signing_requests  one document, one authorisation, one outcome
--
-- ---------------------------------------------------------------------
-- WHY THE KIOSK IS NOT A WINDOWS SERVICE, WHICH ADR-0012 ASSUMED.
--
-- ADR-0012 § "Lane 2" describes "a dedicated machine in a private
-- location, running a headless Windows service", polling outbound. The
-- outbound-only polling stands and is what this schema is built for. The
-- headless service does not, and the reason is a property of the hardware
-- rather than a preference:
--
--   The token's PIN dialog is drawn by the driver onto the desktop of an
--   INTERACTIVE session. A process launched from a service context has no
--   such desktop, so the dialog has nowhere to appear and the signing call
--   blocks forever rather than failing.
--
-- Verified against the owner's HYPERSECU HYP2003 (e-Mudhra Class 3, KSP
-- "HyperPKI HYP2003 KSP India v3") on 2026-08-17. The consequence is
-- recorded here because it changes the security argument, not only the
-- deployment: ADR-0012 accepted the kiosk lane's risk on the basis that
-- an unattended token "with its PIN cached for the service session" is a
-- signing oracle, and required the phone approval to be bound to the
-- bytes as the mitigation. A token that CANNOT be driven without a person
-- at that desktop is a weaker oracle than the ADR feared — but only
-- weaker, not absent, because PIN caching within one interactive session
-- is real. So the binding below is built in full anyway. It costs a
-- column.
--
-- ---------------------------------------------------------------------
-- THE AUTHORISATION IS A DIGEST, AND THE DIGEST IS RE-DERIVED.
--
-- This is the load-bearing rule of the whole feature and it is worth
-- stating before the columns that carry it.
--
-- A signing request stores `authorised_digest`: the SHA-256 of the CMS
-- signed attributes for THIS document, prepared at the moment the request
-- was raised. That digest is the only thing the token is ever asked to
-- sign. When the signature comes back, the server rebuilds the whole
-- preparation from the stored source bytes and refuses unless the digest
-- it derives is the digest it stored.
--
-- What that buys, concretely. `POST /api/challans/:id/render` writes its
-- PDF to `<org>/dc/<id>.pdf` — the SAME key — every time it runs. A
-- re-render while a request is pending therefore changes the bytes under
-- it. Without the re-derivation the token would sign a document nobody
-- reviewed; with it, the request fails with a named refusal and the
-- operator raises a new one against the new bytes. `source_sha256` makes
-- the same fact legible to a human before it is legible to the guard.
--
-- ADR-0012 § "The approval is the authority, and it must be bound to the
-- bytes" asks for four things: the signer sees the hash before approving
-- (the queue screen and the kiosk's own console print it), the
-- authorisation carries hash, document, identity and expiry (the columns
-- below), the fulfiller verifies it against the bytes (the re-derivation),
-- and each authorisation is single-use (the state machine: only a
-- `claimed` row may be completed, and completion is terminal).
--
-- ---------------------------------------------------------------------
-- WHAT IS NOT HERE.
--
-- No signed PDF in the database. The signed bytes go to object storage
-- under a fresh tenant-prefixed UUID key and the row records the key and
-- the SHA-256. The unsigned render is NOT overwritten: it keeps its own
-- key, so the document store holds both versions and the signature can be
-- checked against the thing it was computed over. An issued document's
-- bytes are never edited in place, which is rule 7 of AGENTS.md applied
-- to a file rather than to a row.
--
-- No numbering. A signing request is not a document the organisation
-- issues to anyone; it is an internal instruction. It has no series, no
-- gap-free sequence and no cancelled-number rule, and inventing one would
-- be numbering ceremony for a row nobody outside the organisation reads.
--
-- No new membership authority column. ADR-0012 says raising and approving
-- are distinct permissions, and the distinction was drawn for the eSign
-- lane, where approval is a separate act performed from a phone by the
-- signer. The kiosk lane has no such act: the person who fulfils the
-- request is the person standing at the token typing the PIN, and the
-- server cannot see them. So raising a request carries the existing
-- `issue` authority — signing an issued document is an act of the same
-- authority that issued it — and registering the kiosk is owner-only.
-- When the eSign lane lands and approval becomes a real server-side act,
-- it brings its own authority with it and this note is the record of why
-- it did not arrive early.

-- ---------------------------------------------------------------------
-- 1. The kiosk credential.
--
-- The agent authenticates with a bearer token, not a member's password.
-- Only its SHA-256 is stored: a token is a password-equivalent, and the
-- machine that holds it sits in a room this server has no control over.
-- The plaintext exists exactly once, in the response to the registration
-- call, and is never recoverable — losing it means registering a new
-- agent, which is the correct cost.
--
-- THE CERTIFICATE IS PINNED BY THUMBPRINT, and the pin is not decoration.
-- Selecting a signing certificate by subject name is the classic mistake
-- of this integration: a Windows certificate store routinely holds
-- several certificates for one person — an expired one, a renewal, a test
-- issue — with byte-identical subjects, and "the one whose CN matches"
-- silently picks whichever the enumeration returned first. The thumbprint
-- names exactly one certificate. The agent selects by it, and the server
-- checks the signature it gets back against the certificate it pinned, so
-- the wrong token in the wrong slot is a refusal rather than a signature
-- nobody expected.
--
-- The chain travels with the pin (`certificate_chain_pem`). This
-- product's verifier builds paths offline with no AIA chasing and no
-- egress, so a chain that is not stored is a chain nothing can check —
-- and an organisation restored from an export has to be able to prove
-- what signed its documents years after the token expired.
-- ---------------------------------------------------------------------
CREATE TABLE signing_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  label text NOT NULL CHECK (
    btrim(label) = label AND length(label) BETWEEN 1 AND 120
  ),

  -- SHA-256 of the bearer token, lowercase hex. Never the token.
  -- 0065's domain, not a hand-rolled CHECK: a digest column that spells
  -- its own shape is a digest column that drifts.
  token_hash sha256_hex NOT NULL,

  -- SHA-1 of the certificate's DER encoding, uppercase hex: the value
  -- Windows, certutil and the MMC snap-in all call the thumbprint. An
  -- identifier, not a security decision — the security decision is made
  -- over the whole chain by the signature verifier — and it is this
  -- spelling so that an operator can compare the screen with their own
  -- certificate store.
  certificate_thumbprint text NOT NULL
    CHECK (certificate_thumbprint ~ '^[0-9A-F]{40}$'),
  certificate_subject text NOT NULL CHECK (btrim(certificate_subject) <> ''),
  certificate_serial text NOT NULL CHECK (certificate_serial ~ '^[0-9A-F]+$'),
  certificate_not_after timestamptz NOT NULL,
  -- Signer first, then every issuer up to the root, PEM concatenated.
  certificate_chain_pem text NOT NULL
    CHECK (certificate_chain_pem LIKE '-----BEGIN CERTIFICATE-----%'),

  -- The member the agent acts as. Every tenant read and write the agent
  -- causes runs in a transaction bound to THIS user, through the same
  -- `app_private.bind_tenant` membership floor every browser request
  -- passes, so an agent whose operator loses their membership stops
  -- working — without anyone having to remember to revoke it.
  operator_user_id text NOT NULL,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id text,

  UNIQUE (organisation_id, id),
  -- Globally unique, not per organisation: the token is resolved BEFORE
  -- any tenant is bound, so it has to name one row in the cluster. The
  -- value is the hash of a 256-bit server-generated secret, so this
  -- constraint is never the thing that fails.
  UNIQUE (token_hash),
  CONSTRAINT signing_agents_revocation_shape CHECK (
    (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
  )
);

COMMENT ON TABLE signing_agents IS
  'A kiosk signing agent: the scoped bearer credential it authenticates with, the certificate it is pinned to by thumbprint, and the member whose membership bounds everything it may reach. Registered by an owner, revocable, and never in possession of anything but a 32-byte digest at a time.';
COMMENT ON COLUMN signing_agents.token_hash IS
  'SHA-256 of the bearer token. The token itself is returned once, at registration, and is never stored, logged or recoverable.';
COMMENT ON COLUMN signing_agents.certificate_thumbprint IS
  'SHA-1 of the certificate DER, uppercase hex — the Windows thumbprint. The agent selects its key by this and nothing else; subject-name matching picks the wrong certificate whenever a store holds a renewal beside an expiry.';
COMMENT ON COLUMN signing_agents.operator_user_id IS
  'The member the agent acts as. Its membership is re-proved by app_private.bind_tenant on every request, so revoking the person revokes the kiosk.';

ALTER TABLE signing_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_agents FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY signing_agents_tenant_policy ON signing_agents
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: an agent is the answer to "what signed this document, and
-- with whose credential", and a signature outlives the credential that
-- made it. Revocation is a timestamp, not a removal.
GRANT SELECT, INSERT, UPDATE ON signing_agents TO auto_mb_app;

-- The definer role reads this table through app_private.resolve_signing_agent
-- below. BYPASSRLS lifts the POLICY, not the table privilege, so the
-- grant is separate and is SELECT only — the resolver reads and the
-- application role writes. Migration 0004 grants the same role the same
-- way for organisation_memberships, which current_organisation_id() reads.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT ON signing_agents TO auto_mb_definer;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Resolving a bearer token, before any tenant exists.
--
-- The chicken and egg every non-session credential has: the request
-- carries a token, the token names an organisation, and the organisation
-- is what RLS needs before the row holding the token can be read.
--
-- Solved the way `app_private.bind_tenant` solves the membership floor —
-- one SECURITY DEFINER function, owned by the BYPASSRLS definer role,
-- answering exactly one question and returning exactly the three values
-- the caller needs to open a properly bound transaction. It takes a
-- 64-hex digest and returns at most one row; there is no predicate a
-- caller can widen, no enumeration, and nothing about the certificate,
-- the label or the organisation's other agents comes back.
--
-- STABLE, not VOLATILE: it is a pure read. `last_seen_at` is maintained
-- afterwards by an ordinary tenant-bound UPDATE, so the audit of when a
-- kiosk last polled is written under RLS like everything else rather than
-- by a definer function nobody can see into.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.resolve_signing_agent(p_token_hash text)
RETURNS TABLE (agent_id uuid, organisation_id uuid, operator_user_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
  SELECT a.id, a.organisation_id, a.operator_user_id
  FROM signing_agents a
  WHERE a.token_hash = p_token_hash
    AND a.revoked_at IS NULL
$$;

ALTER FUNCTION app_private.resolve_signing_agent(text) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.resolve_signing_agent(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.resolve_signing_agent(text) TO auto_mb_app;
  END IF;
END
$$;

COMMENT ON FUNCTION app_private.resolve_signing_agent(text) IS
  'The one read that crosses tenancy for the kiosk lane: a token hash in, the agent, its organisation and its operator out, or nothing. Everything the agent then does runs inside app_private.bind_tenant under that operator, so this widens the reachable set by exactly one row.';

-- The key the signing queue's three-column reference needs.
-- `delivery_challans` has published `UNIQUE (organisation_id, id,
-- work_id)` since 0001; `tax_invoices` has not, and gains it here for the
-- same reason: it is the constraint that makes a copied `work_id`
-- unfalsifiable rather than merely conventional. Redundant as a
-- uniqueness claim — `(organisation_id, id)` is already unique — and that
-- is precisely why it is safe to add: it can refuse no row that exists.
ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_organisation_id_id_work_id_key
  UNIQUE (organisation_id, id, work_id);

-- ---------------------------------------------------------------------
-- 3. The queue.
--
-- FIVE STATES, and the shape CHECKs bind each one to the columns it is
-- allowed to have filled:
--
--   pending    raised, waiting for a kiosk to claim it
--   claimed    a kiosk has it and the operator is at the PIN dialog
--   signed     terminal, and the only state carrying signed bytes
--   failed     terminal, carrying the reason
--   cancelled  terminal, withdrawn by the organisation
--
-- `claimed` exists rather than going straight from pending to signed
-- because the gap is a human at a dialog and can be minutes long. Without
-- it, two kiosks — or one kiosk restarted mid-signature — race for the
-- same request; with it, the claim is an atomic conditional update and
-- the loser sees nothing to do.
--
-- WHY THE DOCUMENT IS A TYPED PAIR OF NULLABLE KEYS rather than a
-- (type, id) pair with no constraint. The same reason 0087's movements
-- name their source document that way: a foreign key that only exists
-- when the type column happens to say the right thing is not a foreign
-- key. Two nullable columns with real composite tenant references, and a
-- CHECK binding exactly one of them to the declared type, give the
-- database the same picture the application has. Payroll documents join
-- as a third arm when the payroll module has issued documents to sign.
-- ---------------------------------------------------------------------
CREATE TABLE signing_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  document_type text NOT NULL CHECK (
    document_type IN ('delivery_challan', 'tax_invoice')
  ),
  delivery_challan_id uuid,
  tax_invoice_id uuid,

  -- The Work the document belongs to.
  --
  -- A COPY, and one that cannot drift, which is the only reason it is
  -- here. Both composite foreign keys below carry it — a challan is
  -- referenced as (organisation, id, work) against a key
  -- `delivery_challans` already publishes, and the invoice gains the same
  -- key in this migration — so the database refuses a row whose work_id
  -- is not the document's own. 0087's rule against a second copy of a
  -- fact ("a second thing that can be wrong") is satisfied by making it a
  -- thing that cannot be.
  --
  -- What it buys is work-scope. A member scoped to their assignments must
  -- not see that a Work they cannot reach has documents being signed, and
  -- the register's cursor must be proven against the same predicate its
  -- rows are (`pagination.ts` § workScopedCursorRowId, and the oracle it
  -- exists to close). Both need `work_id` on the row rather than two
  -- joins away through a union of two registers.
  work_id uuid NOT NULL,

  -- ADR-0012's two lanes. Only 'kiosk_dsc' is reachable today; the route
  -- that would write 'esign' does not exist. The value is here so that
  -- the register, the export and every screen already say WHICH
  -- certificate signed a document, which is the question an operator asks
  -- once two lanes exist and cannot ask retrospectively.
  channel text NOT NULL DEFAULT 'kiosk_dsc' CHECK (channel IN ('kiosk_dsc', 'esign')),

  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'signed', 'failed', 'cancelled')
  ),

  -- The bytes this request authorises, named and fingerprinted. The key
  -- carries the tenant prefix migration 0003 requires of every stored
  -- object, checked here as well because a signing request is the one
  -- place a key is copied from another table rather than minted.
  source_object_key text NOT NULL CHECK (
    source_object_key LIKE organisation_id::text || '/%'
  ),
  source_sha256 sha256_hex NOT NULL,

  -- The single-use authorisation: SHA-256 of the CMS signed attributes
  -- prepared over the source above. Re-derived at completion and refused
  -- on mismatch; see the header.
  authorised_digest sha256_hex NOT NULL,

  -- The signature dictionary's own entries, fixed when the request is
  -- raised. They are INSIDE the signed bytes, so the preparation is only
  -- reproducible if they are stored rather than recomputed from a clock.
  claimed_signing_time timestamptz NOT NULL,
  signer_name text NOT NULL CHECK (
    btrim(signer_name) = signer_name AND length(signer_name) BETWEEN 1 AND 120
  ),
  signing_reason text NOT NULL CHECK (
    btrim(signing_reason) = signing_reason AND length(signing_reason) BETWEEN 1 AND 200
  ),
  signing_location text NOT NULL CHECK (
    btrim(signing_location) = signing_location
    AND length(signing_location) BETWEEN 1 AND 120
  ),

  expires_at timestamptz NOT NULL,

  -- The kiosk this request is FOR, bound when it is raised rather than
  -- when it is claimed, and the reason is the digest above.
  -- `signing-certificate-v2` puts the signer's certificate INSIDE the
  -- signed attributes, so the digest cannot be computed until the
  -- certificate is known — and ADR-0012 wants the authorisation to exist,
  -- complete, before anything is asked to sign. Binding at raise gives
  -- both: one row that names the bytes, the certificate and the digest
  -- over them, written once and consumable once.
  signing_agent_id uuid NOT NULL,
  -- The certificate the digest was prepared for, copied from the agent so
  -- the authorisation stays readable after the agent is revoked and its
  -- certificate replaced.
  certificate_thumbprint text NOT NULL
    CHECK (certificate_thumbprint ~ '^[0-9A-F]{40}$'),

  -- The outcome.
  signed_object_key text CHECK (
    signed_object_key IS NULL
    OR signed_object_key LIKE organisation_id::text || '/%'
  ),
  signed_sha256 sha256_hex,

  -- Migration 0060's evidence shape, the third consumer of it. The
  -- difference from the other two is the direction: they record a verdict
  -- about a document somebody sent us, and this records a verdict about a
  -- document we produced. The server refuses to store bytes whose verdict
  -- is anything but `signed_and_intact`, so unlike an inbound upload this
  -- column is a receipt rather than a warning — but it is stored in the
  -- same shape and the same words, because "what did the verifier say"
  -- must have one answer across the product.
  signature_status text NOT NULL DEFAULT 'not_checked' CHECK (
    signature_status IN (
      'not_checked', 'unsigned', 'signed_and_intact', 'signed_chain_not_checked',
      'signed_chain_expired', 'signed_but_untrusted_chain',
      'signed_but_modified_after_signing', 'signature_invalid',
      'signature_unverifiable'
    )
  ),
  signature_verdict jsonb,
  signature_verified_at timestamptz,

  failure_reason text CHECK (
    failure_reason IS NULL
    OR (btrim(failure_reason) = failure_reason AND length(failure_reason) BETWEEN 1 AND 500)
  ),

  requested_by_user_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  -- Three-column references, so `work_id` is the DOCUMENT'S Work by
  -- construction rather than by the route remembering to copy the right
  -- one.
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id)
    REFERENCES delivery_challans (organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, tax_invoice_id, work_id)
    REFERENCES tax_invoices (organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, signing_agent_id)
    REFERENCES signing_agents (organisation_id, id),

  CONSTRAINT signing_requests_document_shape CHECK (
    CASE document_type
      WHEN 'delivery_challan' THEN delivery_challan_id IS NOT NULL AND tax_invoice_id IS NULL
      WHEN 'tax_invoice' THEN tax_invoice_id IS NOT NULL AND delivery_challan_id IS NULL
      ELSE false
    END
  ),
  -- Signed bytes exist exactly when the request is signed, and every
  -- other terminal state carries its reason instead. A row can never be
  -- half an outcome.
  CONSTRAINT signing_requests_outcome_shape CHECK (
    CASE status
      WHEN 'signed' THEN
        signed_object_key IS NOT NULL AND signed_sha256 IS NOT NULL
        AND signature_verified_at IS NOT NULL
        AND completed_at IS NOT NULL AND failure_reason IS NULL
        AND signature_status = 'signed_and_intact'
      WHEN 'failed' THEN
        signed_object_key IS NULL AND signed_sha256 IS NULL
        AND completed_at IS NOT NULL AND failure_reason IS NOT NULL
      WHEN 'cancelled' THEN
        signed_object_key IS NULL AND signed_sha256 IS NULL
        AND completed_at IS NOT NULL AND failure_reason IS NOT NULL
      ELSE
        signed_object_key IS NULL AND signed_sha256 IS NULL
        AND signature_verified_at IS NULL
        AND completed_at IS NULL AND failure_reason IS NULL
        AND signature_status = 'not_checked'
    END
  ),
  -- When a kiosk had it, and when it never did. `cancelled` is reachable
  -- only from `pending`, so a withdrawn request was never at a kiosk;
  -- `failed` is reachable from both — the kiosk reporting a cancelled PIN
  -- dialog, and a revocation killing a request nobody had picked up yet —
  -- so it is the one state that admits either.
  CONSTRAINT signing_requests_claim_shape CHECK (
    CASE status
      WHEN 'pending' THEN claimed_at IS NULL
      WHEN 'cancelled' THEN claimed_at IS NULL
      WHEN 'failed' THEN true
      ELSE claimed_at IS NOT NULL
    END
  )
);

COMMENT ON TABLE signing_requests IS
  'One instruction to sign one issued document with the organisation''s own certificate, and the outcome. The row IS the authorisation ADR-0012 requires: it names the bytes, carries the digest the token is asked to sign, expires, and is consumable exactly once.';
COMMENT ON COLUMN signing_requests.authorised_digest IS
  'SHA-256 of the CMS signed attributes prepared over source_object_key''s bytes. The only value the token ever sees, and the value the completion path re-derives and compares — a document re-rendered under a pending request fails here rather than being signed unreviewed.';
COMMENT ON COLUMN signing_requests.claimed_signing_time IS
  'The /M entry of the signature dictionary, fixed when the request is raised. Stored rather than taken from the clock at completion because it is inside the signed bytes: a preparation that is not reproducible cannot be re-derived, and the re-derivation is the integrity check.';
COMMENT ON COLUMN signing_requests.channel IS
  'ADR-0012''s lane. Only kiosk_dsc is reachable; eSign is gated on ESP onboarding. Recorded from the first row so that "which certificate signed this" is answerable once both lanes run.';
COMMENT ON CONSTRAINT signing_requests_outcome_shape ON signing_requests IS
  'Signed bytes exist exactly when the request is signed, and only against a signed_and_intact verdict. A row can never be half an outcome.';

-- ONE OPEN REQUEST PER DOCUMENT, per lane. Two live requests against one
-- challan would have two authorised digests over the same bytes, and
-- whichever came back second would sign a document the other had already
-- signed — producing two "the" signed copies and no answer to which is
-- the record. The same rule as one open DC draft per Work, for the same
-- reason. Terminal rows are excluded, so a failed attempt can be retried.
CREATE UNIQUE INDEX signing_requests_one_open_per_challan
  ON signing_requests (organisation_id, delivery_challan_id)
  WHERE delivery_challan_id IS NOT NULL AND status IN ('pending', 'claimed');
CREATE UNIQUE INDEX signing_requests_one_open_per_invoice
  ON signing_requests (organisation_id, tax_invoice_id)
  WHERE tax_invoice_id IS NOT NULL AND status IN ('pending', 'claimed');

-- The foreign keys' leading indexes, NON-partial: referential integrity
-- cannot use a partial one (`test/fk-index-coverage.integration.test.ts`),
-- and the two unique indexes above are partial.
CREATE INDEX signing_requests_challan_idx
  ON signing_requests (organisation_id, delivery_challan_id);
CREATE INDEX signing_requests_invoice_idx
  ON signing_requests (organisation_id, tax_invoice_id);
CREATE INDEX signing_requests_agent_idx
  ON signing_requests (organisation_id, signing_agent_id);
CREATE INDEX signing_requests_work_idx
  ON signing_requests (organisation_id, work_id);

-- The queue screen: newest first, keyset-seekable. `requested_at` alone
-- ties whenever two documents are raised in one click, so the id closes
-- the key and gives the seek a total order.
CREATE INDEX signing_requests_register_idx
  ON signing_requests (organisation_id, requested_at DESC, id DESC);

-- What a kiosk polls for: the oldest unexpired pending request. Partial,
-- because the queue is almost entirely history and the claim query is the
-- one statement that runs every few seconds forever.
CREATE INDEX signing_requests_claimable_idx
  ON signing_requests (organisation_id, requested_at)
  WHERE status = 'pending';

ALTER TABLE signing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY signing_requests_tenant_policy ON signing_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. A signature on an issued document is a record of an act: it
-- states that on a date, under a certificate, this organisation put its
-- name to those exact bytes. A request that was raised in error is
-- cancelled with a reason, which leaves both the mistake and the
-- correction on the record — the posture the audit trail (0002), the
-- tender status trail (0083) and the stock ledger (0087) all hold.
GRANT SELECT, INSERT, UPDATE ON signing_requests TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The write guards.
--
-- Every rule below is also checked by the route, first, under no lock, so
-- an operator gets a named 409 with a remedy. These are the arm that
-- holds when a writer reaches the table another way, and the arm that
-- holds under concurrency, which the route cannot.
--
-- SQLSTATEs come from the 23J block, one per rule. (`I` is skipped in this
-- schema's block allocation: `23I0…` reads as a digit at a glance and the
-- one thing an operator does with a SQLSTATE is read it aloud.)
--
-- `SET search_path` for the reason 0067, 0077, 0079, 0084 and 0087 all
-- give: a function that resolves its own identifiers through the caller's
-- path is a rule a shadowing object in a writable schema can rewrite into
-- whatever it likes. Not SECURITY DEFINER: every table touched is one the
-- caller may already read under RLS, and a definer function here would
-- read across tenants.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_signing_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A request may only be raised against a document that has actually
    -- been issued. Signing a draft would put the organisation's
    -- certificate on bytes it is still free to change.
    IF NEW.delivery_challan_id IS NOT NULL THEN
      SELECT c.status INTO document_status
      FROM delivery_challans c
      WHERE c.organisation_id = NEW.organisation_id AND c.id = NEW.delivery_challan_id;
    ELSE
      SELECT i.status INTO document_status
      FROM tax_invoices i
      WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.tax_invoice_id;
    END IF;

    IF document_status IS NULL OR document_status NOT IN ('issued', 'submitted') THEN
      RAISE EXCEPTION
        'a signing request may only be raised against an issued document (this one is %)',
        coalesce(document_status, 'missing')
        USING ERRCODE = '23J03';
    END IF;

    IF NEW.expires_at <= NEW.requested_at THEN
      RAISE EXCEPTION 'a signing request must expire after it was raised'
        USING ERRCODE = '23J01';
    END IF;

    -- The kiosk has to be usable at the moment the authorisation is
    -- written, and the certificate the digest was prepared for has to be
    -- that kiosk's. A request pinned to a thumbprint no agent holds is
    -- one the token can never satisfy.
    IF NOT EXISTS (
      SELECT 1 FROM signing_agents a
      WHERE a.organisation_id = NEW.organisation_id
        AND a.id = NEW.signing_agent_id
        AND a.revoked_at IS NULL
        AND a.certificate_thumbprint = NEW.certificate_thumbprint
    ) THEN
      RAISE EXCEPTION
        'signing agent % is revoked, or does not hold certificate %',
        NEW.signing_agent_id, NEW.certificate_thumbprint
        USING ERRCODE = '23J04';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE from here down.

  -- The authorisation is frozen. Everything a signature is computed over,
  -- and everything that says which document it is about, is written once.
  -- The list is exhaustive on purpose: the denylist shape of a ROW guard
  -- means a column left out of it is silently editable, which is what
  -- `issued-immutability-coverage.integration.test.ts` exists to catch.
  IF ROW(
       NEW.id, NEW.organisation_id, NEW.document_type, NEW.delivery_challan_id,
       NEW.tax_invoice_id, NEW.work_id,
       NEW.channel, NEW.source_object_key, NEW.source_sha256,
       NEW.authorised_digest, NEW.claimed_signing_time, NEW.signer_name,
       NEW.signing_reason, NEW.signing_location, NEW.expires_at,
       NEW.signing_agent_id, NEW.certificate_thumbprint,
       NEW.requested_by_user_id, NEW.requested_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.organisation_id, OLD.document_type, OLD.delivery_challan_id,
       OLD.tax_invoice_id, OLD.work_id,
       OLD.channel, OLD.source_object_key, OLD.source_sha256,
       OLD.authorised_digest, OLD.claimed_signing_time, OLD.signer_name,
       OLD.signing_reason, OLD.signing_location, OLD.expires_at,
       OLD.signing_agent_id, OLD.certificate_thumbprint,
       OLD.requested_by_user_id, OLD.requested_at
     ) THEN
    RAISE EXCEPTION
      'the authorised facts of a signing request are written once and never change'
      USING ERRCODE = '23J02';
  END IF;

  -- Terminal is terminal. A signed request in particular: its outcome is
  -- the evidence, and evidence that can be rewritten is not evidence.
  IF OLD.status IN ('signed', 'failed', 'cancelled')
     AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION
      'signing request % is already % and cannot change again', OLD.id, OLD.status
      USING ERRCODE = '23J01';
  END IF;

  -- The state machine, stated once. pending -> claimed -> {signed,
  -- failed}, and pending -> cancelled. Nothing goes backwards, and a
  -- claimed request is never released back to the queue: the token may
  -- already have produced a signature the server has not seen yet, and a
  -- request returned to pending could then be signed twice.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('claimed', 'cancelled'))
      OR (OLD.status = 'claimed' AND NEW.status IN ('signed', 'failed'))
    ) THEN
      RAISE EXCEPTION
        'a signing request cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = '23J01';
    END IF;
  END IF;

  -- A claim, and a signature, only happen while the kiosk is still
  -- usable. The route checks the same thing; this is the arm that holds
  -- when a revocation commits between the two — which is precisely the
  -- moment it matters, because revoking a kiosk has to stop the signature
  -- that is in flight and not only the next one.
  IF NEW.status IN ('claimed', 'signed')
     AND NEW.status <> OLD.status
     AND EXISTS (
       SELECT 1 FROM signing_agents a
       WHERE a.organisation_id = NEW.organisation_id
         AND a.id = NEW.signing_agent_id
         AND a.revoked_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'signing agent % is revoked', NEW.signing_agent_id
      USING ERRCODE = '23J04';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_signing_request() IS
  'Everything a signing request is allowed to be: raised only against an issued document, its authorised facts frozen, its states walked forwards only, and terminal rows immutable. The route makes each refusal first so an operator gets a remedy; this is the arm that holds under concurrency and against a writer that arrives another way.';

CREATE TRIGGER signing_requests_guard
BEFORE INSERT OR UPDATE ON signing_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_signing_request();

CREATE FUNCTION app_private.guard_signing_agent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A credential's identity is written once. Rotating a token or
  -- swapping a certificate is registering a new agent, so that every
  -- signature already made stays attributable to the exact credential
  -- that made it.
  IF ROW(
       NEW.id, NEW.organisation_id, NEW.label, NEW.token_hash,
       NEW.certificate_thumbprint, NEW.certificate_subject,
       NEW.certificate_serial, NEW.certificate_not_after,
       NEW.certificate_chain_pem, NEW.operator_user_id,
       NEW.created_by_user_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.organisation_id, OLD.label, OLD.token_hash,
       OLD.certificate_thumbprint, OLD.certificate_subject,
       OLD.certificate_serial, OLD.certificate_not_after,
       OLD.certificate_chain_pem, OLD.operator_user_id,
       OLD.created_by_user_id, OLD.created_at
     ) THEN
    RAISE EXCEPTION
      'a signing agent''s credential and certificate are written once; register a new agent instead'
      USING ERRCODE = '23J05';
  END IF;

  -- Revocation is one way. A credential that could be un-revoked is a
  -- credential whose revocation is a suggestion.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a revoked signing agent cannot be restored'
      USING ERRCODE = '23J05';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_signing_agent() IS
  'A kiosk credential is written once and revoked once. Rotating a token or a certificate registers a new agent, so every signature stays attributable to the exact credential that produced it.';

CREATE TRIGGER signing_agents_guard
BEFORE UPDATE ON signing_agents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_signing_agent();
