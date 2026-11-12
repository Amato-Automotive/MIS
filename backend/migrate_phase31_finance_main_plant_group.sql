-- AutoForm MIS — Phase 31 Migration: finance company group "Main Plant"
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase31_finance_main_plant_group.sql
--
-- Widens the CHECK on sheet_sources.company_group. Existing values stay valid.

ALTER TABLE sheet_sources DROP CONSTRAINT IF EXISTS sheet_sources_company_group_check;
ALTER TABLE sheet_sources
    ADD CONSTRAINT sheet_sources_company_group_check
    CHECK (company_group IS NULL OR company_group IN ('amato', 'main', 'rk', 'am', 'jv', 'other'));

-- Verify
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'sheet_sources_company_group_check';
