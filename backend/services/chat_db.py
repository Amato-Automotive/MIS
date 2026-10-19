"""
AutoForm MIS — running the chatbot's SQL as the mis_chatbot role.

⚠️  This connection IS the security boundary, so it checks itself. mis_user
owns every table and therefore bypasses row-level security: pointed at
DATABASE_URL by mistake, the chatbot would show every user every company's
data with no error anywhere. So the engine refuses to serve unless it logs in
as mis_chatbot, and that role is neither superuser nor BYPASSRLS. The fix for
"the chatbot says no data" is never to change this URL — see
AI_CHATBOT_PLAN.md §12, Troubleshooting.
"""
import json
import os
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from services.sql_guard import MAX_ROWS

CHAT_ROLE = "mis_chatbot"
# What the model is shown of one result. Big enough for any aggregate, small
# enough that one careless query cannot spend the budget on input tokens.
MAX_RESULT_CHARS = 30_000
MAX_CELL_CHARS = 400


class ChatDBUnavailable(RuntimeError):
    """The chat database is not configured, or is configured unsafely."""


class ScopeRejected(RuntimeError):
    """The database did not accept the signed scope (key rotated, clock skew)."""


class SqlError(RuntimeError):
    """The query failed. The message is Postgres's, for the model to fix."""


_engine: Optional[Engine] = None


def chat_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine
    url = os.getenv("CHATBOT_DATABASE_URL")
    if not url:
        raise ChatDBUnavailable("CHATBOT_DATABASE_URL is not set")
    if url == os.getenv("DATABASE_URL"):
        raise ChatDBUnavailable("CHATBOT_DATABASE_URL is the app's own DATABASE_URL — refusing: "
                                "the app role bypasses row-level security")
    eng = create_engine(url, pool_pre_ping=True, pool_size=3, max_overflow=2, pool_recycle=1800)
    with eng.connect() as c:
        row = c.execute(text("SELECT current_user, r.rolsuper, r.rolbypassrls "
                             "FROM pg_roles r WHERE r.rolname = current_user")).one()
    if row[0] != CHAT_ROLE or row[1] or row[2]:
        eng.dispose()
        raise ChatDBUnavailable(f"CHATBOT_DATABASE_URL logs in as {row[0]!r} (superuser={row[1]}, "
                                f"bypassrls={row[2]}) — refusing: only a plain {CHAT_ROLE} login is "
                                "subject to the chatbot's row-level security")
    _engine = eng
    return eng


def _cell(v):
    if v is None or isinstance(v, (bool, int)):
        return v
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, float):
        return round(v, 6)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, UUID):
        return str(v)
    s = v if isinstance(v, str) else str(v)
    return s if len(s) <= MAX_CELL_CHARS else s[:MAX_CELL_CHARS] + "…"


def run_scoped(sql: str, payload: str, signature: str) -> dict:
    """Run one guarded query under one signed scope, in a read-only
    transaction that is always rolled back.

    `sql` comes from sql_guard.guard_sql (already wrapped in its LIMIT).
    """
    eng = chat_engine()
    with eng.connect() as conn:
        try:
            # set_config(…, true) is transaction-local: the scope ends with the
            # rollback below and cannot leak to the next user of this pooled
            # connection.
            ok = conn.execute(text(
                "SELECT set_config('app.chat_scope', :p, true), set_config('app.chat_scope_sig', :s, true), "
                "chat_scope() IS NOT NULL"), {"p": payload, "s": signature}).one()[2]
            if not ok:
                raise ScopeRejected("the database rejected the signed scope")
            # The raw driver cursor, with no parameters: psycopg then sends the
            # text as-is, so a '%' in ILIKE '%PANKAJ%' is not read as a
            # placeholder. The extended protocol also refuses a second statement.
            cur = conn.connection.driver_connection.cursor()
            try:
                cur.execute(sql)
                columns = [d.name for d in cur.description or []]
                rows = cur.fetchmany(MAX_ROWS + 1)
            except Exception as e:   # psycopg errors: give the model the server's words
                first = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
                if "statement timeout" in first:
                    first = "the query took longer than 15 seconds — aggregate more or filter harder"
                elif "permission denied" in first:
                    # Postgres says "for table" even when one hidden column is the cause.
                    first += (" — some columns (contact details, error text) are not readable; "
                              "select only columns listed in the schema")
                raise SqlError(first) from None
            finally:
                cur.close()
        finally:
            conn.rollback()

    truncated = len(rows) > MAX_ROWS
    rows = [[_cell(v) for v in r] for r in rows[:MAX_ROWS]]
    result = {"columns": columns, "rows": rows, "row_count": len(rows), "truncated": truncated}
    while len(json.dumps(result, default=str)) > MAX_RESULT_CHARS and len(result["rows"]) > 1:
        result["rows"] = result["rows"][: max(1, len(result["rows"]) // 2)]
        result["truncated"] = True
    result["row_count"] = len(result["rows"])
    if result["truncated"]:
        result["note"] = ("Only the first rows are shown. Aggregate in SQL (GROUP BY, SUM, COUNT) "
                          "rather than reading raw rows.")
    return result
