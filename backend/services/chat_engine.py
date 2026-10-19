"""
AutoForm MIS — the chatbot's agent loop.

Question in, events out. The loop is ours rather than an SDK tool runner so it
is the same few dozen lines whichever provider sits behind services/llm_tier.py
(AI_CHATBOT_PLAN.md §7). It never touches the database or a provider SDK
directly: both arrive as arguments, which is also what lets
tests/test_chat_engine.py drive it with a scripted model and a fake database.

Escalation (AI_CHATBOT_PLAN.md §4) is decided on evidence, not on a guess
about the question: the light model starts, and the turn restarts on the heavy
model when the SQL it writes is the risky kind (sql_guard.SqlShape), when it
asks for a forecast, or when its queries keep failing. The light model's
partial answer is withdrawn with a `reset` event first.

Events yielded, as (name, data):
  meta    {tier, model}                      a tier starts answering
  text    {delta}                            answer text as it streams
  sql     {tier, purpose, query, columns, rows, row_count, truncated, error}
  tool    {name, input, result | error}      a forecasting call
  reset   {reason}                           escalating; discard text so far
  done    {status, tier, escalated, reason}
"""
import json
from dataclasses import dataclass, field
from typing import Callable, Optional

from services import forecasting
from services.chat_db import ScopeRejected, SqlError
from services.chat_schema import SYSTEM_PROMPT
from services.llm_tier import Usage
from services.sql_guard import GuardError, guard_sql

MAX_ROUNDS = {"light": 6, "heavy": 8}
MAX_HISTORY = 6            # earlier exchanges replayed as context
MAX_HISTORY_CHARS = 3000   # per earlier answer

TOOLS = [
    {
        "name": "execute_sql",
        "description": (
            "Run ONE read-only PostgreSQL SELECT against the MIS database and get the rows back "
            "(at most 200). Rows are already limited to what the user may see. Aggregate in SQL."),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "A single SELECT (CTEs allowed). No SELECT *."},
                "purpose": {"type": "string",
                            "description": "Shown to the user beside the result, e.g. "
                                           "'Monthly seat-cover sales, FY26-27'. Under 80 characters."},
            },
            "required": ["query", "purpose"],
            "additionalProperties": False,
        },
    },
    {
        "name": "linear_extrapolate",
        "description": (
            "Project a period total from the actuals so far: average run rate, a trend line when there "
            "are 3+ points, and — given a target — the gap and the run rate still needed. Use for "
            "'will we hit target', 'at this pace'. Pass null for a period with no published figure, "
            "never 0."),
        "parameters": {
            "type": "object",
            "properties": {
                "points": {"type": "array", "items": {"type": ["number", "null"]},
                           "description": "Actuals per period, oldest first."},
                "periods_remaining": {"type": "integer", "description": "Periods left in the target window."},
                "target": {"type": ["number", "null"], "description": "Full-period target, if any."},
            },
            "required": ["points", "periods_remaining"],
            "additionalProperties": False,
        },
    },
    {
        "name": "growth_rate",
        "description": (
            "Period-on-period growth of a series: average % change, compound rate and the latest step "
            "(acceleration / deceleration). Pass null for a missing period, never 0."),
        "parameters": {
            "type": "object",
            "properties": {"points": {"type": "array", "items": {"type": ["number", "null"]}}},
            "required": ["points"],
            "additionalProperties": False,
        },
    },
]
_FORECASTS = {"linear_extrapolate": forecasting.linear_extrapolate, "growth_rate": forecasting.growth_rate}


@dataclass
class Exchange:
    """One earlier question and answer, replayed so follow-ups make sense."""
    question: str
    answer: str
    queries: list = field(default_factory=list)


@dataclass
class Outcome:
    """Everything the router logs to chat_usage — filled in as the loop runs,
    so it is complete even when the client disconnects halfway."""
    tier: str = "light"
    escalated: bool = False
    escalation_reason: Optional[str] = None
    status: str = "error"
    usage: Usage = field(default_factory=Usage)
    sql_log: list = field(default_factory=list)
    answer: str = ""
    error: Optional[str] = None


class _Escalate(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _history_messages(tier, history: list) -> list:
    msgs = []
    for ex in history[-MAX_HISTORY:]:
        answer = ex.answer[:MAX_HISTORY_CHARS]
        if ex.queries:
            # The SQL behind the earlier answer, so "now split that by month"
            # can start from it instead of from scratch.
            answer += "\n\n[SQL behind this answer]\n" + "\n---\n".join(q[:1500] for q in ex.queries[:3])
        msgs += [tier.user_message(ex.question[:1000]), tier.assistant_text(answer or "(no answer)")]
    return msgs


def run_chat(question: str, history: list, preface: str, tiers: dict,
             run_sql: Callable[[str], dict], outcome: Outcome,
             deep: bool = False, may_escalate: bool = True):
    """Answer one question. A generator of (event, data); see the module doc.

    run_sql(guarded_sql) → result dict; raises SqlError / ScopeRejected.
    may_escalate is False when the budget is low: the light tier then answers
    everything, and the heavy tier is never started.
    """
    tier_name = "heavy" if (deep and may_escalate) else "light"
    while True:
        try:
            yield from _attempt(tier_name, question, history, preface, tiers, run_sql, outcome,
                                may_escalate and tier_name == "light")
            return
        except _Escalate as e:
            outcome.escalated = True
            outcome.escalation_reason = e.reason
            yield "reset", {"reason": e.reason}
            tier_name = "heavy"


def _attempt(tier_name, question, history, preface, tiers, run_sql, outcome, can_escalate):
    tier = tiers[tier_name]
    outcome.tier = tier_name
    outcome.answer = ""
    yield "meta", {"tier": tier_name, "model": tier.model}

    messages = _history_messages(tier, history)
    messages.append(tier.user_message(f"{preface}\n\nQuestion: {question}"))
    failures = 0
    json_retries = 0
    rounds = 0

    while rounds < MAX_ROUNDS[tier_name]:
        rounds += 1
        if outcome.answer:
            outcome.answer += "\n\n"
            yield "text", {"delta": "\n\n"}
        try:
            gen = tier.run(SYSTEM_PROMPT, messages, TOOLS)
            while True:
                try:
                    delta = next(gen)
                except StopIteration as stop:
                    result = stop.value
                    break
                outcome.answer += delta
                yield "text", {"delta": delta}
        except ValueError:
            # A tool input the SDK could not parse as JSON at all (eager input
            # streaming). There is no tool_use id to answer, so re-ask, briefly.
            json_retries += 1
            if json_retries > 2:
                raise
            continue
        outcome.usage.add(result.usage)

        if result.stop_reason == "refusal":
            outcome.status = "refused"
            msg = "I can't help with that one."
            outcome.answer += msg
            yield "text", {"delta": msg}
            yield "done", _done(outcome)
            return
        if not result.tool_calls:
            outcome.status = "ok"
            if result.stop_reason == "max_tokens":
                note = "\n\n(The answer was cut off — ask a narrower question.)"
                outcome.answer += note
                yield "text", {"delta": note}
            yield "done", _done(outcome)
            return
        if result.stop_reason == "max_tokens":
            # A truncated tool input parses as a valid partial object: never run it.
            raise RuntimeError("The model's query was cut off mid-way.")

        messages.append(result.assistant_message)
        results = []
        for call in result.tool_calls:
            if call.name == "execute_sql":
                content, is_error = yield from _execute_sql(call, tier_name, run_sql, outcome, can_escalate)
                failures += is_error
            elif call.name in _FORECASTS:
                if can_escalate:
                    # Forecasts get quoted in meetings: always the stronger model.
                    raise _Escalate("forecast")
                content, is_error = yield from _forecast(call)
            else:
                content, is_error = f"Unknown tool {call.name!r}.", True
            results.append((call.id, content, is_error))

        if can_escalate and failures >= 2:
            raise _Escalate("its queries kept failing")
        messages.append(tier.tool_results_message(results))

    outcome.status = "iteration_limit"
    msg = "I couldn't finish working this out — try asking it in smaller steps."
    outcome.answer += msg
    yield "text", {"delta": msg}
    yield "done", _done(outcome)


def _execute_sql(call, tier_name, run_sql, outcome, can_escalate):
    args = call.input if isinstance(call.input, dict) else {}
    query, purpose = args.get("query"), args.get("purpose") or ""
    if not isinstance(query, str) or not query.strip():
        return "execute_sql needs a `query` string.", True
    purpose = str(purpose)[:120]
    entry = {"tier": tier_name, "purpose": purpose, "query": query, "rows": None, "error": None}

    try:
        wrapped, shape = guard_sql(query)
    except GuardError as e:
        entry["error"] = f"refused: {e}"
        outcome.sql_log.append(entry)
        yield "sql", _sql_event(entry, None)
        return f"Query refused: {e}", True

    reason = shape.escalation_reason()
    if can_escalate and reason:
        entry["error"] = f"escalated: {reason}"
        outcome.sql_log.append(entry)
        raise _Escalate(f"the query {reason}")

    try:
        res = run_sql(wrapped)
    except SqlError as e:
        entry["error"] = str(e)
        outcome.sql_log.append(entry)
        yield "sql", _sql_event(entry, None)
        return f"The query failed: {e}", True
    except ScopeRejected:
        raise   # the router's problem, not the model's

    entry["rows"] = res["row_count"]
    outcome.sql_log.append(entry)
    yield "sql", _sql_event(entry, res)
    return json.dumps(res, default=str), False


def _sql_event(entry: dict, res: Optional[dict]) -> dict:
    return {
        "tier": entry["tier"], "purpose": entry["purpose"], "query": entry["query"],
        "error": entry["error"],
        "columns": res["columns"] if res else [],
        "rows": res["rows"][:50] if res else [],
        "row_count": res["row_count"] if res else 0,
        "truncated": bool(res and (res["truncated"] or res["row_count"] > 50)),
    }


def _forecast(call):
    args = call.input if isinstance(call.input, dict) else {}
    try:
        out = _FORECASTS[call.name](**args)
    except (TypeError, ValueError) as e:
        yield "tool", {"name": call.name, "input": args, "error": str(e)}
        return f"{call.name} failed: {e}", True
    yield "tool", {"name": call.name, "input": args, "result": out}
    return json.dumps(out), False


def _done(outcome: Outcome) -> dict:
    return {"status": outcome.status, "tier": outcome.tier, "escalated": outcome.escalated,
            "reason": outcome.escalation_reason}
