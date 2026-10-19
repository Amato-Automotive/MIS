-- =====================================================================
-- AutoForm MIS — Phase 25: the chatbot's row-level security, revised.
--
-- Replaces every mis_chatbot policy phase 18 created. See AI_CHATBOT_PLAN.md
-- §5. Phase 18's policies were wrong three ways (Sales/OE gated on per-source
-- grants that only Finance has; leads scoped on uploaded_by, which the app
-- dropped; no idea OE reps are row-scoped). Since then, four OE tables and
-- three Export tables arrived that it never granted. And one hole matters more
-- than all of those:
--
--   THE SCOPE WAS FORGEABLE. Phase 18 read the user's scope from session
--   settings (app.sheet_sources …). set_config() is an ordinary function, so
--   the model's own SELECT could rewrite its scope mid-query:
--       WITH s AS MATERIALIZED (SELECT set_config('app.sheet_sources', '…', true))
--       SELECT … FROM s, finance_lines
--   Verified on a scratch copy of this schema (2026-10-19): 0 rows honestly,
--   every row with the CTE. That made the SQL guard the only boundary — and the
--   model reads free text out of the sheets (visit remarks, export notes), so
--   it can be talked into writing exactly that query.
--
--   Now the router sends the whole scope as ONE setting, app.chat_scope, plus
--   an HMAC-style signature in app.chat_scope_sig made with a key mis_chatbot
--   cannot read (chat_scope_key). Every policy reads the scope through
--   chat_scope(), a SECURITY DEFINER function that returns NULL — and so zero
--   rows — unless the signature verifies and the scope has not expired.
--   Rewriting either setting from SQL now fails closed.
--
-- Apply on the VPS (DEPLOYMENT.md §6). Either role works — the migration sets
-- ownership explicitly:
--   sudo -u postgres psql -d autoform_mis -f /home/deploy/MIS/backend/migrate_phase25_chatbot_scope.sql
--
-- Expand-safe: no running code connects as mis_chatbot until the chat router
-- ships, and mis_user owns every table, so it bypasses RLS and the app is
-- unaffected. Idempotent; one transaction.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';   -- see phase 18: fail fast rather than queue behind traffic

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mis_chatbot') THEN
        RAISE EXCEPTION 'Role mis_chatbot not found — apply migrate_phase18_chatbot.sql first.';
    END IF;
END
$$;


-- ---------------------------------------------------------------------
-- 1. The signing key, and the function every policy reads the scope through
-- ---------------------------------------------------------------------
-- One row. 256 bits from gen_random_uuid(), which draws on the OS CSPRNG
-- (built in since PG13, so no pgcrypto). The backend reads it at first use
-- over the APP connection; to rotate, UPDATE the row and restart the backend.
CREATE TABLE IF NOT EXISTS chat_scope_key (
    id  SMALLINT PRIMARY KEY CHECK (id = 1),
    key BYTEA NOT NULL
);
ALTER TABLE chat_scope_key OWNER TO mis_user;
REVOKE ALL ON chat_scope_key FROM PUBLIC;
INSERT INTO chat_scope_key (id, key)
SELECT 1, decode(replace(gen_random_uuid()::text, '-', '') ||
                 replace(gen_random_uuid()::text, '-', ''), 'hex')
ON CONFLICT (id) DO NOTHING;

-- sig = hex(sha256(key || sha256(key || payload))). Nested so a known
-- signature cannot be length-extended into one for a longer payload. The
-- Python side is services/chat_scope.py:sign — the two must stay identical.
--
-- `exp` (epoch seconds) bounds replay: a scope copied out of one answer is
-- dead two minutes later, so it cannot outlive a permission change.
--
-- search_path is pinned with pg_temp LAST: otherwise a temp table named
-- chat_scope_key, created in the caller's session, would be found first.
CREATE OR REPLACE FUNCTION chat_scope() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    payload text := current_setting('app.chat_scope', true);
    sig     text := current_setting('app.chat_scope_sig', true);
    k       bytea;
    doc     jsonb;
BEGIN
    IF payload IS NULL OR payload = '' OR sig IS NULL OR sig = '' THEN
        RETURN NULL;
    END IF;
    SELECT key INTO k FROM public.chat_scope_key WHERE id = 1;
    IF k IS NULL OR encode(sha256(k || sha256(k || convert_to(payload, 'UTF8'))), 'hex') <> sig THEN
        RETURN NULL;
    END IF;
    doc := payload::jsonb;
    IF (doc ->> 'exp')::bigint < extract(epoch FROM clock_timestamp()) THEN
        RETURN NULL;
    END IF;
    RETURN doc;
EXCEPTION WHEN others THEN
    RETURN NULL;   -- malformed payload: no scope, so no rows
END
$$;
ALTER FUNCTION chat_scope() OWNER TO mis_user;
REVOKE ALL ON FUNCTION chat_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_scope() TO mis_chatbot;


-- ---------------------------------------------------------------------
-- 2. Grants — an explicit allowlist, rebuilt from scratch
-- ---------------------------------------------------------------------
-- Still absent, deliberately: users, asm_portal_users, asm_portal_otps,
-- user_module_access, user_sheet_source_access, chat_scope_key, chat_usage.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mis_chatbot;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mis_chatbot;

GRANT SELECT ON
    plant_to_depot_sales, distributor_sales,
    finance_lines, balance_sheet_lines, profit_loss_lines,
    sheet_sources,
    oe_visit_plans, oe_targets, oe_dealerships,
    oe_dealer_monthly, oe_dealer_targets,
    oe_oem_targets, oe_oem_target_annual,
    export_activities, export_lead_events
TO mis_chatbot;

-- Column grants where a table carries contact details or free-form error text.
-- No business question needs a customer's phone number, and every row the
-- chatbot reads is sent to the model provider — so the columns it can read
-- stop at what an answer needs. sync_logs/upload_logs error_details quote raw
-- sheet rows, which name other reps' dealers.
--
-- Built from information_schema rather than typed out, so a column added later
-- is picked up by re-running this file. Note the default is the other way
-- round: until it is re-run, a NEW column on these five tables is unreadable.
DO $$
DECLARE
    t      text;
    denied text[];
    cols   text;
    hidden jsonb := '{
        "leads":        ["mobile_number"],
        "upload_logs":  ["error_details"],
        "sync_logs":    ["error_details", "synced_by"],
        "oe_visit_logs":["contact_number", "email", "photo_link"],
        "export_leads": ["contact_email", "contact_phone"]
    }';
BEGIN
    FOR t IN SELECT jsonb_object_keys(hidden) LOOP
        denied := ARRAY(SELECT jsonb_array_elements_text(hidden -> t));
        -- A denied column that does not exist is a typo, and a typo here would
        -- quietly grant the column it meant to hide.
        IF EXISTS (SELECT 1 FROM unnest(denied) d
                   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                                     WHERE c.table_schema = 'public' AND c.table_name = t
                                       AND c.column_name = d)) THEN
            RAISE EXCEPTION 'phase 25: a hidden column listed for % does not exist', t;
        END IF;
        SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name <> ALL (denied);
        EXECUTE format('GRANT SELECT (%s) ON %I TO mis_chatbot', cols, t);
    END LOOP;
END
$$;


-- ---------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------
-- The signed scope, as services/chat_scope.py builds it:
--   modules          data modules the user holds   ["leads","finance",…]   (never "chat")
--   finance_sources  sheet_sources ids — Finance is the one per-company module
--   source_modules   sheet_sources.module strings visible  ["sales_plant_to_depot",…]
--   oe_scoped        false = sees all OE rows; true = a field rep
--   oe_names         per table, the rep's literal spellings there (services/oe_scope.py)
--   exp              epoch seconds after which the scope is void
--
-- Every module is gated on `modules`, NOT on a source list, except Finance.
-- That mirrors the routers: only Finance grants per source. It also matters
-- for real rows — plant_to_depot_sales.sheet_source_id and
-- oe_dealer_monthly.sheet_source_id are nullable (scripts/load_dealer_data_file
-- loads dealer rows with none), and a source gate would hide rows the app shows.
--
-- `(SELECT chat_scope())` rather than a bare call: as an uncorrelated
-- sub-select it runs once per query (an InitPlan), not once per row.
--
-- Every predicate is NULL — no rows — when the scope is missing, unsigned,
-- expired or lacks the key it needs. `oe_scoped` is compared to the literal
-- 'false', so a scope that forgets it scopes the user instead of freeing them.
DO $$
DECLARE
    s   constant text := '(SELECT chat_scope())';
    has constant text := '(SELECT chat_scope()) -> ''modules'' ? %L';
    rep constant text := '((SELECT chat_scope()) ->> ''oe_scoped'' = ''false'' '
                         'OR (SELECT chat_scope()) -> ''oe_names'' -> %L ? salesperson)';
    policies jsonb;
    t   text;
BEGIN
    policies := jsonb_build_object(
        -- Leads and Sales: module-level, as in routers/leads.py, sales.py,
        -- distributor_sales.py. upload_logs.module is a module key ('leads').
        'leads',                format(has, 'leads'),
        'upload_logs',          s || ' -> ''modules'' ? module',
        'plant_to_depot_sales', format(has, 'sales'),
        'distributor_sales',    format(has, 'sales'),

        -- Finance: per company (get_user_sheet_source_ids(module="finance")).
        'finance_lines',        format(has, 'finance') || ' AND ' || s || ' -> ''finance_sources'' ? sheet_source_id::text',
        'balance_sheet_lines',  format(has, 'finance') || ' AND ' || s || ' -> ''finance_sources'' ? sheet_source_id::text',
        'profit_loss_lines',    format(has, 'finance') || ' AND ' || s || ' -> ''finance_sources'' ? sheet_source_id::text',

        -- The registry: a Finance row by its own id, anything else by module.
        'sheet_sources',        'CASE WHEN module = ''finance'' THEN ' || s || ' -> ''finance_sources'' ? id::text '
                                'ELSE ' || s || ' -> ''source_modules'' ? module END',
        'sync_logs',            s || ' -> ''source_modules'' ? module',

        -- OE tables that name a person: the module, then (unscoped OR one of
        -- the rep's spellings in THIS table). salesperson IS NULL rows —
        -- unattributed MSIL/TATA accessories in oe_targets — are nobody's, so
        -- a rep does not see them, exactly as on the Targets tab.
        'oe_visit_plans',       format(has, 'oe_network') || ' AND ' || format(rep, 'oe_visit_plans'),
        'oe_visit_logs',        format(has, 'oe_network') || ' AND ' || format(rep, 'oe_visit_logs'),
        'oe_targets',           format(has, 'oe_network') || ' AND ' || format(rep, 'oe_targets'),
        -- Dealers: by who the outlet is ASSIGNED to (the Dealers tab's d.salesperson).
        'oe_dealerships',       format(has, 'oe_network') || ' AND ' || format(rep, 'oe_dealerships'),

        -- Dealer facts carry no person; they inherit the dealer's visibility.
        -- The EXISTS is itself subject to oe_dealerships' policy, so the rep
        -- rule lives in one place and cannot drift between three tables.
        'oe_dealer_monthly',    format(has, 'oe_network') || ' AND EXISTS (SELECT 1 FROM public.oe_dealerships d '
                                'WHERE d.id = oe_dealer_monthly.dealer_id)',
        'oe_dealer_targets',    format(has, 'oe_network') || ' AND EXISTS (SELECT 1 FROM public.oe_dealerships d '
                                'WHERE d.id = oe_dealer_targets.dealer_id)',

        -- OEM brand targets are management-only: a rep gets NO rows, not a
        -- slice (routers/oe_oem_targets.py:_refuse_if_scoped). "Nothing of
        -- theirs to filter" is not "safe to show".
        'oe_oem_targets',       format(has, 'oe_network') || ' AND ' || s || ' ->> ''oe_scoped'' = ''false''',
        'oe_oem_target_annual', format(has, 'oe_network') || ' AND ' || s || ' ->> ''oe_scoped'' = ''false''',

        -- Export: module-level, as routers/export.py.
        'export_leads',         format(has, 'export'),
        'export_activities',    format(has, 'export'),
        'export_lead_events',   format(has, 'export')
    );

    FOR t IN SELECT jsonb_object_keys(policies) LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

        -- Kept from phase 18 and added to the new tables: the app's explicit
        -- pass. mis_user owns every table and bypasses RLS anyway; this stops
        -- an ownership change from silently zeroing the whole MIS.
        EXECUTE format('DROP POLICY IF EXISTS app_full_access ON %I', t);
        EXECUTE format('CREATE POLICY app_full_access ON %I FOR ALL TO mis_user '
                       'USING (true) WITH CHECK (true)', t);

        EXECUTE format('DROP POLICY IF EXISTS chatbot_read_all ON %I', t);   -- phase 18's open tables
        EXECUTE format('DROP POLICY IF EXISTS chatbot_scope ON %I', t);
        EXECUTE format('CREATE POLICY chatbot_scope ON %I FOR SELECT TO mis_chatbot USING (%s)',
                       t, policies ->> t);
    END LOOP;
END
$$;


-- ---------------------------------------------------------------------
-- 4. The question log — spend cap, audit trail, tuning data
-- ---------------------------------------------------------------------
-- Written by the app connection, one row per question. Never granted to
-- mis_chatbot: it holds every user's questions.
CREATE TABLE IF NOT EXISTS chat_usage (
    id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    question           TEXT NOT NULL,
    tier               VARCHAR(10) NOT NULL,          -- tier that produced the answer: light | heavy
    escalated          BOOLEAN NOT NULL DEFAULT FALSE,
    escalation_reason  TEXT,
    status             VARCHAR(20) NOT NULL,          -- ok | error | refused | budget | iteration_limit
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cost_usd           NUMERIC(10, 6) NOT NULL DEFAULT 0,
    sql_log            JSONB,                         -- [{tier, query, rows, error}]
    error              TEXT,
    latency_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_usage_created ON chat_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_usage_user    ON chat_usage (user_id, created_at);
ALTER TABLE chat_usage OWNER TO mis_user;
REVOKE ALL ON chat_usage FROM PUBLIC;

COMMIT;


-- =====================================================================
-- Verification. The full matrix is automated: backend/tests/test_chat_rls.py
-- runs it against a scratch database (see that file's docstring). On prod,
-- the quick checks:
-- =====================================================================

-- (a) 20 tables, each with exactly app_full_access + chatbot_scope.
-- SELECT c.relname, c.relrowsecurity, array_agg(p.polname ORDER BY p.polname)
-- FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE n.nspname = 'public' AND c.relrowsecurity
-- GROUP BY 1, 2 ORDER BY 1;

-- (b) As a real mis_chatbot login (not SET ROLE), with no scope set, every
--     table reads 0 rows and `SELECT count(*) FROM users` is permission denied:
--   psql "$CHATBOT_DATABASE_URL" -c "SELECT count(*) FROM oe_visit_logs"   -- 0
--   psql "$CHATBOT_DATABASE_URL" -c "SELECT count(*) FROM users"           -- ERROR

-- (c) The real scope, end to end, per user — counts from the chatbot's view
--     beside the app's own count:
--   cd ~/MIS/backend && venv/bin/python -m scripts.chat_scope_check you@autoformindia.com


-- =====================================================================
-- Rollback — back to "the chatbot reads nothing". (Phase 18's policies are
-- not restored: they were wrong.)
-- =====================================================================
-- BEGIN;
-- DO $rb$
-- DECLARE t text;
-- BEGIN
--     FOR t IN SELECT DISTINCT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--              WHERE p.polname = 'chatbot_scope' LOOP
--         EXECUTE format('DROP POLICY chatbot_scope ON %I', t);
--     END LOOP;
-- END $rb$;
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mis_chatbot;
-- DROP FUNCTION IF EXISTS chat_scope();
-- DROP TABLE IF EXISTS chat_scope_key;
-- -- chat_usage is kept: it is the record of what was spent.
-- COMMIT;
