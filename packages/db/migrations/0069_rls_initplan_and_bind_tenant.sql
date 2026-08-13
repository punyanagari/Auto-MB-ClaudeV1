SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Per-statement RLS evaluation, and a bind that fails loudly (ADR-0010).
--
-- Every tenant policy in this schema was written as
--
--   USING (organisation_id = app_private.current_organisation_id())
--
-- and `app_private.current_organisation_id()` (migration 0004) is not a
-- cheap accessor: it is SECURITY DEFINER and proves an ACTIVE membership
-- row exists for the session's user before it will return an organisation
-- id at all. In bare filter position the planner has to call it for every
-- candidate row, and a SECURITY DEFINER function is never inlined, so a
-- register scan pays one membership index probe per row to compute the
-- same answer each time. The reconciled review measured 4.1x overhead for
-- exactly this shape.
--
-- Wrapping the call in an uncorrelated scalar subquery,
--
--   USING (organisation_id = (SELECT app_private.current_organisation_id()))
--
-- makes it an InitPlan: it runs ONCE per statement and its result becomes
-- a parameter the planner may push into index conditions. The membership
-- EXISTS stays inside the helper, on the definer's authority, byte for
-- byte unchanged, so the trust model is untouched — arbitrary SQL running
-- as `auto_mb_app` gains nothing here that it did not already have. This
-- is a planning change, not a security change.
--
-- The ALTER POLICY statements below are static and exhaustive. They were
-- generated once from `pg_policies` against a fully migrated database and
-- are committed as reviewed SQL rather than produced by a DO block that
-- rewrites catalog text at run time: a policy predicate is a security
-- boundary, and a reviewer must be able to read the exact expression each
-- policy ends up with. 64 policies are rewritten, carrying 123 calls to
-- `current_organisation_id()` and 2 to `current_user_id()`. The standing
-- guard against a later policy landing in bare style is the catalog census
-- in `packages/db/test/rls-initplan.integration.test.ts`, not this file.
--
-- Ordering: this migration depends on nothing between 0066 and 0068 and
-- touches no object they introduce. The runner applies any unapplied id
-- regardless of relative order (precedent: 0070), so it is safe out of
-- order — but a policy CREATED after this migration must be written in
-- InitPlan form from the start, because ALTER POLICY here cannot reach it.

-- 1. The 58 uniform tenant policies: `organisation_id` against the bound
-- organisation, on both the read and the write side.
ALTER POLICY amendment_variation_orders_tenant_policy ON amendment_variation_orders
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY approval_requests_tenant_policy ON approval_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY audit_events_tenant_policy ON audit_events
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY bill_counters_tenant_policy ON bill_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY bills_tenant_policy ON bills
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY budgetary_quotation_counters_tenant_policy ON budgetary_quotation_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY budgetary_quotation_lines_tenant_policy ON budgetary_quotation_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY budgetary_quotations_tenant_policy ON budgetary_quotations
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY challan_item_serials_tenant_policy ON challan_item_serials
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY challan_receipts_tenant_policy ON challan_receipts
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY contacts_tenant_policy ON contacts
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY correction_notice_counters_tenant_policy ON correction_notice_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY correction_notices_tenant_policy ON correction_notices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY credit_note_counters_tenant_policy ON credit_note_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY credit_notes_tenant_policy ON credit_notes
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY delivery_challan_counters_tenant_policy ON delivery_challan_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY delivery_challan_items_tenant_policy ON delivery_challan_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY delivery_challans_tenant_policy ON delivery_challans
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY document_number_series_tenant_policy ON document_number_series
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY eway_bills_tenant_policy ON eway_bills
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY extension_request_counters_tenant_policy ON extension_request_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY extension_requests_tenant_policy ON extension_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY gst_rates_tenant_policy ON gst_rates
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY import_batches_tenant_policy ON import_batches
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY import_records_tenant_policy ON import_records
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY installation_serials_tenant_policy ON installation_serials
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY installations_tenant_policy ON installations
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY issue_challan_counters_tenant_policy ON issue_challan_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY issue_challan_lines_tenant_policy ON issue_challan_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY issue_challans_tenant_policy ON issue_challans
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY loa_documents_tenant_policy ON loa_documents
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY location_masters_tenant_policy ON location_masters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY mb_entries_tenant_policy ON mb_entries
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY mb_sources_tenant_policy ON mb_sources
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY measurement_book_counters_tenant_policy ON measurement_book_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY measurement_book_lines_tenant_policy ON measurement_book_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY measurement_book_merge_provenance_tenant_policy ON measurement_book_merge_provenance
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY measurement_books_tenant_policy ON measurement_books
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY organisation_signatories_tenant_policy ON organisation_signatories
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY pac_certificate_items_tenant_policy ON pac_certificate_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY pac_certificates_tenant_policy ON pac_certificates
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY payment_matrices_tenant_policy ON payment_matrices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY purchase_order_counters_tenant_policy ON purchase_order_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY purchase_order_lines_tenant_policy ON purchase_order_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY purchase_orders_tenant_policy ON purchase_orders
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY standalone_challan_counters_tenant_policy ON standalone_challan_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY statutory_provider_operations_tenant_policy ON statutory_provider_operations
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY tax_invoice_counters_tenant_policy ON tax_invoice_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY tax_invoice_lines_tenant_policy ON tax_invoice_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY tax_invoice_renders_tenant_policy ON tax_invoice_renders
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY tax_invoices_tenant_policy ON tax_invoices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY unit_masters_tenant_policy ON unit_masters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY work_assignments_tenant_policy ON work_assignments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY work_consignees_tenant_policy ON work_consignees
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY work_instruments_tenant_policy ON work_instruments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY work_items_tenant_policy ON work_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY work_schedules_tenant_policy ON work_schedules
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY works_tenant_policy ON works
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- 2. The four policies on `organisation_memberships`. Split by command
-- since 0001, so each one carries only the clause its command allows.
ALTER POLICY organisation_memberships_delete_policy ON organisation_memberships
  USING (organisation_id = (SELECT app_private.current_organisation_id()));
ALTER POLICY organisation_memberships_insert_policy ON organisation_memberships
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
-- The mixed one: a member may always read their OWN membership rows, which
-- is how the organisation picker works before any organisation is bound.
-- Both helpers move into InitPlan position; `current_user_id()` reads a GUC
-- and nothing else, but in bare position it is still a function call per
-- candidate row.
ALTER POLICY organisation_memberships_select_policy ON organisation_memberships
  USING (
    organisation_id = (SELECT app_private.current_organisation_id())
    OR user_id = (SELECT app_private.current_user_id())
  );
ALTER POLICY organisation_memberships_update_policy ON organisation_memberships
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- 3. The two policies on `organisations`. The tenant policy keys on `id`
-- rather than `organisation_id`; the member-select policy (0004) lets a
-- signed-in user list the organisations they belong to before choosing
-- one, and its EXISTS is correlated to `organisations.id`, so it is
-- re-executed per row — which made `current_user_id()` a per-row call too.
-- Lifting that helper into its own uncorrelated subquery leaves the
-- correlation intact and evaluates the user id once.
ALTER POLICY organisations_tenant_policy ON organisations
  USING (id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (id = (SELECT app_private.current_organisation_id()));
ALTER POLICY organisations_member_select_policy ON organisations
  USING (
    EXISTS (
      SELECT 1 FROM organisation_memberships m
      WHERE m.organisation_id = organisations.id
        AND m.user_id = (SELECT app_private.current_user_id())
        AND m.status = 'active'
    )
  );

-- 4. Binding a tenant becomes one call, and a wrong binding fails loudly.
--
-- `packages/db/src/tenant.ts` used to open every tenant transaction with
-- two `set_config` statements and nothing else. If the organisation did
-- not belong to the user, the helper above simply returned NULL, every
-- policy denied, and the request read an empty database — a silent denial
-- discovered only by absence. This function performs the same two
-- transaction-local writes and then PROVES the binding, so a wrong one is
-- refused at the top of the transaction.
--
-- `is_local = true` on both calls is the security property, not a detail:
-- a session-level setting would outlive the transaction and ride the
-- pooled connection into the next borrower's work. Both keys are always
-- written, including an empty user id, so a missing value can never fall
-- through to a previous transaction's.
--
-- The proof is `app_private.current_organisation_id()` itself — the very
-- function every policy calls — rather than a second copy of its
-- membership EXISTS. A copy would be two definer functions holding one
-- rule, and the failure mode of drift is the silent-empty read this
-- migration exists to remove: bind accepts, policies deny. Calling the
-- floor helper keeps one source of membership truth, and it works because
-- the two `set_config` writes above are transaction-local and therefore
-- already visible to the nested call, and because both functions are owned
-- by `auto_mb_definer`, which holds EXECUTE on its own function implicitly.
--
-- This is ADDITIVE. The policies do not trust it: they call the same
-- helper themselves, on the definer's authority. A code path that binds
-- the GUCs without coming through here lands exactly where it landed
-- before — helper returns NULL, every policy denies. The floor is the
-- helper; this is fail-fast on top of it.
--
-- SECURITY DEFINER for the same reason 0004's helper is: at bind time no
-- tenant is bound yet, so the application role cannot read
-- `organisation_memberships` through RLS to check its own membership.
-- There is deliberately no service/bypass argument — a background job with
-- no requesting user is P18's design question, not a hole opened here.
--
-- SQLSTATE 28A01 is Auto-MB's own code, and the choice is load-bearing.
-- The obvious `28000` is `invalid_authorization_specification`, which
-- PostgreSQL ITSELF raises when a connection fails pg_hba, LOGIN or role
-- authorisation. A caller that mapped `28000` to "you are not a member"
-- would answer a cluster-wide authentication outage with a fleet of
-- tenant-shaped 403s and no 5xx at all — the outage would look like a
-- permissions change. Class 28 defines exactly two codes upstream (28000
-- and 28P01, `src/include/utils/errcodes.h`), so 28A01 is unused by
-- PostgreSQL and unused anywhere in this schema; `tenant.ts` catches
-- exactly it and nothing else.
CREATE FUNCTION app_private.bind_tenant(
  p_organisation_id uuid,
  p_user_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.organisation_id', coalesce(p_organisation_id::text, ''), true);
  PERFORM set_config('app.user_id', coalesce(p_user_id, ''), true);

  IF app_private.current_organisation_id() IS NULL THEN
    RAISE EXCEPTION
      'no active membership binds this user to organisation %', p_organisation_id
      USING ERRCODE = '28A01';
  END IF;
END
$$;

ALTER FUNCTION app_private.bind_tenant(uuid, text) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.bind_tenant(uuid, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.bind_tenant(uuid, text) TO auto_mb_app;
  END IF;
END
$$;
