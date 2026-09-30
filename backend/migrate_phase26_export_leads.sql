-- Phase 26 — Export: the UK / EU / AU lead pipeline.
--
-- (Phase 25 is reserved for the chatbot's scope revision.)
--
-- Source: the export team's workbook, `Leads` tab only — one row per company,
-- written to a format we designed for them because the tabs they kept before
-- carried their meaning in cell colours. Everything else in that workbook
-- (outreach logs, trade-fair contact lists, material research) is deliberately
-- not ingested.
--
-- Three things about the data this schema is built around:
--
--   • It is a SNAPSHOT, not a history. Each sync replaces the table with the
--     sheet as it stands; when a lead moves stage the sheet overwrites the old
--     one. "How long has it been here" therefore comes from the team's own
--     `Stage Since` date, never from comparing syncs.
--   • Most leads carry no potential estimate. potential_cr is NULLABLE and a
--     NULL means "not estimated", never zero — summing it must say how many
--     leads the total covers.
--   • Stage is stored as its number (1–11). The labels live in code, so a
--     reworded dropdown on the Lists tab cannot split one stage into two.

-- ─── 1. Registry ──────────────────────────────────────────────────────────────
-- One workbook for the whole module: the pipeline is a live list, not a sheet
-- per period.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheet_sources_export_leads
    ON sheet_sources (module)
    WHERE module = 'export_leads';

-- ─── 2. One row per company ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_leads (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id  UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    sheet_row        INTEGER NOT NULL,          -- 1-based row in the Leads tab
    company          VARCHAR(200) NOT NULL,
    owner            VARCHAR(100),              -- as the dropdown spells it; may be joint ("Reenu + Jai")
    customer_type    VARCHAR(60),
    country          VARCHAR(60),
    -- 'UK' | 'EU' | 'AU', derived from country at sync. NULL when the country is
    -- blank or one we have not mapped — the sync reports which.
    region           VARCHAR(4),
    city             VARCHAR(100),
    contact_person   VARCHAR(200),
    contact_email    VARCHAR(300),
    contact_phone    VARCHAR(100),
    stage_no         SMALLINT CHECK (stage_no BETWEEN 1 AND 11),
    stage_since      DATE,
    status           VARCHAR(20) CHECK (status IN ('Active', 'On Hold', 'Won', 'Lost')),
    potential_cr     NUMERIC(10, 2) CHECK (potential_cr >= 0),   -- ₹ crore; NULL = not estimated
    last_contact     DATE,
    next_action      TEXT,
    next_action_date DATE,
    source           VARCHAR(80),
    remarks          TEXT,
    sync_log_id      UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- The sheet rejects a duplicate company; this catches one pasted past the
-- validation. The parser keeps the first and reports the rest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_leads_company
    ON export_leads (sheet_source_id, UPPER(company));
CREATE INDEX IF NOT EXISTS idx_export_leads_source ON export_leads (sheet_source_id);

-- ─── 3. Grants ────────────────────────────────────────────────────────────────
ALTER TABLE export_leads OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE export_leads TO mis_user;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'export_leads'
ORDER BY ordinal_position;
