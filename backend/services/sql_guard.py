"""
AutoForm MIS — checks on the SQL the chatbot's model writes, before it runs.

This is defence in depth, not the boundary. The boundary is the database: the
mis_chatbot role is read-only, can only SELECT an allowlist of tables, and
row-level security with a signed scope decides which rows come back
(migrate_phase25_chatbot_scope.sql). If this file were deleted, a user still
could not read a row they are not entitled to.

What it adds:
  • a clear error the model can act on ("list the columns") instead of a raw
    Postgres permission error it would misread as "no access";
  • a function allowlist, so set_config(), query_to_xml() and friends never
    reach the database at all;
  • the SQL's shape — tables, joins, window functions — for the decision to
    escalate to the stronger model (AI_CHATBOT_PLAN.md §4).

Parse, don't grep: a substring check rejected sync_logs.rows_updated as an
UPDATE in the first version of this plan.
"""
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

MAX_ROWS = 200

# Postgres functions that sqlglot does not model as a typed node arrive as
# exp.Anonymous; anything not listed here is refused. Typed nodes (SUM, COUNT,
# ROUND, COALESCE, DATE_TRUNC, EXTRACT, window functions, …) are standard SQL
# and pass. The dangerous ones — set_config, current_setting, query_to_xml,
# pg_sleep, pg_read_file, lo_*, dblink — are all Anonymous, so they fail here.
ALLOWED_FUNCTIONS = {
    # dates
    "age", "make_date", "make_interval", "make_timestamp", "date_part", "date_bin", "to_date",
    "to_timestamp", "justify_days", "justify_interval", "isfinite", "date_add", "date_subtract",
    # strings
    "initcap", "btrim", "ltrim", "rtrim", "lpad", "rpad", "left", "right", "length", "char_length",
    "strpos", "position", "substr", "substring", "replace", "translate", "concat", "concat_ws",
    "format", "regexp_replace", "regexp_match", "regexp_like", "split_part", "reverse", "repeat",
    "string_to_array", "array_to_string", "starts_with",
    # numbers
    "abs", "ceil", "ceiling", "floor", "trunc", "mod", "power", "sqrt", "sign", "ln", "log", "log10",
    "exp", "width_bucket", "div", "scale", "to_number",
    # aggregates and window helpers sqlglot leaves anonymous
    "bool_and", "bool_or", "every", "mode", "percentile_disc", "stddev", "stddev_pop",
    "stddev_samp", "variance", "var_pop", "var_samp", "corr", "covar_pop", "covar_samp",
    "regr_slope", "regr_intercept", "regr_r2", "ntile", "cume_dist", "percent_rank",
    "first_value", "last_value", "nth_value", "num_nulls", "num_nonnulls",
    # arrays and json (read-only)
    "array_length", "cardinality", "array_position", "array_remove", "jsonb_array_elements_text",
    "jsonb_array_elements", "json_array_elements_text", "jsonb_extract_path_text",
    "jsonb_object_keys", "jsonb_typeof", "jsonb_build_object", "json_build_object",
    "jsonb_agg", "json_agg", "to_jsonb", "generate_series",
}

_WRITES = (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Drop, exp.Create, exp.Alter,
           exp.Command, exp.Copy, exp.Into, exp.Lock, exp.Set, exp.TruncateTable)

# Tables whose combination is the three-grain trap: month (dealer funnel),
# quarter (dealer targets) and day (visit logs). Joining them double-counts
# easily, so a query that does goes to the stronger model.
_THREE_GRAIN = {"oe_dealer_monthly", "oe_dealer_targets", "oe_visit_logs"}


class GuardError(ValueError):
    """The query was refused. The message is written for the model to act on."""


@dataclass
class SqlShape:
    tables: set = field(default_factory=set)
    joins: int = 0
    ctes: int = 0
    windows: int = 0
    subqueries: int = 0
    finance_sections: set = field(default_factory=set)

    def escalation_reason(self):
        """Why this SQL is too risky for the light model, or None.

        Starting thresholds from the plan, minus "any CTE": the light model
        writes CTEs for simple questions too, and escalating every one would
        spend the budget on questions it answers fine. Every decision is logged
        in chat_usage, so these can be tuned against real traffic.
        """
        if len(self.tables) >= 3:
            return f"joins {len(self.tables)} tables"
        if self.windows:
            return "uses a window function"
        if len(self.finance_sections) > 1:
            return "mixes Finance sections"
        if "oe_dealer_monthly" in self.tables and self.tables & (_THREE_GRAIN - {"oe_dealer_monthly"}):
            return "joins dealer facts of different grains"
        return None


def guard_sql(query: str) -> tuple[str, SqlShape]:
    """Validate one model-written query. Returns (sql to execute, its shape).

    The model's text is executed as written, wrapped in an outer LIMIT —
    never re-rendered by sqlglot, which would risk subtly changing Postgres
    syntax it does not model. Wrapping also makes a second statement a syntax
    error at the server, whatever the parser thought.
    """
    q = (query or "").strip().rstrip(";").strip()
    if not q:
        raise GuardError("Empty query.")
    if len(q) > 20_000:
        raise GuardError("Query too long — simplify it.")
    try:
        statements = [s for s in sqlglot.parse(q, read="postgres") if s is not None]
    except sqlglot.errors.ParseError as e:
        raise GuardError(f"Could not parse the SQL: {str(e).splitlines()[0]}") from None
    if len(statements) != 1:
        raise GuardError("Send exactly one SELECT statement.")
    stmt = statements[0]

    if not isinstance(stmt, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        raise GuardError("Only SELECT queries are allowed.")
    if stmt.find(*_WRITES):
        raise GuardError("Only read-only SELECT queries are allowed (no writes, SELECT INTO, locks or SET).")

    for fn in stmt.find_all(exp.Anonymous):
        name = (fn.name or "").lower()
        if name not in ALLOWED_FUNCTIONS:
            raise GuardError(f"Function {name}() is not available. Use standard SQL functions.")

    # A star over a base table fails at the database whenever the table hides
    # a column, with an error the model reads as "no access". Over its own CTE
    # or subquery a star is harmless: those columns are ones it already chose.
    cte_names = {c.alias_or_name for c in stmt.find_all(exp.CTE)}
    for star in stmt.find_all(exp.Star):
        if isinstance(star.parent, (exp.Count, exp.Anonymous)):
            continue
        sel = star.find_ancestor(exp.Select)
        frm = sel.args.get("from_") if sel else None
        sources = ([frm.this] if frm else []) + [j.this for j in (sel.args.get("joins") or [])]
        if any(isinstance(s, exp.Table) and s.name not in cte_names for s in sources):
            raise GuardError("Do not use SELECT * on a table. List the columns you need.")

    shape = _shape(stmt)
    wrapped = f"SELECT * FROM (\n{q}\n) AS chat_result LIMIT {MAX_ROWS + 1}"
    return wrapped, shape


def _shape(stmt: exp.Expression) -> SqlShape:
    cte_names = {c.alias_or_name for c in stmt.find_all(exp.CTE)}
    shape = SqlShape()
    shape.tables = {t.name.lower() for t in stmt.find_all(exp.Table)
                    if t.name and t.name not in cte_names}
    shape.joins = sum(1 for _ in stmt.find_all(exp.Join))
    shape.ctes = len(cte_names)
    shape.windows = sum(1 for _ in stmt.find_all(exp.Window))
    shape.subqueries = sum(1 for _ in stmt.find_all(exp.Subquery))
    if "finance_lines" in shape.tables:
        for node in stmt.find_all(exp.EQ, exp.In):
            col = node.this if isinstance(node.this, exp.Column) else None
            if col is None or col.name.lower() != "section_key":
                continue
            values = [node.expression] if isinstance(node, exp.EQ) else node.expressions
            shape.finance_sections |= {v.name for v in values if isinstance(v, exp.Literal)}
    return shape
