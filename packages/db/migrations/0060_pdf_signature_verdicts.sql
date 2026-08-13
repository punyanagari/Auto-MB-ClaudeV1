SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0060: digital-signature verdicts for inbound railway PDFs.
--
-- Indian Railways issues variation statements, Measurement Book copies,
-- tax invoices, bill copies and agreements as digitally signed PDFs. The
-- owner asked for signature validation across all of them, so the verdict
-- is stored as EVIDENCE beside the document it describes, not derived on
-- demand: the trust anchors installed on this server, the verifier's
-- rules, and the certificates' validity windows all move over time, so a
-- verdict recomputed next year is a different statement from the one made
-- when the document was accepted. Both are worth having; only the one
-- taken at upload time is a record of what the organisation relied on.
--
-- Where it lands. `loa_documents` already holds BOTH inbound PDF kinds —
-- the LOA itself and the contract-source documents attached to it
-- (migration 0040 added `document_kind` rather than a second table) — so
-- one pair of columns here covers every inbound PDF that exists on main
-- today. The variation-order attachment in flight on another branch, and
-- the MB-copy / tax-invoice / bill-copy verification the owner named
-- next, add their own columns of the same shape against the same
-- server-side function; nothing about this migration is LOA-specific.
--
-- Why real columns rather than audit JSON: migration 0045 settled that
-- operational provenance belongs in constrained tenant data, not in
-- `audit_events.details`. The status is a constrained column a query can
-- filter and a CHECK can police; the full verdict rides beside it as
-- jsonb because its shape is the verifier's contract
-- (`packages/contracts/src/pdf-signature.ts`), not this schema's.
--
-- Numbering note: 0058 and 0059 are deliberately skipped — 0058 is
-- reserved by the variation-order branch in flight and 0059 by the
-- residue pack. The migration runner keys strictly on the four-digit id
-- (packages/db/src/migration-runner.ts refuses duplicates and hash/rename
-- drift but never requires contiguity), so the gaps are safe and either
-- can land in any order. 0052 and 0057 set the same precedent.

-- ---------------------------------------------------------------------
-- 1. The verdict columns.

ALTER TABLE loa_documents
  ADD COLUMN signature_status text NOT NULL DEFAULT 'not_checked',
  ADD COLUMN signature_verdict jsonb,
  ADD COLUMN signature_verified_at timestamptz;

-- `not_checked` is the whole point of the default, and it is not a
-- synonym for `unsigned`.
--
-- Every row that exists when this migration runs was uploaded before the
-- verifier did, so nothing is known about its signatures. Defaulting to
-- `unsigned` would manufacture a claim about thousands of documents that
-- no one ever examined — the same mistake migration 0053 refused when it
-- separated `registered_unverified` from `registered`. A reviewer looking
-- at a pre-existing LOA must be told "this was never checked", and can
-- then re-upload it if the answer matters.
ALTER TABLE loa_documents
  ADD CONSTRAINT loa_documents_signature_status_check
  CHECK (signature_status IN (
    'not_checked',
    'unsigned',
    'signed_and_intact',
    'signed_but_untrusted_chain',
    'signed_chain_expired',
    'signed_chain_not_checked',
    'signed_but_modified_after_signing',
    'signature_invalid',
    'signature_unverifiable'
  ));

-- The three columns state one fact together, so they move together: a
-- checked document has a verdict and a time, an unchecked one has
-- neither. Without this a row could claim `signed_and_intact` with no
-- evidence behind it.
ALTER TABLE loa_documents
  ADD CONSTRAINT loa_documents_signature_shape_check
  CHECK (
    (
      signature_status = 'not_checked'
      AND signature_verdict IS NULL
      AND signature_verified_at IS NULL
    )
    OR
    (
      signature_status <> 'not_checked'
      AND jsonb_typeof(signature_verdict) = 'object'
      AND signature_verified_at IS NOT NULL
    )
  );

COMMENT ON COLUMN loa_documents.signature_status IS
  'Document-level digital-signature verdict taken at upload time. not_checked means no verification was performed (rows predating migration 0060); it is never a claim that the document is unsigned.';
COMMENT ON COLUMN loa_documents.signature_verdict IS
  'Full structured verdict (packages/contracts/src/pdf-signature.ts): per-signature signer identity, integrity, chain, coverage, revocation posture, and the verifier version that produced it.';
COMMENT ON COLUMN loa_documents.signature_verified_at IS
  'When the stored verdict was computed. Trust anchors and certificate validity move, so a verdict is only interpretable with its instant.';

-- Finding the documents that need a human: the partial index carries only
-- the rows that are not the green state, which is the query the review
-- surfaces actually run.
CREATE INDEX loa_documents_signature_attention_idx
  ON loa_documents (organisation_id, signature_status, created_at DESC, id)
  WHERE signature_status <> 'signed_and_intact';

-- ---------------------------------------------------------------------
-- 2. Append-once.
--
-- A verdict is a statement about bytes that are themselves immutable (the
-- 0040 guard already refuses any change to object_key, sha256 or
-- size_bytes). Letting the verdict be rewritten would let an inconvenient
-- `signature_invalid` be edited away while the document it describes
-- stayed exactly as it was, which is the one thing evidence must not
-- permit. Re-verifying later is legitimate, but it produces a NEW
-- statement at a new time; when that surface exists it will append rows
-- to a history table, not overwrite this one.
--
-- The single permitted transition is the backfill one: `not_checked` to a
-- real verdict, so a document uploaded before 0060 can be verified once
-- without being re-uploaded.

CREATE FUNCTION app_private.guard_document_signature_verdict()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.signature_status = 'not_checked' THEN
    RETURN NEW;
  END IF;

  IF ROW(NEW.signature_status, NEW.signature_verdict, NEW.signature_verified_at)
     IS DISTINCT FROM
     ROW(OLD.signature_status, OLD.signature_verdict, OLD.signature_verified_at)
  THEN
    RAISE EXCEPTION
      'a stored digital-signature verdict is append-once and cannot be rewritten';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER loa_documents_signature_verdict_guard
BEFORE UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_document_signature_verdict();
