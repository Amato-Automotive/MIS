"""
The chatbot's row-level security, end to end, against a real Postgres.

Everything else in the chat feature can be unit-tested; this cannot. The
policies live in the database, and the question is whether a real mis_chatbot
login, handed the scope services/chat_scope.py builds from real user rows,
reads exactly what the app's routers would show that user — and whether it
reads NOTHING when the scope is missing, forged, expired or rewritten from SQL.

Skipped unless two DSNs point at a SCRATCH database with every migration
applied (phase 25 included):

    CHAT_TEST_DSN          owner connection (mis_user), used to seed rows
    CHAT_TEST_CHATBOT_DSN  a mis_chatbot login on the same database

It seeds and then deletes rows, so it refuses to run on any database that has
users in it — which rules out prod and the 5433 tunnel to it. The recipe for a
scratch database (local Postgres, migrations replayed in prod's order) is in
AI_CHATBOT_PLAN.md §10, "Testing the RLS".
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

OWNER_DSN = os.getenv("CHAT_TEST_DSN")
CHATBOT_DSN = os.getenv("CHAT_TEST_CHATBOT_DSN")
pytestmark = pytest.mark.skipif(not (OWNER_DSN and CHATBOT_DSN),
                                reason="CHAT_TEST_DSN / CHAT_TEST_CHATBOT_DSN not set (scratch DB only)")

from services.chat_scope import ChatScope, build_chat_scope, scope_key, sign  # noqa: E402

TABLES = [
    "leads", "upload_logs", "plant_to_depot_sales", "distributor_sales",
    "finance_lines", "balance_sheet_lines", "profit_loss_lines", "sheet_sources", "sync_logs",
    "oe_visit_plans", "oe_visit_logs", "oe_targets", "oe_dealerships",
    "oe_dealer_monthly", "oe_dealer_targets", "oe_oem_targets", "oe_oem_target_annual",
    "export_leads", "export_activities", "export_lead_events",
]
# What each user may see, per table — derived by hand from the routers' rules,
# NOT from the policies, so a policy that drifts from the app fails here.
#   superadmin  everything
#   mgr         sales + finance (company A only) + oe_network unscoped
#   rep         oe_network as PANKAJ; no OEM brand targets
#   leadsonly   leads
#   exporter    export
EXPECTED = {
    "superadmin": {"leads": 1, "upload_logs": 1, "plant_to_depot_sales": 2, "distributor_sales": 1,
                   "finance_lines": 2, "balance_sheet_lines": 0, "profit_loss_lines": 0,
                   # master + A + B + ptd + dd + 5 OE + export
                   "sheet_sources": 11, "sync_logs": 3,
                   "oe_visit_plans": 2, "oe_visit_logs": 3, "oe_targets": 3, "oe_dealerships": 2,
                   "oe_dealer_monthly": 2, "oe_dealer_targets": 2, "oe_oem_targets": 1,
                   "oe_oem_target_annual": 1, "export_leads": 1, "export_activities": 1,
                   "export_lead_events": 1},
    "mgr": {"leads": 0, "upload_logs": 0, "plant_to_depot_sales": 2, "distributor_sales": 1,
            "finance_lines": 1, "balance_sheet_lines": 0, "profit_loss_lines": 0,
            # master + company A (both granted) + ptd + dd + 5 OE; NOT company B
            "sheet_sources": 9, "sync_logs": 2,
            "oe_visit_plans": 2, "oe_visit_logs": 3, "oe_targets": 3, "oe_dealerships": 2,
            "oe_dealer_monthly": 2, "oe_dealer_targets": 2, "oe_oem_targets": 1,
            "oe_oem_target_annual": 1, "export_leads": 0, "export_activities": 0,
            "export_lead_events": 0},
    # PANKAJ: the log book spells him "PANKAJ VIG", the plans and dealer master
    # "PANKAJ" — token matching must catch both. The unattributed (NULL)
    # oe_targets row is nobody's. The dealer-monthly row with NO sheet source
    # (loaded by scripts/load_dealer_data_file) must still be visible.
    "rep": {"leads": 0, "upload_logs": 0, "plant_to_depot_sales": 0, "distributor_sales": 0,
            "finance_lines": 0, "balance_sheet_lines": 0, "profit_loss_lines": 0,
            "sheet_sources": 5, "sync_logs": 1,
            "oe_visit_plans": 1, "oe_visit_logs": 2, "oe_targets": 1, "oe_dealerships": 1,
            "oe_dealer_monthly": 1, "oe_dealer_targets": 1, "oe_oem_targets": 0,
            "oe_oem_target_annual": 0, "export_leads": 0, "export_activities": 0,
            "export_lead_events": 0},
    "leadsonly": {t: 0 for t in TABLES} | {"leads": 1, "upload_logs": 1},
    "exporter": {t: 0 for t in TABLES} | {"sheet_sources": 1, "sync_logs": 1, "export_leads": 1,
                                          "export_activities": 1, "export_lead_events": 1},
}


@pytest.fixture(scope="module")
def owner():
    eng = create_engine(OWNER_DSN)
    with eng.connect() as c:
        if c.execute(text("SELECT count(*) FROM users")).scalar():
            pytest.fail("CHAT_TEST_DSN has users in it — this test seeds rows and only runs on a scratch DB")
        if c.execute(text("SELECT current_user")).scalar() == "mis_chatbot":
            pytest.fail("CHAT_TEST_DSN must be the owner (mis_user), not mis_chatbot")
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def chatbot():
    eng = create_engine(CHATBOT_DSN)
    with eng.connect() as c:
        assert c.execute(text("SELECT current_user")).scalar() == "mis_chatbot"
    yield eng
    eng.dispose()


def _id():
    return str(uuid.uuid4())


@pytest.fixture(scope="module")
def world(owner):
    """Seed one small, deliberately awkward world; delete it afterwards."""
    ids = {k: _id() for k in ("u_admin", "u_mgr", "u_rep", "u_leads", "u_exp",
                              "fin_master", "fin_a", "fin_b", "ptd", "dd", "plan", "log", "tgt",
                              "dealer_data", "oemtgt", "exp_src", "d1", "d2", "up")}
    stmts = [
        ("INSERT INTO users (id, name, email, password_hash, role, oe_salesperson) VALUES "
         "(:u_admin,'Admin','a@x','-', 'superadmin', 'PANKAJ'),"      # superadmin is NEVER scoped
         "(:u_mgr,'Mgr','m@x','-','management', NULL),"
         "(:u_rep,'Pankaj','p@x','-','staff','PANKAJ'),"
         "(:u_leads,'Lee','l@x','-','staff', NULL),"
         "(:u_exp,'Exa','e@x','-','staff', NULL)"),
        ("INSERT INTO user_module_access (user_id, module) VALUES "
         "(:u_mgr,'sales'),(:u_mgr,'finance'),(:u_mgr,'oe_network'),(:u_mgr,'chat'),"
         "(:u_rep,'oe_network'),(:u_rep,'chat'),(:u_leads,'leads'),(:u_exp,'export')"),
        ("INSERT INTO sheet_sources (id, module, sheet_id, label, kind) VALUES "
         "(:fin_master,'finance','m1','Master','master'),(:fin_a,'finance','A','Company A','company'),"
         "(:fin_b,'finance','B','Company B','company'),"
         "(:ptd,'sales_plant_to_depot','p','PTD',NULL),(:dd,'sales_depot_to_distributor','d','DD',NULL),"
         "(:plan,'oe_visit_plan','pl','Plan',NULL),(:log,'oe_log_book','lg','Log',NULL),"
         "(:tgt,'oe_targets','tg','Targets',NULL),(:dealer_data,'oe_dealer_data','dd2','Dealers',NULL),"
         "(:oemtgt,'oe_oem_targets','ot','OEM',NULL),(:exp_src,'export_leads','ex','Export',NULL)"),
        "INSERT INTO user_sheet_source_access (user_id, sheet_source_id) VALUES (:u_mgr,:fin_master),(:u_mgr,:fin_a)",
        ("INSERT INTO finance_lines (sheet_source_id, tab_title, cadence, section_key, section_label, entity_type,"
         " line_key, line_label, period_start_date, period_end_date, period_type, amount) VALUES "
         "(:fin_a,'t','monthly','pl','P&L','line_item','k','K','2026-04-01','2026-04-30','monthly',1),"
         "(:fin_b,'t','monthly','pl','P&L','line_item','k','K','2026-04-01','2026-04-30','monthly',2)"),
        ("INSERT INTO plant_to_depot_sales (sale_year, sale_month, depot, brand, category, amount, sheet_source_id) VALUES "
         "(2026,4,'Janak Motors','Autoform','Seat Cover',10,:ptd),(2026,5,'United Auto','Autoform','Mats',5,NULL)"),
        ("INSERT INTO distributor_sales (sheet_source_id, entity_type, distributor, sale_year, sale_month, category, amount)"
         " VALUES (:dd,'distributor','X',2026,4,'SAM',1)"),
        ("INSERT INTO upload_logs (id, module, filename) VALUES (:up,'leads','f.xlsx')"),
        "INSERT INTO leads (lead_date, source, mobile_number, upload_log_id) VALUES ('2026-04-01','IVR','9999999999',:up)",
        ("INSERT INTO oe_visit_logs (sheet_source_id, visit_date, log_year, log_month, salesperson, dealership, contact_mode)"
         " VALUES (:log,'2026-09-01',2026,9,'PANKAJ VIG','A','Visit'),(:log,'2026-09-02',2026,9,'PANKAJ VIG','B','Calling'),"
         "(:log,'2026-09-03',2026,9,'UMESH KALE','C','Visit')"),
        ("INSERT INTO oe_visit_plans (sheet_source_id, salesperson, plan_year, plan_month, dealer_name) VALUES "
         "(:plan,'PANKAJ',2026,9,'A'),(:plan,'UMESH',2026,9,'C')"),
        ("INSERT INTO oe_targets (sheet_source_id, fy_year, quarter, period_year, period_month, oem, salesperson) VALUES "
         "(:tgt,2026,2,2026,9,'MSIL','PANKAJ'),(:tgt,2026,2,2026,9,'MSIL','UMESH'),(:tgt,2026,2,2026,9,'MSIL',NULL)"),
        ("INSERT INTO oe_dealerships (id, oem, state, city, name, salesperson) VALUES "
         "(:d1,'MSIL','Bihar','PATNA','A','PANKAJ'),(:d2,'MSIL','Bihar','GAYA','C','UMESH')"),
        ("INSERT INTO oe_dealer_monthly (dealer_id, sheet_source_id, month, ys_sale) VALUES "
         "(:d1,NULL,'2026-09-01',3),(:d2,:dealer_data,'2026-09-01',4)"),
        ("INSERT INTO oe_dealer_targets (dealer_id, sheet_source_id, quarter, fy_year, period_start, period_end, target)"
         " VALUES (:d1,:dealer_data,'Q2',2026,'2026-07-01','2026-09-30',10),(:d2,:dealer_data,'Q2',2026,'2026-07-01','2026-09-30',20)"),
        ("INSERT INTO oe_oem_targets (sheet_source_id, fy_year, period_year, period_month, quarter, oem, product)"
         " VALUES (:oemtgt,2026,2026,9,2,'MSIL','SEAT COVER')"),
        "INSERT INTO oe_oem_target_annual (sheet_source_id, fy_year, oem, product) VALUES (:oemtgt,2026,'MSIL','SEAT COVER')",
        "INSERT INTO export_leads (sheet_source_id, sheet_row, company, contact_email) VALUES (:exp_src,2,'Acme','a@acme')",
        ("INSERT INTO export_activities (sheet_source_id, sheet_row, activity_date, company, company_key, matched)"
         " VALUES (:exp_src,2,'2026-09-01','Acme','ACME',true)"),
        "INSERT INTO export_lead_events (company, company_key, kind) VALUES ('Acme','ACME','baseline')",
        ("INSERT INTO sync_logs (module, source_label, error_details) VALUES "
         "('oe_log_book','lg','row 4: dealer X'),('finance','m1',NULL),('export_leads','ex',NULL)"),
    ]
    with owner.begin() as c:
        for s in stmts:
            c.execute(text(s), ids)
    yield ids
    with owner.begin() as c:
        for t in ["export_lead_events", "export_activities", "export_leads", "sync_logs", "leads", "upload_logs",
                  "oe_dealer_monthly", "oe_dealer_targets", "oe_oem_target_annual", "oe_oem_targets",
                  "oe_visit_logs", "oe_visit_plans", "oe_targets", "oe_dealerships", "finance_lines",
                  "plant_to_depot_sales", "distributor_sales", "user_sheet_source_access",
                  "user_module_access", "chat_usage", "sheet_sources", "users"]:
            c.execute(text(f"DELETE FROM {t}"))


@pytest.fixture(scope="module")
def app_session(owner):
    S = sessionmaker(bind=owner)
    s = S()
    yield s
    s.close()


def _scope_for(app_session, user_id) -> ChatScope:
    from models import User
    u = app_session.query(User).filter(User.id == user_id).one()
    return build_chat_scope(app_session, u)


def _count(chatbot, table, payload, sig, prelude: str = ""):
    with chatbot.connect() as c:
        with c.begin():
            c.execute(text("SELECT set_config('app.chat_scope', :p, true), set_config('app.chat_scope_sig', :s, true)"),
                      {"p": payload, "s": sig})
            return c.execute(text(f"{prelude} SELECT count(*) FROM {table}")).scalar()


def _signed(app_session, scope: ChatScope, now=None):
    p = scope.payload(now)
    return p, sign(scope_key(app_session, refresh=True), p)


USERS = {"superadmin": "u_admin", "mgr": "u_mgr", "rep": "u_rep", "leadsonly": "u_leads", "exporter": "u_exp"}


@pytest.mark.parametrize("who", list(EXPECTED))
def test_each_user_sees_what_the_app_shows(world, app_session, chatbot, who):
    scope = _scope_for(app_session, world[USERS[who]])
    p, s = _signed(app_session, scope)
    got = {t: _count(chatbot, t, p, s) for t in TABLES}
    assert got == EXPECTED[who]


def test_scope_builder_matches_the_routers(world, app_session):
    admin = _scope_for(app_session, world["u_admin"])
    assert admin.oe_scoped is False, "superadmin must never be OE-scoped, whatever oe_salesperson says"
    rep = _scope_for(app_session, world["u_rep"])
    assert rep.oe_scoped is True and rep.oe_salesperson == "PANKAJ"
    assert rep.oe_names["oe_visit_logs"] == ["PANKAJ VIG"]
    assert rep.oe_names["oe_visit_plans"] == ["PANKAJ"]
    mgr = _scope_for(app_session, world["u_mgr"])
    assert "chat" not in mgr.modules, "chat opens the page; it must never become a data grant"
    assert set(mgr.finance_sources) == {world["fin_master"], world["fin_a"]}
    assert mgr.finance_labels == ("Company A",)


@pytest.mark.parametrize("table", TABLES)
def test_no_scope_reads_nothing(chatbot, world, table):
    with chatbot.connect() as c:
        assert c.execute(text(f"SELECT count(*) FROM {table}")).scalar() == 0


def test_rewriting_the_scope_from_sql_fails_closed(world, app_session, chatbot):
    """The attack phase 18 was open to: the query rewrites its own scope."""
    rep = _scope_for(app_session, world["u_rep"])
    p, s = _signed(app_session, rep)
    admin_payload = _scope_for(app_session, world["u_admin"]).payload()
    attack = ("WITH x AS MATERIALIZED (SELECT set_config('app.chat_scope', :atk, true)) "
              "SELECT count(*) FROM x, LATERAL (SELECT 1 FROM oe_visit_logs) l")
    with chatbot.connect() as c, c.begin():
        c.execute(text("SELECT set_config('app.chat_scope', :p, true), set_config('app.chat_scope_sig', :s, true)"),
                  {"p": p, "s": s})
        assert c.execute(text("SELECT count(*) FROM oe_visit_logs")).scalar() == 2   # the rep's own
        assert c.execute(text(attack), {"atk": admin_payload}).scalar() == 0


def test_forged_expired_and_unsigned_scopes_read_nothing(world, app_session, chatbot):
    admin = _scope_for(app_session, world["u_admin"])
    p, s = _signed(app_session, admin)
    assert _count(chatbot, "oe_visit_logs", p, s) == 3                     # control
    assert _count(chatbot, "oe_visit_logs", p, "0" * 64) == 0              # forged signature
    assert _count(chatbot, "oe_visit_logs", p, sign(b"wrong key", p)) == 0
    assert _count(chatbot, "oe_visit_logs", p, "") == 0                    # unsigned
    old_p, old_s = _signed(app_session, admin, now=1_000_000_000)           # expired in 2001
    assert _count(chatbot, "oe_visit_logs", old_p, old_s) == 0
    assert _count(chatbot, "oe_visit_logs", "not json", sign(scope_key(app_session), "not json")) == 0


def test_identity_tables_and_hidden_columns_are_unreadable(world, app_session, chatbot):
    admin = _scope_for(app_session, world["u_admin"])
    p, s = _signed(app_session, admin)
    for q in ["SELECT count(*) FROM users", "SELECT count(*) FROM user_module_access",
              "SELECT count(*) FROM chat_scope_key", "SELECT count(*) FROM chat_usage",
              "SELECT mobile_number FROM leads", "SELECT error_details FROM sync_logs",
              "SELECT contact_number FROM oe_visit_logs", "SELECT contact_email FROM export_leads",
              "SELECT * FROM leads"]:
        with chatbot.connect() as c, c.begin():
            c.execute(text("SELECT set_config('app.chat_scope', :p, true), set_config('app.chat_scope_sig', :s, true)"),
                      {"p": p, "s": s})
            with pytest.raises(Exception, match="permission denied"):
                c.execute(text(q))
    # The rest of those tables stays readable.
    assert _count(chatbot, "leads", p, s) == 1


def test_the_chatbot_cannot_write(world, chatbot):
    for q in ["DELETE FROM leads", "CREATE TEMP TABLE chat_scope_key (id int)", "UPDATE sync_logs SET status = 'x'"]:
        with chatbot.connect() as c, c.begin():
            with pytest.raises(Exception, match="read-only transaction|permission denied"):
                c.execute(text(q))


@pytest.mark.parametrize("email", ["a@x", "m@x", "p@x", "l@x", "e@x"])
def test_the_prod_check_script_agrees(world, owner, chatbot, monkeypatch, capsys, email):
    """scripts/chat_scope_check.py is what gets run on prod before anyone is
    given the chat module. Both its connections are pointed at the scratch
    database here — never at whatever .env says."""
    import scripts.chat_scope_check as check
    from services import chat_db
    monkeypatch.setattr(check, "SessionLocal", sessionmaker(bind=owner))
    monkeypatch.setattr(chat_db, "_engine", chatbot)
    rc = check.main(email)
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "MISMATCH" not in out and "LEAK" not in out


def test_benchmark_reference_sql_runs_as_the_chatbot(world, app_session, chatbot):
    """A reference query with a wrong column would fail every benchmark run on
    prod, where nobody can fix it quickly."""
    import json
    from pathlib import Path
    from services.sql_guard import guard_sql
    fixtures = json.loads((Path(__file__).parent / "chat_benchmark.json").read_text(encoding="utf-8"))
    admin = _scope_for(app_session, world["u_admin"])
    p, s = _signed(app_session, admin)
    for f in fixtures:
        for k in ("reference_sql", "capability_sql"):
            if k in f:
                with chatbot.connect() as c, c.begin():
                    c.execute(text("SELECT set_config('app.chat_scope', :p, true), "
                                   "set_config('app.chat_scope_sig', :s, true)"), {"p": p, "s": s})
                    c.connection.driver_connection.cursor().execute(guard_sql(f[k])[0])


def test_every_documented_column_is_readable(world, app_session, chatbot):
    """The schema prompt may only name what mis_chatbot can SELECT — a hidden
    column in the prompt would send the model into permission errors."""
    from services.chat_schema import DOCUMENTED_COLUMNS
    admin = _scope_for(app_session, world["u_admin"])
    p, s = _signed(app_session, admin)
    for table, cols in DOCUMENTED_COLUMNS.items():
        with chatbot.connect() as c, c.begin():
            c.execute(text("SELECT set_config('app.chat_scope', :p, true), set_config('app.chat_scope_sig', :s, true)"),
                      {"p": p, "s": s})
            c.execute(text(f"SELECT {', '.join(cols)} FROM {table} LIMIT 0"))
