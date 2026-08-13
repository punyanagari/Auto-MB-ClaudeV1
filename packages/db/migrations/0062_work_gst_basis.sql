-- Migration 0062: the GST BASIS of a Work's LOA rates, as a per-Work
-- attribute.
--
-- Owner ruling, 13 August 2026: LOA rates are USUALLY GST-inclusive at
-- 18% — works contracts in India sit in the 18% slab — but SOME LOAs
-- quote GST-exclusive rates. It is rare, and it is real.
--
-- So the basis is recorded per Work and read from there. A hardcoded
-- 1.18 anywhere in the executed-value path is a latent defect of exactly
-- the worst kind: invisible on every ordinary Work, and wrong on the rare
-- one, with nothing on screen to say which case you are looking at.
--
-- WHY IT MATTERS, and in which direction. Executed value drives work
-- completion, and a Work may be marked completed only at 100% executed
-- value. Reading a GST-EXCLUSIVE letter as inclusive compares
-- GST-inclusive money against a contract value that excludes GST and
-- OVERSTATES execution by the GST factor: such a Work reads 100% executed
-- while it is really at 100/1.18 = 84.75%, so it can be closed with
-- roughly a sixth of the contract still unbilled. The opposite mistake
-- merely holds a finished Work open, which is visible and annoying rather
-- than silent and expensive. The default below therefore follows the
-- common case, and the rare case is captured explicitly by a human.
--
-- NOT PARSED FROM THE LETTER, deliberately. The LOA letter is silent on
-- GST: searching the PL-270 corpus letter for 'inclusive of GST', 'GST
-- extra' and every neighbouring phrasing returns nothing (recorded in
-- apps/server/test/fixtures/railway-settlement/corpus.json under
-- executed_value_rule.evidence_for_this_work). The basis shows up on the
-- railway's own bill — 'Rate is inclusive of GST: Yes' — not on the
-- award. So there is no extracted value here to protect, and under the
-- LOA extracted-value lock (apps/server/src/loa-extracted-values.ts) a
-- field the parser never produced is a HOLE the reviewer fills, not a
-- truth the lock defends. It is captured at LOA review time.
--
-- BACKFILL is the default, on purpose. Every existing Work predates the
-- question, and 'inclusive' is what an Indian works-contract LOA usually
-- means; the alternative — leaving the column NULL and refusing to report
-- executed value until someone answers — would break every existing
-- Work's dashboard row to record an answer that is right in the large
-- majority of cases anyway. NOT NULL with a default costs no table
-- rewrite on PostgreSQL 11+.
--
-- The rate is stored ALONGSIDE the basis rather than being read from the
-- gst_rates master at computation time. The master says what is notified
-- TODAY; this column says what THIS letter's rates were quoted against,
-- which is a fact about a document signed on a particular date and must
-- not move under a Work when the slab is renotified. The confirm endpoint
-- still validates the submitted rate against the master as of the letter
-- date, so the stored value is a notified rate at the time it was
-- captured.
--
-- Numbering note: 0058-0061 are all in flight or landed on other
-- branches; the runner keys on the four-digit id and never requires
-- contiguity (packages/db/src/migration-runner.ts), so 0062 is safe.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE works
  ADD COLUMN gst_basis text NOT NULL DEFAULT 'inclusive'
    CHECK (gst_basis IN ('inclusive', 'exclusive')),
  ADD COLUMN gst_rate numeric(5,2) NOT NULL DEFAULT 18.00
    CHECK (gst_rate >= 0 AND gst_rate < 100);

COMMENT ON COLUMN works.gst_basis IS
  'Whether this Work''s LOA rates (and therefore contract_value and every amount derived from those rates) are quoted INCLUSIVE or EXCLUSIVE of GST. Captured at LOA review time, not parsed: the letter is silent on GST. Executed value must be computed by comparing money on this basis against contract_value; mixing the two bases moves the answer by the whole GST factor (migration 0062).';

COMMENT ON COLUMN works.gst_rate IS
  'The GST rate, in percent, that works.gst_basis refers to — 18.00 for an ordinary works contract. Stored per Work rather than read from the gst_rates master at computation time, so a renotified slab cannot retroactively move a signed letter''s basis conversion (migration 0062).';
