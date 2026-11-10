-- AutoForm MIS — Phase 30 Migration: more finance company groups (RK / AM / JV)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase30_finance_more_groups.sql
--
-- Widens the CHECK on sheet_sources.company_group. Existing values stay valid.

ALTER TABLE sheet_sources DROP CONSTRAINT IF EXISTS sheet_sources_company_group_check;
ALTER TABLE sheet_sources
    ADD CONSTRAINT sheet_sources_company_group_check
    CHECK (company_group IS NULL OR company_group IN ('amato', 'rk', 'am', 'jv', 'other'));

-- Verify
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'sheet_sources_company_group_check';
