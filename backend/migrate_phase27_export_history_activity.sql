-- Phase 27 — Export: stage history, the activity log, and how leads close.
--
-- Additive only (expand). export_leads.last_contact is KEPT: it is no longer a
-- column the team types, but the sync now fills it with each lead's newest
-- Activity entry, so every reader of it keeps working unchanged.

-- ─── 1. How a lead closed ─────────────────────────────────────────────────────
-- Both typed by the team on the Leads tab. closed_date is the day a lead was
-- won OR lost, so "won this quarter" and "lost this quarter" are both
-- answerable; the history table below can only date closes it saw happen,
-- which excludes everything closed before tracking began (UKCC, for one).
ALTER TABLE export_leads ADD COLUMN IF NOT EXISTS closed_date DATE;
ALTER TABLE export_leads ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(40);

-- ─── 2. Stage history, recorded by the sync ───────────────────────────────────
-- The Leads tab is overwritten as leads move, so each sync compares what it is
-- about to write with what is already stored and records the difference.
--
-- Deliberately NOT tied to sheet_sources. Everything else in this module is
-- replaced when the sheet is removed and re-registered, and that is right for
-- a copy of a sheet — but this is the one thing no sheet holds. Switching the
-- team from the development copy to their real workbook must not erase it.
-- Rows are matched to leads by company_key (the company, upper-cased), which is
-- also why a renamed company reads as one removed and one added.
--
-- kind:
--   baseline  the first time a lead is seen with nothing stored before it — a
--             starting point, NOT an arrival. Without it the first sync would
--             report the whole list as new this month.
--   added     a lead that appeared in a later sync
--   removed   a lead that disappeared from the sheet
--   stage     stage_no changed (from_stage → to_stage; either may be NULL)
--   status    status changed (from_status → to_status)
-- observed_at is when the SYNC saw the change, not when it happened: a change
-- nobody syncs for a week is dated a week late. The nightly sync script keeps
-- that gap to a day.
CREATE TABLE IF NOT EXISTS export_lead_events (
    id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    company      VARCHAR(200) NOT NULL,
    company_key  VARCHAR(200) NOT NULL,
    kind         VARCHAR(10)  NOT NULL
                 CHECK (kind IN ('baseline', 'added', 'removed', 'stage', 'status')),
    from_stage   SMALLINT,
    to_stage     SMALLINT,
    from_status  VARCHAR(20),
    to_status    VARCHAR(20),
    observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_log_id  UUID REFERENCES sync_logs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_export_lead_events_company  ON export_lead_events (company_key, observed_at);
CREATE INDEX IF NOT EXISTS idx_export_lead_events_observed ON export_lead_events (observed_at);

-- ─── 3. Activity log ──────────────────────────────────────────────────────────
-- The Activity tab: one row per contact with a customer. Unlike the history
-- above, this IS a copy of a sheet, so it belongs to its source and is
-- replaced whole on every sync.
CREATE TABLE IF NOT EXISTS export_activities (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    sheet_row       INTEGER NOT NULL,
    activity_date   DATE NOT NULL,
    company         VARCHAR(200) NOT NULL,
    company_key     VARCHAR(200) NOT NULL,
    -- FALSE when the company is not on the Leads tab. Kept rather than
    -- dropped (the sync reports it), but it cannot feed a lead's Last Contact.
    matched         BOOLEAN NOT NULL,
    activity_type   VARCHAR(30),
    by_person       VARCHAR(100),
    notes           TEXT,
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_export_activities_source  ON export_activities (sheet_source_id);
CREATE INDEX IF NOT EXISTS idx_export_activities_company ON export_activities (company_key, activity_date);
CREATE INDEX IF NOT EXISTS idx_export_activities_date    ON export_activities (activity_date);

-- ─── 4. Grants ────────────────────────────────────────────────────────────────
ALTER TABLE export_lead_events OWNER TO mis_user;
ALTER TABLE export_activities  OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE export_lead_events TO mis_user;
GRANT ALL PRIVILEGES ON TABLE export_activities  TO mis_user;

-- Verify
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name IN ('export_leads', 'export_lead_events', 'export_activities')
ORDER BY table_name, ordinal_position;
