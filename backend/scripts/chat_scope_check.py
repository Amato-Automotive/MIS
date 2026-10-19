"""
Check the chatbot's row-level security for one real user, on the real database.

    cd ~/MIS/backend && venv/bin/python -m scripts.chat_scope_check someone@autoformindia.com

Read-only, and makes no model calls (costs nothing). For every table the
chatbot can read it prints two counts side by side:

  chatbot  what a mis_chatbot login reads under this user's signed scope
  app      what the app's own rules give the same user, counted over the app
           connection (module held? Finance company granted? OE rep match?)

They must be equal on every row. Then it tries the attacks the scope is built
to stop — no scope, a forged signature, a scope rewritten from inside the
query — and none may read more than the user honestly can.

Run it for a superadmin, a management user, a Finance user with some companies,
and an OE rep (AI_CHATBOT_PLAN.md §10, step 1b).
"""
import sys

from sqlalchemy import text

from database import SessionLocal
from models import User
from services.chat_db import chat_engine
from services.chat_schema import CHAT_TABLES
from services.chat_scope import build_chat_scope, scope_key, sign
from services.oe_scope import OEScope

MODULE_OF = {
    "leads": "leads", "upload_logs": "leads",
    "plant_to_depot_sales": "sales", "distributor_sales": "sales",
    "finance_lines": "finance", "balance_sheet_lines": "finance", "profit_loss_lines": "finance",
    "oe_visit_plans": "oe_network", "oe_visit_logs": "oe_network", "oe_targets": "oe_network",
    "oe_dealerships": "oe_network", "oe_dealer_monthly": "oe_network", "oe_dealer_targets": "oe_network",
    "oe_oem_targets": "oe_network", "oe_oem_target_annual": "oe_network",
    "export_leads": "export", "export_activities": "export", "export_lead_events": "export",
}


def app_count(db, user, scope, table: str) -> int:
    """The app's rule for this user and table, written independently of the
    policies so the two can disagree."""
    q = lambda sql, **p: db.execute(text(sql), p).scalar()   # noqa: E731
    if table == "sheet_sources":
        return q("SELECT count(*) FROM sheet_sources WHERE (module = 'finance' AND id::text = ANY(:f)) "
                 "OR (module <> 'finance' AND module = ANY(:m))",
                 f=list(scope.finance_sources), m=list(scope.source_modules))
    if table == "sync_logs":
        return q("SELECT count(*) FROM sync_logs WHERE module = ANY(:m)", m=list(scope.source_modules))
    if MODULE_OF[table] not in scope.modules:
        return 0
    if table == "upload_logs":
        return q("SELECT count(*) FROM upload_logs WHERE module = 'leads'")
    if MODULE_OF[table] == "finance":
        return q(f"SELECT count(*) FROM {table} WHERE sheet_source_id::text = ANY(:f)", f=list(scope.finance_sources))
    if MODULE_OF[table] != "oe_network" or not scope.oe_scoped:
        return q(f"SELECT count(*) FROM {table}")
    # An OE rep — the same OEScope.apply the OE routers use.
    if table in ("oe_oem_targets", "oe_oem_target_annual"):
        return 0
    oe = OEScope(db, scope.oe_salesperson)
    where, params = [], {}
    if table in ("oe_dealer_monthly", "oe_dealer_targets"):
        oe.apply(where, params, "d.salesperson", "oe_dealerships")
        return q(f"SELECT count(*) FROM {table} x JOIN oe_dealerships d ON d.id = x.dealer_id WHERE "
                 + " AND ".join(where), **params)
    oe.apply(where, params, "salesperson", table)
    return q(f"SELECT count(*) FROM {table} WHERE " + " AND ".join(where), **params)


def chatbot_count(conn, sql: str, payload: str = None, sig: str = None, params: dict = None) -> int:
    """One count as mis_chatbot, under the given scope (or none)."""
    try:
        if payload is not None:
            conn.execute(text("SELECT set_config('app.chat_scope', :p, true), "
                              "set_config('app.chat_scope_sig', :s, true)"), {"p": payload, "s": sig})
        return conn.execute(text(sql), params or {}).scalar()
    finally:
        conn.rollback()


def main(email: str) -> int:
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            print(f"No user {email}")
            return 2
        scope = build_chat_scope(db, user)
        key = scope_key(db)
        print(f"{user.name} <{email}>  role={user.role}")
        print(f"  modules: {', '.join(scope.modules) or '(none)'}")
        if "finance" in scope.modules:
            print(f"  finance companies: {', '.join(scope.finance_labels) or '(none)'}")
        if "oe_network" in scope.modules:
            print(f"  OE: {'rep ' + repr(scope.oe_salesperson) if scope.oe_scoped else 'unscoped'}")
            if scope.oe_scoped:
                for t, names in scope.oe_names.items():
                    print(f"      {t}: {names}")
        print()

        payload = scope.payload()
        sig = sign(key, payload)
        bad = 0
        print(f"  {'table':<24}{'chatbot':>9}{'app':>9}")
        with chat_engine().connect() as conn:
            for t in sorted(CHAT_TABLES):
                c = chatbot_count(conn, f"SELECT count(*) FROM {t}", payload, sig)
                a = app_count(db, user, scope, t)
                flag = "" if c == a else "   <-- MISMATCH"
                bad += c != a
                print(f"  {t:<24}{c:>9}{a:>9}{flag}")

            # The widest scope the attacker could wish for, unsigned.
            wider = (payload.replace('"oe_scoped":true', '"oe_scoped":false')
                            .replace('"modules":[', '"modules":["leads","oe_network",'))
            both = "(SELECT 1 FROM leads UNION ALL SELECT 1 FROM oe_visit_logs) l"
            honest = chatbot_count(conn, f"SELECT count(*) FROM {both}", payload, sig)
            print(f"\n  attacks (leads + oe_visit_logs; this user may honestly read {honest}):")
            attacks = {   # name: (rows read, most it may read)
                "no scope at all": (chatbot_count(conn, f"SELECT count(*) FROM {both}"), 0),
                "forged signature": (chatbot_count(conn, f"SELECT count(*) FROM {both}", wider, "0" * 64), 0),
                # Reads 0 when the rewrite lands first, the honest count if the
                # scope was already read — never more.
                "scope rewritten inside the query": (chatbot_count(
                    conn, "WITH x AS MATERIALIZED (SELECT set_config('app.chat_scope', :atk, true)) "
                          f"SELECT count(*) FROM x, LATERAL {both}", payload, sig, {"atk": wider}), honest),
            }
            for name, (n, most) in attacks.items():
                bad += n > most
                print(f"    {name:<36}{n:>6}{'' if n <= most else '   <-- LEAK'}")

    print("\nOK — the chatbot reads exactly what the app shows this user." if not bad
          else f"\n{bad} problem(s) — do NOT grant the chat module until fixed.")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
