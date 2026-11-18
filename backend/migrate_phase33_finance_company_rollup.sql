-- AutoForm MIS — Phase 33 Migration: finance "roll-up" companies
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase33_finance_company_rollup.sql
--
-- The All Companies view now shows a Total row under each table. A total is only
-- right if no sale is counted twice, and one master tab IS a roll-up of others:
-- AMATO TOTAL ("Consolidated of Amato Group"). It is not a plain sum of its units
-- (Sep 2026 sales: the five units add to 67.4 Cr, the roll-up reports 63.2 Cr,
-- because inter-company sales are eliminated), so adding it to the units would
-- double count. A company flagged is_rollup stays visible as its own row but is
-- left out of every Total.
--
-- Admin-managed (Finance > Data Sources), not a name match in code. Sync never
-- writes it. Expand-only: a NOT NULL column with a default, so no row needs
-- backfilling and old code keeps working. Idempotent.

ALTER TABLE sheet_sources
    ADD COLUMN IF NOT EXISTS is_rollup BOOLEAN NOT NULL DEFAULT FALSE;

-- The one roll-up the master workbooks are known to carry today.
UPDATE sheet_sources
SET is_rollup = TRUE
WHERE module = 'finance' AND kind = 'company' AND sheet_id = 'amato_total';

-- Verify
SELECT label, sheet_id, is_rollup FROM sheet_sources
WHERE module = 'finance' AND kind = 'company' AND is_rollup;
