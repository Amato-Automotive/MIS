"""The agent loop, driven by a scripted model and a fake database — no API
calls, no Postgres. What matters here: escalation happens on the right
evidence and withdraws the light model's partial answer; budget-low mode
never starts the heavy tier; failures are reported to the model, not run."""
from services.chat_engine import Exchange, Outcome, run_chat
from services.chat_db import SqlError
from services.llm_tier import AnthropicTier, ToolCall, TurnResult, Usage


class ScriptedTier:
    """Plays back a list of turns. A turn is (text, [ToolCall], stop_reason)."""
    user_message = staticmethod(AnthropicTier.user_message)
    assistant_text = staticmethod(AnthropicTier.assistant_text)
    tool_results_message = staticmethod(AnthropicTier.tool_results_message)

    def __init__(self, name, turns):
        self.name, self.model, self.turns, self.seen = name, f"model-{name}", list(turns), []

    def run(self, system, messages, tools):
        self.seen.append([m for m in messages])
        text, calls, stop = self.turns.pop(0)
        if text:
            yield text
        return TurnResult(text=text, tool_calls=calls, stop_reason=stop,
                          usage=Usage(100, 0, 0, 10, 0.001), model=self.model,
                          assistant_message={"role": "assistant", "content": text or "(tools)"})


def sql(q, purpose="p", id_="t1"):
    return ToolCall(id_, "execute_sql", {"query": q, "purpose": purpose})


def run(tiers, db=None, **kw):
    db = db or (lambda s: {"columns": ["n"], "rows": [[5]], "row_count": 1, "truncated": False})
    out = Outcome()
    events = list(run_chat("How many?", kw.pop("history", []), "[ctx]", tiers, db, out, **kw))
    return events, out


def names(events):
    return [e for e, _ in events]


def test_simple_question_stays_light():
    light = ScriptedTier("light", [("", [sql("SELECT count(*) FROM leads")], "tool_use"),
                                   ("There are 5 leads.", [], "end_turn")])
    events, out = run({"light": light, "heavy": ScriptedTier("heavy", [])})
    assert names(events) == ["meta", "sql", "text", "done"]
    assert out.status == "ok" and out.tier == "light" and not out.escalated
    assert out.answer.endswith("There are 5 leads.")
    assert out.usage.input_tokens == 200 and len(out.sql_log) == 1
    # The tool result went back to the model in one user message.
    assert light.seen[1][-1]["content"][0]["tool_use_id"] == "t1"


def test_risky_sql_escalates_before_running_and_withdraws_the_draft():
    ran = []
    light = ScriptedTier("light", [("Let me look.", [sql(
        "SELECT salesperson, rank() OVER (ORDER BY count(*)) FROM oe_visit_logs GROUP BY 1")], "tool_use")])
    heavy = ScriptedTier("heavy", [("", [sql("SELECT 1 AS n FROM leads")], "tool_use"), ("Done.", [], "end_turn")])
    events, out = run({"light": light, "heavy": heavy},
                      db=lambda s: ran.append(s) or {"columns": [], "rows": [], "row_count": 0, "truncated": False})
    assert names(events)[:3] == ["meta", "text", "reset"]
    assert events[2][1]["reason"].endswith("uses a window function")
    assert out.escalated and out.tier == "heavy" and out.status == "ok"
    assert len(ran) == 1, "the light model's risky query must not run"
    assert out.answer == "Done.", "the light model's draft is withdrawn"


def test_forecast_always_goes_heavy():
    light = ScriptedTier("light", [("", [ToolCall("f", "linear_extrapolate",
                                                  {"points": [1, 2], "periods_remaining": 1})], "tool_use")])
    heavy = ScriptedTier("heavy", [("", [ToolCall("f", "linear_extrapolate",
                                                  {"points": [1, 2], "periods_remaining": 1})], "tool_use"),
                                   ("On pace for 4.5.", [], "end_turn")])
    events, out = run({"light": light, "heavy": heavy})
    assert out.escalation_reason == "forecast" and out.tier == "heavy"
    tool = next(d for e, d in events if e == "tool")
    assert tool["result"]["projected_total"] == 4.5


def test_low_budget_never_starts_the_heavy_tier():
    light = ScriptedTier("light", [("", [ToolCall("f", "growth_rate", {"points": [1, 2]})], "tool_use"),
                                   ("Up 100%.", [], "end_turn")])
    heavy = ScriptedTier("heavy", [])
    _, out = run({"light": light, "heavy": heavy}, may_escalate=False, deep=True)
    assert out.tier == "light" and not out.escalated and out.status == "ok"


def test_two_failed_queries_escalate():
    def db(s):
        raise SqlError('column "x" does not exist')
    light = ScriptedTier("light", [("", [sql("SELECT x FROM leads", id_="a")], "tool_use"),
                                   ("", [sql("SELECT y FROM leads", id_="b")], "tool_use")])
    heavy = ScriptedTier("heavy", [("I could not query that.", [], "end_turn")])
    events, out = run({"light": light, "heavy": heavy}, db=db)
    assert out.escalation_reason == "its queries kept failing"
    # The first failure went back to the model as an error result, not a crash.
    first_result = light.seen[1][-1]["content"][0]
    assert first_result["is_error"] and "does not exist" in first_result["content"]


def test_refused_sql_is_reported_to_the_model_not_run():
    ran = []
    light = ScriptedTier("light", [("", [sql("SELECT set_config('app.chat_scope','{}',true)")], "tool_use"),
                                   ("Sorry.", [], "end_turn")])
    _, out = run({"light": light, "heavy": ScriptedTier("heavy", [])}, db=lambda s: ran.append(s))
    assert not ran and out.sql_log[0]["error"].startswith("refused")


def test_iteration_cap():
    light = ScriptedTier("light", [("", [sql("SELECT 1 AS n FROM leads", id_=str(i))], "tool_use")
                                   for i in range(6)])
    _, out = run({"light": light, "heavy": ScriptedTier("heavy", [])})
    assert out.status == "iteration_limit"


def test_history_carries_the_earlier_sql():
    light = ScriptedTier("light", [("Fine.", [], "end_turn")])
    run({"light": light, "heavy": ScriptedTier("heavy", [])},
        history=[Exchange("Leads in May?", "There were 40.", ["SELECT count(*) FROM leads WHERE …"])])
    first_call = light.seen[0]
    assert first_call[0] == {"role": "user", "content": "Leads in May?"}
    assert "SELECT count(*) FROM leads" in first_call[1]["content"]
    assert first_call[-1]["content"].startswith("[ctx]")


def test_refusal_ends_cleanly():
    light = ScriptedTier("light", [("", [], "refusal")])
    events, out = run({"light": light, "heavy": ScriptedTier("heavy", [])})
    assert out.status == "refused" and names(events)[-1] == "done"
