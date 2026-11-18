-- AutoForm MIS — Phase 32 Migration: finance company groups become data
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase32_finance_company_groups.sql
--
-- Until now the group list lived in four places (a CHECK constraint, a backend
-- tuple, a frontend type + label map, the chatbot's schema text), so adding a
-- group meant a migration, a deploy and three code edits (phases 29, 30, 31).
-- Admins now manage the list themselves from Finance > Data Sources.
--
-- Design:
--   * finance_company_groups holds the list. `key` is the stable identity that
--     sheet_sources.company_group stores; `label` is what people read and can be
--     renamed freely without touching any company.
--   * sheet_sources.company_group becomes a foreign key to that key.
--       ON UPDATE CASCADE  - a key change (not exposed in the UI) cannot orphan.
--       ON DELETE SET NULL - deleting a group leaves its companies "not yet
--                            categorised", the state the UI already handles.
--   * The six existing groups are seeded with their existing keys, so every
--     tagged company stays valid and nothing needs backfilling.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS finance_company_groups (
    key        VARCHAR(40)  PRIMARY KEY,
    label      VARCHAR(80)  NOT NULL,
    sort_order INTEGER      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- Case-insensitive unique label, so "RK group" and "RK Group" cannot coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_company_groups_label
    ON finance_company_groups (LOWER(label));

INSERT INTO finance_company_groups (key, label, sort_order) VALUES
    ('amato', 'Amato Group', 1),
    ('main',  'Main Plant',  2),
    ('rk',    'RK Group',    3),
    ('am',    'AM Group',    4),
    ('jv',    'JV Group',    5),
    ('other', 'Other',       6)
ON CONFLICT (key) DO NOTHING;

-- The old CHECK (auto-named by phase 29) is what forced a migration per group.
ALTER TABLE sheet_sources DROP CONSTRAINT IF EXISTS sheet_sources_company_group_check;
ALTER TABLE sheet_sources ALTER COLUMN company_group TYPE VARCHAR(40);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sheet_sources_company_group_fkey') THEN
        ALTER TABLE sheet_sources
            ADD CONSTRAINT sheet_sources_company_group_fkey
            FOREIGN KEY (company_group) REFERENCES finance_company_groups (key)
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE finance_company_groups OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE finance_company_groups TO mis_user;

-- Verify
SELECT key, label, sort_order,
       (SELECT COUNT(*) FROM sheet_sources s WHERE s.company_group = g.key) AS companies
FROM finance_company_groups g ORDER BY sort_order;
