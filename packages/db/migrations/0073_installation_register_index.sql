SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Migration 0073: an index for the tenant-wide installation register.
--
-- `GET /api/installations` reads every installation the caller may see,
-- newest first, over an optional `installed_on` window. 0017's
-- installations_work_idx leads with work_id, which the register does not
-- filter by, so the register's plan was a full scan of the table plus a
-- sort — fine at a hundred rows, and the wrong shape to ship a register
-- on, because installations are the highest-cardinality operational
-- record a division writes.
--
-- The column order is the register's ORDER BY: organisation_id first
-- because RLS narrows to it on every read, then the three sort keys in
-- the order and the direction the keyset comparison uses
-- (installed_on, created_at, id), all descending. The date window is a
-- range on the leading sort key, so it seeks inside the same index rather
-- than asking for a second one.
--
-- Same reasoning, same shape, as 0056's delivery_challans_register_idx.
-- Register listing: the module's own screen orders by date across Works.
CREATE INDEX installations_register_idx
  ON installations (organisation_id, installed_on DESC, created_at DESC, id DESC);
