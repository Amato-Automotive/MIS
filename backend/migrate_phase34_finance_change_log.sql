-- Who changed a finance company's name / group / roll-up flag, and when.
-- (Found out the hard way: RPAS Unit's group went back to NULL and nothing recorded who did it.)
CREATE TABLE IF NOT EXISTS finance_change_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id       UUID,
    user_email    VARCHAR(255),
    action        VARCHAR(20) NOT NULL,      -- 'update' | 'delete'
    source_id     UUID,                      -- no FK: the row must outlive a deleted company
    company_label VARCHAR(100),
    field         VARCHAR(30),               -- label | company_group | is_rollup | NULL for delete
    old_value     TEXT,
    new_value     TEXT
);
CREATE INDEX IF NOT EXISTS ix_finance_change_log_at ON finance_change_log (at DESC);
CREATE INDEX IF NOT EXISTS ix_finance_change_log_source ON finance_change_log (source_id);
