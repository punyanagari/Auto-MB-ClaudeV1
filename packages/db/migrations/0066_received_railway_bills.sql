SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0066: the received railway bill.
--
-- Every document this product has modelled so far is one the agency
-- WRITES: the delivery challan, the issue challan, the Measurement Book,
-- the tax invoice, the bill it prepares. The railway's On-Account Bill is
-- the one it only ever RECEIVES — IWRCMS produces it from the Measurement
-- Book, three people sign it, and it comes back as a PDF. Both reviews of
-- 2026-08-13 named its absence the first adoption blocker, because it is
-- the document that says the railway agreed, and nothing in the product
-- could record that fact.
--
-- WHAT THE BILL IS FOR HERE. Two gates, and no third:
--
--   1. A finalized Measurement Book is CLOSED by the railway bill that
--      settles it. Until that bill arrives and verifies, the measurement
--      is outstanding with the railway however complete our own paperwork
--      looks.
--   2. A prepared bill may not be marked PAID unless its Measurement Book
--      is closed. Recording money as received is the act that must not
--      rest on an unverified document.
--
-- Both gates are enforced in the route AND here, because recurring finding
-- 2 of the improvement programme is that this repository enforces security
-- twice and money once.
--
-- The second layer is not a copy of the first, and it is worth being exact
-- about the split rather than saying "twice" and leaving a reader to
-- assume. The database enforces the STRUCTURAL half — that the closing
-- bill exists, is this organisation's, settles THIS book, is not
-- discarded, carries a settleable stored verdict and at least three
-- signatures; and that a bill cannot become `paid`, on insert or update,
-- while its book is open. The per-signature RULING — integrity, reaching a
-- configured anchor, three DISTINCT signing certificates (owner ruling,
-- 2026-08-14), the last signature covering the file — lives once, in
-- `apps/server/src/railway-bill-verdict.ts`, because it is the owner's
-- judgement rather than a fact about the schema and is the kind of thing
-- that gets revisited. `docs/PRODUCT.md` §5.5 states the same split in the
-- same terms.
--
-- WHY A NEW TABLE RATHER THAN A loa_documents DOCUMENT KIND. The pack row
-- proposed reusing `loa_documents`, and the machinery IS reused — the same
-- ObjectStorage boundary, the same magic-byte gate, the same malware scan,
-- the same Poppler-only extraction, the same append-once signature verdict
-- and the same RLS posture. The ROW lives here, for the reason migration
-- 0058 already recorded when it made the same call for variation orders:
-- `loa_documents_source_shape_check` (0040) requires every non-'loa' kind
-- to hang off a parent LOA row and carry a `matched` tender identity, and
-- a railway bill has neither — it arrives long after award, it is not
-- tender evidence, and a Work that reached the product by import has no
-- parent LOA row at all. Reusing that table would mean a fourth branch in
-- its shape CHECK, a kind-dependent parent lookup in its trigger, and an
-- exclusion added to every existing reader of the intake package.
--
-- Migration 0060 anticipated exactly this and said so: "the MB-copy /
-- tax-invoice / bill-copy verification the owner named next add their own
-- columns of the same shape against the same server-side function". This
-- is that migration, and it reuses `app_private.guard_document_signature_verdict`
-- verbatim rather than writing a second one.
--
-- Numbering note: 0066 lands after 0070 was already applied. The runner
-- keys strictly on the four-digit id and never requires contiguity
-- (`packages/db/src/migration-runner.ts`); 0052, 0057, 0060 and 0070 set
-- the same precedent.

-- ---------------------------------------------------------------------
-- 1. The bill.
--
-- Every identifying column here is EXTRACTED from the uploaded PDF by
-- `apps/server/src/railway-bill-parse.ts`, never typed by an operator —
-- the same truth-source discipline migration 0058 applied to variation
-- orders and `loa-extracted-values.ts` applies to the letter. There is no
-- field below for anyone to assert. A bill number somebody typed is a
-- claim; one found in the bill's own text layer is a fact, and this table
-- stores only the second kind.
-- ---------------------------------------------------------------------
CREATE TABLE received_railway_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- The Measurement Book this bill settles. The link is made by
  -- MEASUREMENT SEQUENCE, not by string equality, and the reason is
  -- recorded in the settlement corpus: the book prints
  -- `.../OAM/L2/01` and the bill raised from it prints `.../OAM/FL2/01`.
  -- The `L2` -> `FL2` change marks the ledger as finalised; it is not a
  -- different measurement and not an error. Matching on the raw string
  -- silently fails to link every pair, and a link that never happens
  -- reports nothing.
  measurement_book_id uuid NOT NULL,

  -- The stored PDF, on the same terms as every other inbound document.
  object_key text NOT NULL,
  original_filename text NOT NULL,
  sha256 sha256_hex NOT NULL,
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),

  -- What the bill says.
  bill_number text NOT NULL CHECK (
    btrim(bill_number) = bill_number
    AND length(bill_number) BETWEEN 1 AND 200
  ),
  bill_date date NOT NULL,
  -- GST-INCLUSIVE, always. This figure equals the tax invoice's GRAND
  -- total and never its taxable value — the property `docs/PRODUCT.md`
  -- §5.2 states and the settlement corpus demonstrates on all three
  -- bills. Any comparison against a contract value goes through
  -- `executed-value.ts` with the basis named; nothing divides by 1.18.
  bill_amount money_amount NOT NULL CHECK (bill_amount > 0),
  -- The bill's own declaration, "Rate is inclusive of GST: Yes". This is
  -- the evidence behind `works.gst_basis` (migration 0062), which the
  -- award letter is silent about and this document is not.
  rate_inclusive_of_gst boolean NOT NULL,

  measurement_number text NOT NULL,
  measurement_sequence integer NOT NULL CHECK (measurement_sequence >= 1),
  agreement_number text,
  letter_number text NOT NULL,

  -- The whole parse, kept as evidence of what was read and by what rules,
  -- for the same reason a signature verdict is stored rather than
  -- recomputed: the parser moves, and a re-read next year is a different
  -- statement from the one the organisation relied on.
  extraction_payload jsonb NOT NULL
    CHECK (jsonb_typeof(extraction_payload) = 'object'),

  -- ---- The signature verdict, in the 0060 shape ----
  signature_status text NOT NULL DEFAULT 'not_checked',
  signature_verdict jsonb,
  signature_verified_at timestamptz,

  uploaded_by_user_id text NOT NULL,

  -- A bill attached to the wrong book has to have an exit, and there is no
  -- DELETE grant on this table. Discard is that exit: the row and its
  -- bytes stay, and the partial unique index below stops counting it.
  discarded_at timestamptz,
  discarded_by_user_id text,
  discard_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, object_key),

  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, measurement_book_id)
    REFERENCES measurement_books(organisation_id, id),

  -- Object keys are `<org>/<area>/<name>.<ext>` and the tenant prefix is
  -- checked here as well as in `storage.ts`, exactly as 0003 does for
  -- loa_documents. Two layers, because a path is a filesystem escape.
  CONSTRAINT received_railway_bills_object_key_tenant_prefix_check
    CHECK (object_key LIKE organisation_id::text || '/%'),

  -- The 0060 statuses, restated. `not_checked` is not a synonym for
  -- `unsigned`: one says nobody looked, the other says somebody looked and
  -- found nothing to look at.
  CONSTRAINT received_railway_bills_signature_status_check
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
    )),
  CONSTRAINT received_railway_bills_signature_shape_check
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
    ),

  -- Discard travels as one fact: who, when, and optionally why.
  CONSTRAINT received_railway_bills_discard_shape_check
    CHECK (
      (
        discarded_at IS NULL
        AND discarded_by_user_id IS NULL
        AND discard_reason IS NULL
      )
      OR
      (
        discarded_at IS NOT NULL
        AND discarded_by_user_id IS NOT NULL
        AND (
          discard_reason IS NULL
          OR length(btrim(discard_reason)) BETWEEN 3 AND 500
        )
      )
    )
);

COMMENT ON TABLE received_railway_bills IS
  'An IWRCMS On-Account Bill received from the railway against a finalized Measurement Book. Every identifying column is extracted from the PDF, never typed.';
COMMENT ON COLUMN received_railway_bills.measurement_sequence IS
  'The on-account measurement sequence read off the bill. This is what links the bill to a Measurement Book: the book spells the ledger L2 and the bill spells it FL2, so the strings differ while the measurement is the same.';
COMMENT ON COLUMN received_railway_bills.bill_amount IS
  'The bill total INCLUDING GST, as the bill prints it. Equal to the tax invoice grand total, never to its taxable value.';
COMMENT ON COLUMN received_railway_bills.signature_status IS
  'Document-level digital-signature verdict taken at upload time, in the migration 0060 vocabulary. Settlement requires signed_and_intact or signed_chain_expired; see apps/server/src/railway-bill-verdict.ts for the owner ruling behind that pair.';

-- One live bill per Measurement Book. The railway raises exactly one
-- On-Account Bill per measurement; a second live one would mean the link
-- is wrong, and closure would have two amounts to believe.
CREATE UNIQUE INDEX received_railway_bills_one_live_per_book
  ON received_railway_bills (organisation_id, measurement_book_id)
  WHERE discarded_at IS NULL;

-- A railway bill number is unique within its Work. Uploading the same
-- bill twice is the mistake this catches.
CREATE UNIQUE INDEX received_railway_bills_number_per_work
  ON received_railway_bills (organisation_id, work_id, bill_number)
  WHERE discarded_at IS NULL;

CREATE UNIQUE INDEX received_railway_bills_object_key_unique
  ON received_railway_bills (object_key);

CREATE INDEX received_railway_bills_work_idx
  ON received_railway_bills (organisation_id, work_id, bill_date DESC, id);

-- The Measurement Book foreign key's own index. The partial unique above
-- leads on the same columns but a partial index cannot serve a foreign
-- key's referential check — which is a cascade or a parent delete
-- scanning the child table, and does not know about `discarded_at`. The
-- FK-index census in packages/db/test measures exactly this.
CREATE INDEX received_railway_bills_book_idx
  ON received_railway_bills (organisation_id, measurement_book_id);

-- The rows that need a human, which is the query the review surface runs.
CREATE INDEX received_railway_bills_signature_attention_idx
  ON received_railway_bills (organisation_id, signature_status, created_at DESC, id)
  WHERE signature_status <> 'signed_and_intact';

ALTER TABLE received_railway_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE received_railway_bills FORCE ROW LEVEL SECURITY;

-- ADR-0010 (accepted 2026-08-13) settles the FORM of a tenant policy: the
-- helper call is wrapped in a scalar subquery so the planner treats it as
-- an InitPlan and evaluates it once per statement rather than once per
-- row. Semantically identical to the bare call; measurably cheaper in
-- filter position. New policies are authored this way from the start.
CREATE POLICY received_railway_bills_tenant_policy ON received_railway_bills
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Evidence never leaves. Discard is the only exit, as for loa_documents.
GRANT SELECT, INSERT, UPDATE ON received_railway_bills TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 2. The bill's bytes and facts are immutable; discard is terminal.
--
-- The same posture as `app_private.guard_contract_source_document` takes
-- for an uploaded document. Nothing extracted may be edited afterwards,
-- because the point of extracting it was that nobody gets to assert it.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_received_railway_bill_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a discarded received railway bill is immutable';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.measurement_book_id,
    NEW.object_key, NEW.original_filename, NEW.sha256, NEW.media_type,
    NEW.size_bytes, NEW.bill_number, NEW.bill_date, NEW.bill_amount,
    NEW.rate_inclusive_of_gst, NEW.measurement_number,
    NEW.measurement_sequence, NEW.agreement_number, NEW.letter_number,
    NEW.extraction_payload, NEW.uploaded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.measurement_book_id,
    OLD.object_key, OLD.original_filename, OLD.sha256, OLD.media_type,
    OLD.size_bytes, OLD.bill_number, OLD.bill_date, OLD.bill_amount,
    OLD.rate_inclusive_of_gst, OLD.measurement_number,
    OLD.measurement_sequence, OLD.agreement_number, OLD.letter_number,
    OLD.extraction_payload, OLD.uploaded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'a received railway bill''s bytes and extracted facts are immutable';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER received_railway_bills_immutability_guard
BEFORE UPDATE ON received_railway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_received_railway_bill_update();

-- Migration 0060's function, unchanged and reused: a stored verdict is
-- append-once, and the only permitted transition is `not_checked` to a
-- real verdict. 0060 said the next document type would attach its own
-- columns to this same function rather than write a second one; this is
-- that attachment.
CREATE TRIGGER received_railway_bills_signature_verdict_guard
BEFORE UPDATE ON received_railway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_document_signature_verdict();

CREATE TRIGGER received_railway_bills_touch_updated_at
BEFORE UPDATE ON received_railway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. Measurement Book closure.
--
-- "Closed" is a loaded word on this table already: migration 0035 uses it
-- for "a live tax invoice bills this book, so it can no longer be
-- cancelled". That is an invoice fact. This is a RAILWAY fact — the
-- railway has issued and signed the bill that settles the measurement —
-- and the two are independent: a measurement can be invoiced before its
-- railway bill arrives, and the settlement corpus shows exactly that
-- (INV-1 is dated 09/05/2026 against a bill dated 11/05/2026).
--
-- So closure is recorded in its own columns and does NOT become a fifth
-- `status` value. A new status would collide with three constraints
-- (`measurement_books_status_shape`, `measurement_books_kind_status_coherence`,
-- and 0034's own CHECK) and with the forward-only transition rule, to say
-- something orthogonal to what `status` means.
-- ---------------------------------------------------------------------
ALTER TABLE measurement_books
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by_user_id text,
  ADD COLUMN closed_by_received_bill_id uuid;

ALTER TABLE measurement_books
  ADD CONSTRAINT measurement_books_closure_shape_check
  CHECK (
    (
      closed_at IS NULL
      AND closed_by_user_id IS NULL
      AND closed_by_received_bill_id IS NULL
    )
    OR
    (
      closed_at IS NOT NULL
      AND closed_by_user_id IS NOT NULL
      AND closed_by_received_bill_id IS NOT NULL
      -- Only a finalized book can be closed. A draft has no measurement
      -- the railway could have billed, and a cancelled one was withdrawn.
      AND status = 'finalized'
    )
  ),
  ADD CONSTRAINT measurement_books_closing_bill_fk
  FOREIGN KEY (organisation_id, closed_by_received_bill_id)
  REFERENCES received_railway_bills(organisation_id, id);

COMMENT ON COLUMN measurement_books.closed_at IS
  'When the railway bill settling this measurement was accepted. Distinct from migration 0035''s invoice-close guard, which is about a live tax invoice; a book can be invoiced before its railway bill arrives.';

CREATE INDEX measurement_books_open_idx
  ON measurement_books (organisation_id, work_id, sequence_number)
  WHERE status = 'finalized' AND closed_at IS NULL;

-- The closing bill's foreign key, indexed from the child side. This is
-- the query the discard route runs ("did this bill close anything?") as
-- well as the referential check, and the FK-index census requires a
-- non-partial index leading on the referencing columns.
CREATE INDEX measurement_books_closing_bill_idx
  ON measurement_books (organisation_id, closed_by_received_bill_id);

-- Migration 0036's guard, restated with the closure rules added.
--
-- Restating rather than patching is this repository's house style for a
-- guard function, and the discipline that makes it safe is to restate the
-- CURRENT body rather than the one the original migration installed. What
-- follows is 0036 verbatim — which is itself 0032's body with `kind` in
-- the frozen ROW in place of the generated `is_final`, plus the
-- bill-lock, newest-only and completed-Work cancel rules — with two new
-- clauses about closure. Nothing else about it moves.
--
-- The trap 0036 documented is worth repeating here because it is invisible
-- and it bites anyone who reaches for 0024's copy: `is_final` is GENERATED
-- ALWAYS, PostgreSQL leaves generated columns NULL in a BEFORE trigger's
-- NEW row, and freezing NEW.is_final therefore refuses every legitimate
-- update of a finalized book.
CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Measurement Books are immutable';
  END IF;

  -- NEW in 0066. Closure is append-once, like the signature verdict it
  -- rests on: reopening a closed book would let an inconvenient railway
  -- bill be detached from the measurement it settled while the bill
  -- itself stayed exactly as it was.
  IF OLD.closed_at IS NOT NULL AND ROW(
    NEW.closed_at, NEW.closed_by_user_id, NEW.closed_by_received_bill_id
  ) IS DISTINCT FROM ROW(
    OLD.closed_at, OLD.closed_by_user_id, OLD.closed_by_received_bill_id
  ) THEN
    RAISE EXCEPTION 'a closed Measurement Book cannot be reopened or re-closed';
  END IF;

  -- NEW in 0066. Cancelling a closed book would strand a settled railway
  -- bill against a withdrawn measurement.
  IF OLD.closed_at IS NOT NULL AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION
      'a Measurement Book closed by a railway bill cannot be cancelled'
      USING ERRCODE = 'check_violation';
  END IF;

  -- NEW in 0066. What the closing bill has to BE.
  --
  -- The shape CHECK on this table only says the three columns move
  -- together and that the book is finalized. That is not the claim the
  -- header and `docs/PRODUCT.md` §5.5 make, which is that closure is
  -- enforced twice. So the structural half of the gate is enforced here,
  -- against the bill row itself, and a writer that never went through the
  -- route gets the same answer:
  --
  --   * the bill exists and belongs to THIS organisation and THIS book;
  --   * it is not discarded;
  --   * its stored document verdict is one of the two settleable ones;
  --   * it carries at least the three signatures an accepted bill has.
  --
  -- What is deliberately NOT duplicated here: the per-signature predicate
  -- — integrity, reaching a configured anchor, distinct signing
  -- certificates, and the last signature covering the file. That is the
  -- OWNER'S RULING rather than a structural fact, it is the kind of thing
  -- that gets revisited (the distinct-signer clause is itself an extension
  -- the owner ruled on a day later, on 2026-08-14), and a ruling that
  -- lives in two languages drifts between them. It lives once, in
  -- `apps/server/src/railway-bill-verdict.ts`. The split is stated in
  -- exactly these words in §5.5, so the two-layer claim is true of what
  -- each layer actually does.
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    DECLARE
      bill received_railway_bills%ROWTYPE;
    BEGIN
      SELECT * INTO bill FROM received_railway_bills
      WHERE id = NEW.closed_by_received_bill_id
        AND organisation_id = NEW.organisation_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Measurement Book % cannot close: no railway bill % in this organisation',
          NEW.id, NEW.closed_by_received_bill_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.measurement_book_id <> NEW.id THEN
        RAISE EXCEPTION
          'railway bill % settles a different measurement and cannot close Measurement Book %',
          bill.id, NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.discarded_at IS NOT NULL THEN
        RAISE EXCEPTION
          'railway bill % is discarded and cannot close a Measurement Book', bill.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.signature_status NOT IN ('signed_and_intact', 'signed_chain_expired') THEN
        RAISE EXCEPTION
          'railway bill % has signature verdict % and cannot close a Measurement Book',
          bill.id, bill.signature_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF coalesce(
           jsonb_array_length(bill.signature_verdict -> 'signatures'), 0
         ) < 3 THEN
        RAISE EXCEPTION
          'railway bill % carries fewer than the three signatures an accepted On-Account Bill has',
          bill.id
          USING ERRCODE = 'check_violation';
      END IF;
    END;
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status NOT IN ('finalized', 'cancelled') THEN
      RAISE EXCEPTION 'finalized Measurement Books may only remain finalized or be cancelled';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.kind, NEW.mb_date,
      NEW.mb_number, NEW.sequence_number, NEW.total_amount,
      NEW.remark_template_version, NEW.created_by_user_id,
      NEW.finalized_by_user_id, NEW.created_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.kind, OLD.mb_date,
      OLD.mb_number, OLD.sequence_number, OLD.total_amount,
      OLD.remark_template_version, OLD.created_by_user_id,
      OLD.finalized_by_user_id, OLD.created_at, OLD.finalized_at
    ) THEN
      RAISE EXCEPTION 'finalized Measurement Book business data is immutable';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF EXISTS (
        SELECT 1 FROM bills b
        WHERE b.organisation_id = OLD.organisation_id AND b.mb_id = OLD.id
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % has a prepared bill and is permanently locked; corrections happen as compensating entries on a subsequent MB',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM measurement_books newer
        WHERE newer.organisation_id = OLD.organisation_id
          AND newer.work_id = OLD.work_id
          AND newer.status = 'finalized'
          AND newer.sequence_number > OLD.sequence_number
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % is not the newest live Measurement Book of its Work; only the newest may be cancelled',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Measurement Books are deleted, not cancelled';
  END IF;

  -- R8 (0032): cancelling releases this book's claimed sources, so a
  -- completed Work must be reopened first.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = OLD.organisation_id
        AND w.id = OLD.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a Measurement Book'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 4. The money backstop: a bill is not paid until the railway has settled
--    the measurement behind it.
--
-- The route refuses this too. Both, deliberately: the improvement
-- programme's recurring finding 2 is that this repository enforces
-- security twice and money once, and "the taxable value is enforced in
-- exactly one layer (route), unlike every security control (two)" is the
-- specific complaint. A money rule that exists only in a handler is one
-- forgotten import away from being no rule.
--
-- The gate is deliberately CLOSED for a bill with no Measurement Book.
-- Since ADR-0006 there has been exactly one statement in the codebase that
-- inserts a bill (`routes/measurement-books/finalize.ts`) and it always
-- sets `mb_id`; a bill without one could only predate migration 0024. It
-- is better that such a row needs an explicit migration than that the rule
-- has a hole nobody is watching.
-- ---------------------------------------------------------------------
-- INSERT as well as UPDATE. The 0006 status CHECK admits
-- `status IN ('prepared','submitted','paid')` on a fresh row, so a bill
-- can be BORN paid, and an UPDATE-only guard would watch the door while
-- the window stood open. `TG_OP` is what makes the OLD reference safe:
-- there is no OLD row on an insert, and reading one raises.
CREATE FUNCTION app_private.guard_bill_paid_needs_closed_book()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  book_closed_at timestamptz;
BEGIN
  IF NEW.status <> 'paid' THEN
    RETURN NEW;
  END IF;
  -- An already-paid row being updated for some other reason is not the
  -- transition this guards; only the move INTO paid is.
  IF TG_OP = 'UPDATE' AND OLD.status = 'paid' THEN
    RETURN NEW;
  END IF;

  SELECT closed_at INTO book_closed_at
  FROM measurement_books
  WHERE id = NEW.mb_id AND organisation_id = NEW.organisation_id;

  IF book_closed_at IS NULL THEN
    RAISE EXCEPTION
      'bill % cannot be marked paid: its Measurement Book is not closed by a verified railway bill',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER bills_paid_needs_closed_book_guard
BEFORE INSERT OR UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_paid_needs_closed_book();
