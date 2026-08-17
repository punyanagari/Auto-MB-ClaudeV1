SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0079: the company document library.
--
-- Every document this product models so far belongs to a Work: the LOA
-- that awarded it, the challans that move goods against it, the bills
-- that claim money for it. The documents an agency is asked for most
-- often belong to no Work at all. GST registration, PAN, the partnership
-- deed, an ISO certificate, a bank solvency letter, last year's balance
-- sheet, a completion certificate from a railway three contracts ago —
-- these are facts about the COMPANY, they are demanded again by every
-- tender, every inspection and half the correspondence, and today they
-- live in somebody's laptop folder and are re-scanned when they cannot be
-- found.
--
-- So this is a library rather than a document type: uploaded once, kept
-- versioned, carrying its own validity window, and consumed by name from
-- wherever it is needed.
--
-- WHY TWO TABLES. The pack row left the choice open. It is two because
-- the two halves genuinely have different lifetimes:
--
--   * "GST registration" is a NAME the organisation keeps forever. Its
--     title and its category are what other modules will point at, and
--     they must not change when a new certificate is scanned.
--   * The scanned certificate is a FILE with a validity window, and the
--     next one is a different file with a different window. It is
--     evidence, so once written it never changes.
--
-- One table would have to hold both, and the two ways to do that are both
-- worse. Duplicating the title on every version lets the name drift
-- between versions of the same credential — v1 "GST Registration", v3
-- "GST Certificate" — and makes "the library" a query that has to pick a
-- spelling. A self-referencing supersede chain avoids the duplication but
-- makes "the current version" a NOT EXISTS over successors, which is the
-- read every screen does. Two tables make that read a plain join on the
-- highest version_number, which is the read that dominates.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No expiry notifications and no job rows. Expiry is DERIVED on read
--     (`expires_on` against `current_date`), because a derived answer
--     cannot go stale and a stored one can. Wave D owns notification.
--   * No approval or signature state. A company document is a copy of
--     something an authority already issued; it is not a document this
--     organisation issues, so none of the issued-document machinery —
--     numbering, cancellation with a retained number, signature verdicts
--     — applies to it.
--   * No per-Work scoping. The library is organisation-level by
--     definition: the point of it is that the same PAN copy serves every
--     Work. There is therefore no `work_id` and no work-scope predicate;
--     RLS on `organisation_id` is the whole of the isolation.

-- ---------------------------------------------------------------------
-- 1. The credential: a name the organisation keeps.
-- ---------------------------------------------------------------------
CREATE TABLE company_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  title text NOT NULL CHECK (
    btrim(title) = title
    AND length(title) BETWEEN 1 AND 200
  ),

  -- A constrained text column rather than a PostgreSQL enum, on purpose.
  -- The set will grow — the first tender that asks for something none of
  -- these five names will add a sixth — and growing a CHECK is one
  -- migration statement while growing an enum type is a type-level
  -- change that cannot be done inside a transaction on older servers.
  -- The five are the buckets Indian government tender checklists
  -- actually use:
  --
  --   statutory     GST registration, PAN, EPF, ESI, labour licence
  --   financial     balance sheets, turnover certificates, bank solvency
  --   eligibility   experience and completion certificates, past LOAs
  --   certification ISO and other quality or product certifications
  --   company       incorporation, partnership deed, board resolutions
  category text NOT NULL CHECK (category IN (
    'statutory',
    'financial',
    'eligibility',
    'certification',
    'company'
  )),

  -- Archive, not delete. A credential that is no longer offered is still
  -- the credential a bid submitted two years ago rested on, and the
  -- application role holds no DELETE on this table.
  archived_at timestamptz,
  archived_by_user_id text,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  CONSTRAINT company_documents_archive_shape_check CHECK (
    (archived_at IS NULL AND archived_by_user_id IS NULL)
    OR (archived_at IS NOT NULL AND archived_by_user_id IS NOT NULL)
  )
);

COMMENT ON TABLE company_documents IS
  'A reusable company-level credential — GST registration, PAN, an ISO certificate, a balance sheet. The row is the NAME; the files that prove it live in company_document_versions.';
COMMENT ON COLUMN company_documents.category IS
  'Constrained text rather than an enum type, so the set can grow in one ordinary migration statement when a tender asks for a bucket none of the five names.';
COMMENT ON COLUMN company_documents.archived_at IS
  'Retired from the library. The row and every version survive, because a bid that already cited this credential must stay explicable.';

-- One live credential per name. Two rows both called "GST Registration"
-- is the mistake this catches, and it is a real one: the second upload of
-- a renewed certificate belongs on the existing row as a new version, not
-- beside it as a rival. Case-folded, because "GST Registration" and "GST
-- registration" are the same credential to everyone but a byte
-- comparison. Archived rows drop out, so a retired name can be reused.
CREATE UNIQUE INDEX company_documents_live_title_unique
  ON company_documents (organisation_id, lower(title))
  WHERE archived_at IS NULL;

-- No index for the register's own ordering, deliberately. It reads one
-- organisation's whole library — tens of rows, an agency does not hold
-- hundreds of statutory certificates — and sorting that in memory is
-- free. `UNIQUE (organisation_id, id)` above already gives the tenant
-- predicate and the organisations foreign key a leading index; a second
-- one matching `ORDER BY (archived_at IS NOT NULL), lower(title)` would
-- be write cost bought for a sort that never appears in a plan.

ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_documents FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement
-- rather than once per row. New policies are authored this way from the
-- start.
CREATE POLICY company_documents_tenant_policy ON company_documents
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE exists for exactly one act today — archiving — and the guard
-- below narrows it to that. There is no DELETE at all. (A rename route
-- would use the same grant, and the `title` column is deliberately left
-- editable for it, but no route writes one yet: do not read this grant
-- as evidence that renaming is implemented.)
GRANT SELECT, INSERT, UPDATE ON company_documents TO auto_mb_app;

CREATE TRIGGER company_documents_touch_updated_at
BEFORE UPDATE ON company_documents
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- What an UPDATE on a credential may not do, said in the database rather
-- than only in the route that happens to be the sole writer today. Two
-- facts are frozen and one transition is one-way.
--
-- `search_path` is pinned for the same reason 0067 and 0077 pin theirs:
-- a trigger function resolves its own identifiers, and leaving that to
-- the caller's search_path is how a shadowing object in a writable
-- schema turns a guard into whatever it wants.
CREATE FUNCTION app_private.guard_company_document_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Provenance is a fact about an act that already happened, and the
  -- tenant is not a property anything may edit: re-pointing
  -- `organisation_id` would move a credential and every version behind it
  -- into another organisation in one statement, which RLS cannot catch
  -- because the row passes the policy on the way out and on the way in.
  IF ROW(NEW.organisation_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM ROW(OLD.organisation_id, OLD.created_at, OLD.created_by_user_id)
  THEN
    RAISE EXCEPTION 'a company document''s tenant and provenance are immutable';
  END IF;

  -- Archiving releases the name (the partial unique index above stops
  -- counting the row), so un-archiving could collide with a credential
  -- added in the meantime and would resurrect a row two bids disagree
  -- about. The way back is to add the credential again, which is what
  -- releasing the name is for.
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION
      'an archived company document cannot be un-archived; add it to the library again'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_documents_update_guard
BEFORE UPDATE ON company_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_document_update();

-- ---------------------------------------------------------------------
-- 2. The versions: the files, and what each one is valid for.
--
-- Immutable, on the same terms as every other stored piece of evidence in
-- this schema. A renewed certificate is a NEW version; the old one keeps
-- saying what it said, because a bid that attached it is entitled to an
-- explanation of what was attached.
-- ---------------------------------------------------------------------
CREATE TABLE company_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  company_document_id uuid NOT NULL,

  -- 1, 2, 3 … within the credential. The unique constraint below is what
  -- makes concurrent uploads safe: the route takes the parent row's lock
  -- and reads max + 1, and if two writers ever reached the read together
  -- the loser fails on the constraint rather than producing two v4s.
  version_number integer NOT NULL CHECK (version_number >= 1),

  -- The stored PDF, on the same terms as every other uploaded document.
  object_key text NOT NULL,
  original_filename text NOT NULL CHECK (
    length(btrim(original_filename)) BETWEEN 1 AND 255
  ),
  sha256 sha256_hex NOT NULL,
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),

  -- The validity window this version carries. Date-only, per engineering
  -- rule 6: these are legal dates printed on a certificate, and they must
  -- not be timezone-round-tripped. Both are optional and independently
  -- so — a PAN card has neither, a GST registration certificate has an
  -- effective date and no expiry, a bank solvency letter has both.
  valid_from date,
  expires_on date,

  uploaded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One constraint, doing two jobs: it is what makes concurrent renewals
  -- safe, and it leads with `organisation_id` so the organisations
  -- foreign key and the tenant predicate both have their index.
  --
  -- Two constraints that sibling tables carry are deliberately absent.
  -- There is no tenant-composite key on the id, because nothing
  -- references this table and that pattern exists only to give a child's
  -- foreign key something tenant-scoped to point at. And there is no
  -- per-tenant uniqueness on the object key, because the global unique
  -- index below is strictly stronger and the tenant prefix inside the
  -- key is a CHECK rather than a hope.
  UNIQUE (organisation_id, company_document_id, version_number),

  FOREIGN KEY (organisation_id, company_document_id)
    REFERENCES company_documents(organisation_id, id),

  -- Object keys are `<org>/<area>/<name>.<ext>` and the tenant prefix is
  -- checked here as well as in `packages/documents/src/storage.ts`,
  -- exactly as 0003 does for loa_documents and 0066 for received railway
  -- bills. Two layers, because a path is a filesystem escape.
  CONSTRAINT company_document_versions_object_key_tenant_prefix_check
    CHECK (object_key LIKE organisation_id::text || '/%'),

  -- A window that closes before it opens is a typo, and it would make
  -- every derived expiry answer nonsense.
  CONSTRAINT company_document_versions_validity_order_check CHECK (
    valid_from IS NULL OR expires_on IS NULL OR expires_on >= valid_from
  )
);

COMMENT ON TABLE company_document_versions IS
  'One uploaded file of a company credential, with the validity window printed on it. Append-only: a renewal is a new version and never an edit.';
COMMENT ON COLUMN company_document_versions.expires_on IS
  'Date-only, as the certificate prints it. Expiry STATUS is derived on read against current_date and is never stored, so it cannot go stale.';

CREATE UNIQUE INDEX company_document_versions_object_key_unique
  ON company_document_versions (object_key);

ALTER TABLE company_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_document_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY company_document_versions_tenant_policy ON company_document_versions
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Append-only for the application role: no UPDATE, no DELETE. The trigger
-- below says the same thing to a writer that reached the table some other
-- way, which is the two-layer posture 0058 takes for a cited variation
-- order.
GRANT SELECT, INSERT ON company_document_versions TO auto_mb_app;

CREATE FUNCTION app_private.guard_company_document_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_archived_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a company document version is immutable; upload a new version instead';
  END IF;

  -- A retired credential takes no new evidence. Without this a version
  -- could be appended to a row the library no longer shows, which is a
  -- file nobody can find again.
  --
  -- FOR SHARE, not a bare read. This claims to be the second layer under
  -- the route's own check, and a plain SELECT is not one: under READ
  -- COMMITTED it would see the parent as it stood when this statement
  -- began, so an archive committing between the read and this INSERT
  -- would be invisible and the version would land on a retired
  -- credential anyway. The share lock makes the two orderings the only
  -- two possible — either the archive waits for this insert, or this
  -- insert sees it and refuses.
  SELECT archived_at INTO parent_archived_at
  FROM company_documents
  WHERE id = NEW.company_document_id
    AND organisation_id = NEW.organisation_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'no company document % in this organisation', NEW.company_document_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF parent_archived_at IS NOT NULL THEN
    RAISE EXCEPTION
      'company document % is archived and takes no new versions',
      NEW.company_document_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_document_versions_append_only_guard
BEFORE INSERT OR UPDATE ON company_document_versions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_document_version();
