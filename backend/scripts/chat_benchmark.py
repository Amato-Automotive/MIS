"""
The chatbot's accuracy benchmark — real model calls, real data, one user's scope.

    cd ~/MIS/backend
    venv/bin/python -m scripts.chat_benchmark --as you@autoformindia.com           # estimate only
    venv/bin/python -m scripts.chat_benchmark --as you@autoformindia.com --yes     # run it
    venv/bin/python -m scripts.chat_benchmark --as rep@autoformindia.com --yes     # the rep cases
        --only oe_mobis,oe_forecast     run some fixtures
        --deep                          start every question on the heavy tier

THIS SPENDS API CREDIT. Each run is logged to chat_usage and counts against
CHAT_BUDGET_USD like any other question. On the light tier a full run costs a
few cents; escalated fixtures cost more (see the per-question cost column).

Fixtures are tests/chat_benchmark.json. How each is scored:
  reference_sql        run under the same user's scope; every number in its
                       result must appear (±0.5%) among the numbers the model's
                       own queries returned. Compares data, not prose, so ₹ L/Cr
                       formatting in the answer does not matter.
  must_mention         regex that must match the answer (case-insensitive)
  must_not_mention     regex that must not
  sql_must_match / sql_must_not_match   regex over the model's SQL
  capability_sql +     when that count is 0 the source cannot answer, and the
  when_incapable_must_mention   answer must say so
  expect_escalated     the light model must have handed over
  audience             any | management (unscoped OE) | rep (scoped OE) |
                       without_module (user must NOT hold `module`)
Fixtures whose module or audience does not fit the user are skipped.

It is also the acceptance test for changing model or provider
(AI_CHATBOT_PLAN.md §4b): the new tier is done when it scores at least as well.
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from database import SessionLocal
from models import User
from routers.chat import _context, _log
from services.chat_db import run_scoped
from services.chat_engine import Outcome, run_chat
from services.chat_scope import build_chat_scope, scope_key, sign
from services.llm_tier import tiers_from_env
from services.sql_guard import guard_sql

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "chat_benchmark.json"


def numbers(rows) -> list:
    out = []
    for r in rows:
        for v in r:
            if isinstance(v, bool) or v is None:
                continue
            if isinstance(v, (int, float)):
                out.append(float(v))
    return out


def close(a: float, b: float) -> bool:
    """Equal within 0.5% — or equal as a ratio vs a percentage (0.201 / 20.1)."""
    return any(abs(a - x) <= max(0.01, abs(a) * 0.005) for x in (b, b * 100, b / 100))


def applies(fx: dict, scope) -> bool:
    aud = fx.get("audience", "any")
    holds = fx["module"] in scope.modules
    if aud == "without_module":
        return not holds
    if not holds:
        return False
    if aud == "management":
        return not scope.oe_scoped
    if aud == "rep":
        return scope.oe_scoped
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--as", dest="email", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--deep", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))
    if args.only:
        wanted = set(args.only.split(","))
        fixtures = [f for f in fixtures if f["id"] in wanted]

    with SessionLocal() as db:
        user = db.query(User).filter(User.email == args.email).first()
        if not user:
            print(f"No user {args.email}")
            return 2
        scope = build_chat_scope(db, user)
        key = scope_key(db)
        preface = _context(user, scope)
        user_id = user.id

    todo = [f for f in fixtures if applies(f, scope)]
    print(f"{len(todo)} of {len(fixtures)} fixtures apply to {args.email} "
          f"(modules: {', '.join(scope.modules) or 'none'}; OE {'rep' if scope.oe_scoped else 'unscoped'}).")
    if not args.yes:
        print("Estimated cost: roughly $0.002–0.005 per light-tier question, $0.02–0.06 per escalated one. "
              "Re-run with --yes to spend it.")
        return 0

    def run_sql(sql: str) -> dict:
        p = scope.payload()
        return run_scoped(sql, p, sign(key, p))

    tiers = tiers_from_env()
    results, passed, spent = [], 0, 0.0
    for fx in todo:
        out = Outcome()
        seen = []

        def recording(sql, _seen=seen):
            res = run_sql(sql)
            _seen.append(res)
            return res

        t0 = time.monotonic()
        error = None
        try:
            for _ in run_chat(fx["question"], [], preface, tiers, recording, out, deep=args.deep):
                pass
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
        _log(user_id, f"[benchmark:{fx['id']}] {fx['question']}", out, int((time.monotonic() - t0) * 1000))
        spent += out.usage.cost_usd

        fails = []
        if error:
            fails.append(error)
        answer = out.answer
        model_sql = "\n".join(e["query"] for e in out.sql_log)
        model_nums = [n for res in seen for n in numbers(res["rows"])]
        if fx.get("reference_sql"):
            try:
                ref = run_sql(guard_sql(fx["reference_sql"])[0])
                missing = [n for n in numbers(ref["rows"]) if not any(close(n, m) for m in model_nums)]
                if missing:
                    fails.append(f"numbers not found in the model's results: {missing[:5]}")
            except Exception as e:
                fails.append(f"reference SQL failed: {e}")
        if fx.get("must_mention") and not re.search(fx["must_mention"], answer, re.I):
            fails.append(f"answer lacks /{fx['must_mention']}/")
        if fx.get("must_not_mention") and re.search(fx["must_not_mention"], answer, re.I):
            fails.append(f"answer contains /{fx['must_not_mention']}/")
        if fx.get("sql_must_match") and not re.search(fx["sql_must_match"], model_sql, re.I):
            fails.append(f"SQL lacks /{fx['sql_must_match']}/")
        if fx.get("sql_must_not_match") and re.search(fx["sql_must_not_match"], model_sql, re.I):
            fails.append(f"SQL contains /{fx['sql_must_not_match']}/")
        if fx.get("capability_sql"):
            cap = run_sql(guard_sql(fx["capability_sql"])[0])["rows"][0][0]
            if cap == 0 and not re.search(fx["when_incapable_must_mention"], answer, re.I):
                fails.append("source cannot answer, and the answer did not say so")
        if fx.get("expect_escalated") and not out.escalated and not args.deep:
            fails.append("expected escalation to the heavy tier")

        ok = not fails
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'}  {fx['id']:<28} {out.tier:<6}{'*' if out.escalated else ' '} "
              f"${out.usage.cost_usd:.4f}  {'; '.join(fails)}")
        results.append({"id": fx["id"], "pass": ok, "fails": fails, "tier": out.tier,
                        "escalated": out.escalated, "reason": out.escalation_reason,
                        "cost_usd": out.usage.cost_usd, "answer": answer, "sql": out.sql_log})

    print(f"\n{passed}/{len(todo)} passed, ${spent:.4f} spent.  (* = escalated)")
    path = Path(f"chat_benchmark_{datetime.now():%Y%m%d_%H%M}.json")
    path.write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
    print(f"Answers and SQL written to {path.resolve()}")
    return 0 if passed == len(todo) else 1


if __name__ == "__main__":
    sys.exit(main())
