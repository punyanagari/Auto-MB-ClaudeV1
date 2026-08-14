SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Migration 0074: an index for the organisation-wide tax-invoice register.
--
-- `GET /api/tax-invoices` reads every invoice the caller may see, newest
-- first, over an optional invoice_date window, across Works and including
-- the direct invoices that belong to no Work at all. 0035's
-- tax_invoices_work_idx leads with (work_id, status), neither of which the
-- register filters by, so the register's plan was a full scan of the table
-- plus a sort.
--
-- The column order is the register's ORDER BY: organisation_id first
-- because RLS narrows to it on every read, then the three sort keys in the
-- order and the direction the keyset comparison uses (invoice_date,
-- created_at, id), all descending. The date window is a range on the
-- leading sort key, so it seeks inside the same index rather than asking
-- for a second one.
--
-- Same reasoning, same shape, as 0073's installations_register_idx and
-- 0056's delivery_challans_register_idx.
-- Register listing: the module's own screen orders by invoice date across
-- Works, and across the invoices that have none.
CREATE INDEX tax_invoices_register_idx
  ON tax_invoices (organisation_id, invoice_date DESC, created_at DESC, id DESC);
