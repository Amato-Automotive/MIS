-- AutoForm MIS — Phase 29 Migration: Finance company group (Amato Group / Other)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase29_finance_company_group.sql
--
-- Admins tag each finance company as part of the Amato Group or not, and the
-- All Companies view filters on it. Expand-only: a nullable column, no backfill.
-- NULL means "not yet categorised" — guessing from the tab name would quietly
-- put a company in the wrong group, and the UI surfaces the untagged ones.
--
-- Sync never writes this column (it creates company rows with it NULL and
-- leaves existing ones alone), so a re-sync cannot undo an admin's choice.

ALTER TABLE sheet_sources
    ADD COLUMN IF NOT EXISTS company_group VARCHAR(10)
    CHECK (company_group IS NULL OR company_group IN ('amato', 'other'));

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sheet_sources' AND column_name = 'company_group';
