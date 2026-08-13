-- Migration 0061: a dedicated per-member authority for statutory
-- reporting (finding 2 residue, docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- Until now every IRP/NIC action — registering an invoice or credit note
-- at the Invoice Registration Portal, cancelling an IRN, reconciling an
-- unknown attempt by lookup, recording manual portal evidence, and the
-- e-way-bill provider operations — was governed by `can_issue_documents`,
-- the same authority that issues an ordinary Delivery Challan. That is
-- the named residue the audit called "no dedicated compliance authority":
-- binding the organisation's statutory identity to a government portal is
-- a different act from issuing a document of our own, and it deserves its
-- own grant.
--
-- The column joins the three authorities already on this table
-- (`can_issue_documents`, `can_cancel_documents`, `can_approve_amendments`)
-- and is added exactly the way `can_approve_amendments` was in
-- 0012_amendments_approvals.sql:12-13 — a plain NOT NULL boolean with a
-- false default, which PostgreSQL applies without rewriting the table.
--
-- DELIBERATELY NOT BACKFILLED from `can_issue_documents`. Backfilling
-- would make this a rename rather than a control: every member who can
-- issue a challan would still be able to bind the organisation's GSTIN at
-- the IRP, and nobody would ever have made the decision the authority
-- exists to record. The owner ruled on 13 August 2026 that the column
-- defaults false and is granted explicitly, accepting that existing
-- holders lose IRP access until then. The product has effectively one
-- user today, so the blast radius is a single deliberate grant.
--
-- Because the authority makes an account able to speak to the government
-- portal in the organisation's name, it also joins the MFA obligation
-- (apps/server/src/mfa-policy.ts): a member holding only this authority
-- is TOTP-required like any other privilege holder.
--
-- Numbering note: 0058 and 0060 are deliberately skipped — 0058 is
-- reserved by the omission/variation reference branch and 0060 by the
-- signature-verification branch, both in flight. The migration runner
-- keys strictly on the four-digit id (packages/db/src/migration-runner.ts
-- refuses duplicates and hash/rename drift but never requires
-- contiguity), so the gaps are safe and either can land later in any
-- order. 0052, 0057 and 0059 set the same precedent.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organisation_memberships
  ADD COLUMN can_manage_statutory_reporting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_manage_statutory_reporting IS
  'Authority to drive statutory reporting: IRP registration, reconcile-by-lookup and cancellation for tax invoices and credit notes, the manual portal-evidence doors, and E-way Bill provider operations. Defaults false and is granted explicitly; never backfilled from can_issue_documents (migration 0061).';
