SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 5: the retention workflow. Delivery receipts, serial
-- traceability, contract instruments (PBG/PAC/DOC), the Measurement Book,
-- and partial bills. MB entries and bills are financial-legal records:
-- billed entries freeze, bills mutate only through forward status
-- transitions, and neither can be deleted by the application role.

-- 1. Delivery receipt: one per issued challan.
CREATE TABLE challan_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  delivery_challan_id uuid NOT NULL,
  work_id uuid NOT NULL,
  received_on date NOT NULL,
  received_by text NOT NULL CHECK (length(btrim(received_by)) BETWEEN 2 AND 200),
  remarks text,
  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, delivery_challan_id),
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id)
    REFERENCES delivery_challans(organisation_id, id, work_id)
);

-- 2. Serial traceability: serials unique within a Work, bound to the
-- challan line they shipped on; installation recorded in place.
CREATE TABLE challan_item_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  delivery_challan_id uuid NOT NULL,
  delivery_challan_item_id uuid NOT NULL,
  serial_number text NOT NULL CHECK (length(btrim(serial_number)) BETWEEN 1 AND 100),
  installed_on date,
  installation_remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, serial_number),
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id)
    REFERENCES delivery_challans(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, delivery_challan_item_id)
    REFERENCES delivery_challan_items(organisation_id, id)
);

-- 3. Contract instruments: PBG / PAC / DOC per Work.
CREATE TABLE work_instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pbg', 'pac', 'doc')),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 200),
  amount numeric(18,2) CHECK (amount IS NULL OR amount >= 0),
  issued_on date NOT NULL,
  expires_on date,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired', 'closed')),
  notes text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, kind, reference),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

-- 4. Bills, numbered gaplessly per Work through a counter row (same
-- serialisation pattern as delivery_challan_counters).
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  bill_number integer NOT NULL CHECK (bill_number > 0),
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'submitted', 'paid')),
  lines_snapshot jsonb NOT NULL,
  total_amount numeric(18,2) NOT NULL CHECK (total_amount >= 0),
  prepared_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  paid_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, bill_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL),
  CHECK (status <> 'paid' OR (submitted_at IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE TABLE bill_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

-- 5. Measurement Book entries. bill_id stamps the entry into a bill, at
-- which point it freezes (trigger below).
CREATE TABLE mb_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  delivery_challan_id uuid,
  measured_quantity numeric(18,3) NOT NULL CHECK (measured_quantity > 0),
  measured_on date NOT NULL,
  mb_book_ref text,
  remarks text,
  bill_id uuid,
  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, bill_id) REFERENCES bills(organisation_id, id)
);

-- 6. Immutability guards.
CREATE FUNCTION app_private.guard_mb_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'billed Measurement Book entries are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER mb_entries_guard_mutation
BEFORE UPDATE OR DELETE ON mb_entries
FOR EACH ROW EXECUTE FUNCTION app_private.guard_mb_entry_mutation();

CREATE FUNCTION app_private.guard_bill_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.bill_number, NEW.lines_snapshot,
    NEW.total_amount, NEW.prepared_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.bill_number, OLD.lines_snapshot,
    OLD.total_amount, OLD.prepared_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'bill business data is immutable; only status may change';
  END IF;
  IF NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('prepared', 'submitted'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'paid'))
    OR (OLD.status = 'paid' AND NEW.status = 'paid')
  ) THEN
    RAISE EXCEPTION 'bill status only moves forward: prepared -> submitted -> paid';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bills_guard_update
BEFORE UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_update();

CREATE FUNCTION app_private.guard_bill_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bills cannot be deleted';
END
$$;

CREATE TRIGGER bills_guard_delete
BEFORE DELETE ON bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_delete();

-- 7. Touch triggers for updated_at.
CREATE TRIGGER challan_item_serials_touch_updated_at
BEFORE UPDATE ON challan_item_serials
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER work_instruments_touch_updated_at
BEFORE UPDATE ON work_instruments
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 8. Indexes.
CREATE INDEX challan_item_serials_work_idx
  ON challan_item_serials (organisation_id, work_id, serial_number);
CREATE INDEX work_instruments_expiry_idx
  ON work_instruments (organisation_id, expires_on)
  WHERE status = 'active' AND expires_on IS NOT NULL;
CREATE INDEX mb_entries_unbilled_idx
  ON mb_entries (organisation_id, work_id, work_item_id)
  WHERE bill_id IS NULL;
CREATE INDEX bills_work_idx
  ON bills (organisation_id, work_id, bill_number DESC);

-- 9. RLS: tenant policy on every new table.
ALTER TABLE challan_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE challan_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE challan_item_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE challan_item_serials FORCE ROW LEVEL SECURITY;
ALTER TABLE work_instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_instruments FORCE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
ALTER TABLE bill_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE mb_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY challan_receipts_tenant_policy ON challan_receipts
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY challan_item_serials_tenant_policy ON challan_item_serials
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY work_instruments_tenant_policy ON work_instruments
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY bills_tenant_policy ON bills
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY bill_counters_tenant_policy ON bill_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY mb_entries_tenant_policy ON mb_entries
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 10. Grants. No DELETE on receipts, instruments, mb_entries, bills, or
-- counters: corrections happen through UPDATE (guarded by triggers) or
-- compensating records, never by erasure. Serials may be deleted while
-- their data-entry mistakes are fresh — they carry no financial state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      challan_receipts,
      work_instruments,
      bills,
      bill_counters,
      mb_entries
    TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON challan_item_serials TO auto_mb_app;
  END IF;
END
$$;
