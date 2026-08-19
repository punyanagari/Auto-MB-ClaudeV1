SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0110: the Issue Challan joins the signing lane.
--
-- Owner ruling, live-testing corrections item 16. Migration 0091 built the
-- queue for the two outward documents that existed when ADR-0012 was
-- written — the Delivery Challan and the tax invoice — and named the shape
-- a third arm would take: "Payroll documents join as a third arm when the
-- payroll module has issued documents to sign." The Issue Challan got
-- there first, and for the plainer reason: it is material leaving the
-- agency's custody under the agency's own name, it renders a PDF already
-- (`issue_challans.rendered_object_key`, migration 0014), and the
-- counterparty who signs for it is the same kind of counterparty who
-- signs for a delivery.
--
-- NOTHING NEW IS INVENTED HERE. Every mechanism 0091 built is reused
-- verbatim and the diff is deliberately boring:
--
--   * a nullable `issue_challan_id`, with the same three-column composite
--     foreign key its siblings carry, against a key `issue_challans` has
--     published since 0014 (`UNIQUE (organisation_id, id, work_id)`) — so
--     unlike `tax_invoices`, which had to gain that key in 0091, this arm
--     costs no new constraint on the referenced register;
--   * the same partial unique index, so one open request per document;
--   * the same non-partial index beside it, because a referential check
--     cannot use a partial one;
--   * the same shape CHECK, extended to three arms rather than replaced
--     by a looser one;
--   * the same guard, restated with a third branch.
--
-- The digest binding, the lease, the state machine, the outcome CHECK,
-- the authority and the kiosk model are all untouched. An Issue Challan is
-- signed by exactly the machinery a Delivery Challan is signed by, which
-- is the whole point of the item: an operator should not have to learn a
-- second story for the sibling document.
--
-- WHY `issued` AND NOT ALSO `cancelled`. The guard's existing arm admits
-- `('issued', 'submitted')` — a challan that has been issued and an
-- invoice that has been submitted, which are the two registers' words for
-- "this left the building". `issue_challans.status` uses `issued` for the
-- same state, so the arm needs no new vocabulary. A cancelled Issue
-- Challan is refused here exactly as a cancelled Delivery Challan is, and
-- `documentStillSignable` in `routes/signing.ts` re-asks the question at
-- the moment the signature would land, because cancelling a challan does
-- not change the bytes of its render.

ALTER TABLE signing_requests
  ADD COLUMN issue_challan_id uuid;

COMMENT ON COLUMN signing_requests.issue_challan_id IS
  'The Issue Challan this request signs, when document_type says so (0110). One of three mutually exclusive document arms, each a real composite foreign key rather than an unenforceable (type, id) pair.';

-- The declared type gains its third value. Stated as a drop-and-add of
-- the column CHECK rather than a new constraint beside it: two CHECKs
-- naming the same column is how a vocabulary ends up with two authorities
-- and a reader has to intersect them.
ALTER TABLE signing_requests
  DROP CONSTRAINT signing_requests_document_type_check;
ALTER TABLE signing_requests
  ADD CONSTRAINT signing_requests_document_type_check CHECK (
    document_type IN ('delivery_challan', 'issue_challan', 'tax_invoice')
  );

-- EXACTLY ONE ARM IS FILLED, and it is the one the type declares. The
-- CHECK is restated in full for 0091's own reason: a shape constraint
-- written as a CASE has to enumerate every arm, and an arm left out is
-- silently permitted rather than loudly missing.
ALTER TABLE signing_requests
  DROP CONSTRAINT signing_requests_document_shape;
ALTER TABLE signing_requests
  ADD CONSTRAINT signing_requests_document_shape CHECK (
    CASE document_type
      WHEN 'delivery_challan' THEN
        delivery_challan_id IS NOT NULL
        AND issue_challan_id IS NULL AND tax_invoice_id IS NULL
      WHEN 'issue_challan' THEN
        issue_challan_id IS NOT NULL
        AND delivery_challan_id IS NULL AND tax_invoice_id IS NULL
      WHEN 'tax_invoice' THEN
        tax_invoice_id IS NOT NULL
        AND delivery_challan_id IS NULL AND issue_challan_id IS NULL
      ELSE false
    END
  );

-- The three-column reference, so the denormalised `work_id` is the
-- DOCUMENT'S Work by construction. `issue_challans` has published
-- `UNIQUE (organisation_id, id, work_id)` since 0014.
ALTER TABLE signing_requests
  ADD CONSTRAINT signing_requests_issue_challan_fk
  FOREIGN KEY (organisation_id, issue_challan_id, work_id)
  REFERENCES issue_challans (organisation_id, id, work_id);

-- ONE OPEN REQUEST PER DOCUMENT, the third copy of 0091's rule. Two live
-- requests against one challan would have two authorised digests over the
-- same bytes and produce two "the" signed copies with no answer to which
-- is the record.
CREATE UNIQUE INDEX signing_requests_one_open_per_issue_challan
  ON signing_requests (organisation_id, issue_challan_id)
  WHERE issue_challan_id IS NOT NULL AND status IN ('pending', 'claimed');

-- The foreign key's leading index, NON-partial: referential integrity
-- cannot use a partial index, and the unique index above is partial.
-- `test/fk-index-coverage.integration.test.ts` measures exactly this.
CREATE INDEX signing_requests_issue_challan_idx
  ON signing_requests (organisation_id, issue_challan_id);

-- ---------------------------------------------------------------------
-- The guard, restated.
--
-- House style for a guard function is to restate the CURRENT body rather
-- than patch it, and the discipline that makes that safe is to restate
-- what is installed rather than what the original migration wrote. What
-- follows is 0091's body verbatim with two changes and nothing else:
--
--   1. the INSERT branch's document lookup becomes three-way, so an
--      Issue Challan is checked against its own register's `issued`
--      state rather than falling through to the tax-invoice arm — which
--      is what an `ELSE` would have done, silently, against a NULL id;
--   2. `issue_challan_id` joins the frozen ROW. The denylist shape of a
--      ROW guard means a column left out of it is silently editable,
--      which is what `issued-immutability-coverage.integration.test.ts`
--      exists to catch, and a signing request that could be re-pointed at
--      a different document after its digest was authorised is the one
--      edit this table must never admit.
--
-- The SQLSTATEs stay in 0091's 23J block. This migration adds no rule, so
-- it needs no code of its own — a third arm of an existing refusal that
-- raised a new SQLSTATE would mean `routes/signing.ts` had to map two
-- codes to one message.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_signing_request()
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
    ELSIF NEW.issue_challan_id IS NOT NULL THEN
      SELECT t.status INTO document_status
      FROM issue_challans t
      WHERE t.organisation_id = NEW.organisation_id AND t.id = NEW.issue_challan_id;
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
       NEW.issue_challan_id, NEW.tax_invoice_id, NEW.work_id,
       NEW.channel, NEW.source_object_key, NEW.source_sha256,
       NEW.authorised_digest, NEW.claimed_signing_time, NEW.signer_name,
       NEW.signing_reason, NEW.signing_location, NEW.expires_at,
       NEW.signing_agent_id, NEW.certificate_thumbprint,
       NEW.requested_by_user_id, NEW.requested_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.organisation_id, OLD.document_type, OLD.delivery_challan_id,
       OLD.issue_challan_id, OLD.tax_invoice_id, OLD.work_id,
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

  -- The state machine, stated once:
  --
  --   pending -> claimed | cancelled | failed
  --   claimed ->          cancelled | failed | signed
  --
  -- Nothing goes backwards, and in particular a claimed request is never
  -- released to `pending`: the token may already have produced a
  -- signature the server has not seen yet, and a request returned to the
  -- queue could then be signed twice. The kiosk picks an EXPIRED claim
  -- back up by claiming it again — `claimed -> claimed` is not a status
  -- change and does not reach this branch — rather than by any rewind.
  --
  -- `pending -> failed` is here because a revocation kills the requests
  -- the revoked kiosk was raised for, and most of those have never been
  -- picked up. Without it, revoking a kiosk holding one pending request
  -- raises 23J01 inside the revoke transaction and rolls the revocation
  -- itself back — the credential stays live because a request it can
  -- never fulfil exists. The outcome CHECK and the claim-shape CHECK both
  -- already admit a failure that was never claimed; this is the third arm
  -- agreeing with them.
  --
  -- `claimed -> cancelled` is the operator's exit from a LEASE THAT
  -- LAPSED (see 0091's `expires_at`). Only the route can tell a live
  -- claim from a dead one, because only the route knows the clock it is
  -- comparing against; what this arm guarantees is that the door exists
  -- at all. Without it the partial unique index blocks the document
  -- forever.
  --
  -- Both doors are 0091's and both are unchanged. The reasoning is
  -- restated rather than referenced because a CREATE OR REPLACE states
  -- the whole body: a reader of this file sees the arms and nothing
  -- about why they are there, and "look in 0091" is a footnote that
  -- stops being followed the first time the two files disagree.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('claimed', 'cancelled', 'failed'))
      OR (OLD.status = 'claimed' AND NEW.status IN ('signed', 'failed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'a signing request cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = '23J01';
    END IF;
  END IF;

  -- A claim, and a signature, only happen while the kiosk is still
  -- usable. The route checks the same thing; this is the arm that holds
  -- when a revocation commits between the two.
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
  'Everything a signing request is allowed to be: raised only against an issued document — a Delivery Challan, an Issue Challan or a tax invoice — its authorised facts frozen, its states walked forwards only, and terminal rows immutable. The route makes each refusal first so an operator gets a remedy; this is the arm that holds under concurrency and against a writer that arrives another way.';
