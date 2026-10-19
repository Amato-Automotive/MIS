"""The guard is defence in depth (the database is the boundary), but it is also
what keeps set_config() and friends from ever reaching the database, and what
decides escalation. Both are plausible-looking-wrong territory."""
import pytest

from services.sql_guard import MAX_ROWS, GuardError, guard_sql


@pytest.mark.parametrize("q", [
    "SELECT rows_updated, rows_deleted FROM sync_logs",          # the old grep's false positive
    "WITH m AS (SELECT sale_month, SUM(amount) a FROM plant_to_depot_sales GROUP BY 1) SELECT * FROM m",
    "SELECT count(*) FROM leads",
    "SELECT salesperson FROM oe_visit_logs WHERE salesperson ILIKE '%PANKAJ%'",
    "SELECT date_trunc('month', visit_date), count(*) FROM oe_visit_logs GROUP BY 1 ORDER BY 1",
    "(SELECT 1 AS x) UNION ALL (SELECT 2)",
    "SELECT round(avg(car_sales)::numeric, 1), split_part(salesperson, ' ', 1) FROM oe_visit_logs GROUP BY 2",
    "SELECT age(current_date, max(visit_date)) FROM oe_visit_logs;",
], ids=range(8))
def test_reads_pass(q):
    sql, _ = guard_sql(q)
    assert sql.startswith("SELECT * FROM (\n") and sql.endswith(f"LIMIT {MAX_ROWS + 1}")


@pytest.mark.parametrize("q,why", [
    ("SELECT set_config('app.chat_scope', '{}', true)", "set_config"),
    ("WITH s AS (SELECT set_config('app.chat_scope','x',true)) SELECT count(*) FROM s, leads", "set_config"),
    ("SELECT query_to_xml('select * from users', true, true, '')", "query_to_xml"),
    ("SELECT current_setting('app.chat_scope')", "current_setting"),
    ("SELECT pg_sleep(30)", "pg_sleep"),
    ("SELECT lo_import('/etc/passwd')", "lo_import"),
    ("SELECT * FROM pg_catalog.set_config('a','b',true)", "set_config"),
    ("SELECT 1; SELECT 2", "exactly one"),
    ("UPDATE leads SET state = 'x'", "Only SELECT"),
    ("DELETE FROM leads", "Only SELECT"),
    ("WITH d AS (DELETE FROM leads RETURNING id) SELECT count(*) FROM d", "read-only"),
    ("SELECT * INTO copy FROM leads", "read-only"),
    ("SELECT id FROM leads FOR UPDATE", "read-only"),
    ("SELECT * FROM leads", "SELECT \\* on a table"),
    ("SELECT l.* FROM leads l", "SELECT \\* on a table"),
    ("WITH m AS (SELECT 1 AS x) SELECT m.*, l.mobile FROM m JOIN leads l ON true", "SELECT \\* on a table"),
    ("COPY leads TO STDOUT", "Only SELECT"),
    ("", "Empty"),
], ids=range(18))
def test_refused(q, why):
    with pytest.raises(GuardError, match=why):
        guard_sql(q)


@pytest.mark.parametrize("q,reason", [
    ("SELECT 1 FROM oe_visit_logs l JOIN oe_dealerships d ON d.id = l.dealer_id "
     "JOIN oe_dealer_monthly m ON m.dealer_id = d.id", "3 tables"),
    ("SELECT salesperson, rank() OVER (ORDER BY count(*) DESC) FROM oe_visit_logs GROUP BY 1", "window"),
    ("SELECT sum(amount) FROM finance_lines WHERE section_key IN ('balance_sheet', 'profit_loss_a_c')",
     "Finance sections"),
    ("SELECT 1 FROM oe_dealer_monthly m JOIN oe_dealer_targets t ON t.dealer_id = m.dealer_id", "grains"),
], ids=range(4))
def test_risky_shapes_escalate(q, reason):
    _, shape = guard_sql(q)
    assert reason in shape.escalation_reason()


@pytest.mark.parametrize("q", [
    "SELECT sum(amount) FROM finance_lines WHERE section_key = 'sales_accounts'",
    "WITH a AS (SELECT oem, count(*) n FROM oe_visit_logs GROUP BY 1) SELECT oem, n FROM a",
    "SELECT d.name, count(*) FROM oe_visit_logs l JOIN oe_dealerships d ON d.id = l.dealer_id GROUP BY 1",
], ids=range(3))
def test_ordinary_shapes_stay_on_the_light_tier(q):
    # A CTE alone does not escalate: the light model writes them for simple
    # questions too, and escalating every one would spend the budget.
    _, shape = guard_sql(q)
    assert shape.escalation_reason() is None


def test_cte_names_are_not_counted_as_tables():
    _, shape = guard_sql("WITH a AS (SELECT 1 x FROM leads), b AS (SELECT x FROM a) SELECT x FROM b")
    assert shape.tables == {"leads"}
