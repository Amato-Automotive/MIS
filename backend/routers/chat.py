"""
AutoForm MIS — the AI assistant (/chat).

Ask a question in plain English; the model writes SQL, the database runs it
under the asking user's row-level scope, and the answer streams back with the
queries that produced it. Design and reasoning: AI_CHATBOT_PLAN.md.

Who gets what:
  • the `chat` module opens the page and grants no data;
  • what the model can read is decided per user by services/chat_scope.py and
    enforced by Postgres (migrate_phase25_chatbot_scope.sql), never by the prompt.

Spend is capped here, before a model is called (AI_CHATBOT_PLAN.md §4c):
  CHAT_BUDGET_USD                   total for everyone            (default 4.50)
  CHAT_USER_DAILY_USD               per user per day              (default 0.50)
  CHAT_ESCALATION_FLOOR_USD         below this much left, Haiku only (default 1.00)
Every question is logged to chat_usage with its tokens, cost and SQL.
"""
import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import SessionLocal, get_db
from models import User
from routers.auth import get_current_user
from services.chat_db import ChatDBUnavailable, ScopeRejected, chat_engine, run_scoped
from services.chat_engine import Exchange, Outcome, run_chat
from services.chat_scope import ChatScope, build_chat_scope, scope_key, sign
from services.llm_tier import TierError, tiers_from_env
from services.permissions import require_module

router = APIRouter(prefix="/chat", tags=["AI Assistant"])

MODULE_KEY = "chat"
IST = timezone(timedelta(hours=5, minutes=30))
MODULE_NAMES = {"sales": "Sales (AFAC)", "leads": "Leads Analytics (AFAC)", "finance": "Finance",
                "oe_network": "OE Network", "export": "Export"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def _limits() -> dict:
    return {
        "budget": _env_float("CHAT_BUDGET_USD", 4.50),
        "user_daily": _env_float("CHAT_USER_DAILY_USD", 0.50),
        "escalation_floor": _env_float("CHAT_ESCALATION_FLOOR_USD", 1.00),
        "per_minute": int(_env_float("CHAT_USER_PER_MINUTE", 6)),
    }


def _spend(db: Session, user_id) -> dict:
    row = db.execute(text("""
        SELECT COALESCE(SUM(cost_usd), 0),
               COALESCE(SUM(cost_usd) FILTER (WHERE user_id = :u
                                              AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                                                                AT TIME ZONE 'Asia/Kolkata'), 0),
               COUNT(*) FILTER (WHERE user_id = :u AND created_at >= now() - interval '1 minute')
        FROM chat_usage"""), {"u": str(user_id)}).one()
    return {"total": float(row[0]), "user_today": float(row[1]), "last_minute": int(row[2])}


_tiers = None


def _get_tiers():
    global _tiers
    if _tiers is None:
        _tiers = tiers_from_env()
    return _tiers


def _availability() -> Optional[str]:
    """Why the assistant cannot run right now, or None."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        return "ANTHROPIC_API_KEY is not set on the server"
    try:
        chat_engine()
    except ChatDBUnavailable as e:
        return str(e)
    except Exception as e:   # unreachable database etc.
        return f"the chat database is unreachable ({type(e).__name__})"
    return None


def _fy(d: date) -> str:
    start = d.year if d.month >= 4 else d.year - 1
    q = (d.month - 4) % 12 // 3 + 1
    return f"FY{start % 100:02d}-{(start + 1) % 100:02d}, Q{q}"


def _context(user: User, scope: ChatScope) -> str:
    """Per-request facts for the model. Kept OUT of the system prompt — that is
    the cached prefix, and anything per-user or dated there would invalidate
    the cache on every request."""
    today = datetime.now(IST).date()
    held = [MODULE_NAMES[m] for m in scope.modules] or ["none"]
    lines = [
        "[Context for this question — from the app, not from the user]",
        f"Today: {today.isoformat()} ({_fy(today)}).",
        f"Asked by: {user.name}.",
        f"Modules this user holds: {', '.join(held)}. Other modules' tables return no rows for them.",
    ]
    if "finance" in scope.modules:
        if scope.finance_labels:
            lines.append(f"Finance companies they can see ({len(scope.finance_labels)}): "
                         + ", ".join(scope.finance_labels) + ". Other companies return no rows.")
        else:
            lines.append("Finance: no companies granted yet, so Finance tables return no rows.")
    if "oe_network" in scope.modules and scope.oe_scoped:
        lines.append(f"OE Network: this user is the field rep {scope.oe_salesperson}. OE rows are limited to "
                     "their own visits, plans and targets and the dealers assigned to them. Say 'your' "
                     "figures, never the company's. OEM brand targets (oe_oem_targets, "
                     "oe_oem_target_annual) are management-only: if they ask about brand or OEM-level "
                     "targets, do not query — tell them that is not available to their account and offer "
                     "their own salesperson targets instead. Never call it 'no data'.")
    return "\n".join(lines)


class HistoryItem(BaseModel):
    question: str = Field(max_length=1000)
    answer: str = Field(max_length=20000)
    queries: list[str] = Field(default_factory=list, max_length=10)


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=20)
    deep: bool = False


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get("/status")
def status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    reason = _availability()
    lim = _limits()
    out = {"available": reason is None, "reason": reason}
    try:
        sp = _spend(db, current_user.id)
    except Exception:
        return out | {"available": False, "reason": "chat_usage table missing — apply migrate_phase25"}
    remaining = lim["budget"] - sp["total"]
    out |= {
        "budget_left": remaining > 0.01,
        "deep_available": remaining > lim["escalation_floor"],
        "user_today_usd": round(sp["user_today"], 4),
        "user_daily_usd": lim["user_daily"],
    }
    if current_user.role == "superadmin":
        t = _get_tiers() if reason is None else None
        out |= {"budget_usd": lim["budget"], "spent_usd": round(sp["total"], 4),
                "models": {k: v.model for k, v in t.items()} if t else None}
    return out


@router.post("/ask")
def ask(body: AskBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    reason = _availability()
    if reason:
        raise HTTPException(503, f"The assistant is not available: {reason}.")

    lim = _limits()
    sp = _spend(db, current_user.id)
    remaining = lim["budget"] - sp["total"]
    if remaining <= 0.01:
        raise HTTPException(429, "The assistant's API budget is used up. Ask an administrator to raise it.")
    if sp["user_today"] >= lim["user_daily"]:
        raise HTTPException(429, "You've reached today's assistant limit. It resets at midnight.")
    if sp["last_minute"] >= lim["per_minute"]:
        raise HTTPException(429, "Too many questions in a minute — wait a moment.")
    may_escalate = os.getenv("CHAT_ENABLE_ESCALATION", "1") == "1" and remaining > lim["escalation_floor"]

    # Everything that needs the request's session happens here, before the
    # response starts streaming; the stream opens its own session to log.
    scope = build_chat_scope(db, current_user)
    key = scope_key(db)
    preface = _context(current_user, scope)
    if body.deep and not may_escalate:
        preface += "\n(Deep dive was requested but the budget is low, so the standard model is answering.)"
    history = [Exchange(h.question, h.answer, h.queries) for h in body.history]
    user_id = current_user.id
    tiers = _get_tiers()

    def run_sql(sql: str) -> dict:
        nonlocal key
        payload = scope.payload()
        try:
            return run_scoped(sql, payload, sign(key, payload))
        except ScopeRejected:
            # The key may have been rotated since we cached it. Once.
            with SessionLocal() as s:
                key = scope_key(s, refresh=True)
            payload = scope.payload()
            return run_scoped(sql, payload, sign(key, payload))

    def stream():
        outcome = Outcome()
        started = time.monotonic()
        try:
            for event, data in run_chat(body.question, history, preface, tiers, run_sql, outcome,
                                        deep=body.deep, may_escalate=may_escalate):
                if event == "done":
                    data = data | {"cost_usd": round(outcome.usage.cost_usd, 5)}
                yield _sse(event, data)
        except TierError as e:
            outcome.status, outcome.error = "error", str(e)
            yield _sse("error", {"message": str(e)})
        except ScopeRejected:
            outcome.status, outcome.error = "error", "scope rejected"
            yield _sse("error", {"message": "The database would not accept your access scope. "
                                            "An administrator should check migrate_phase25 was applied."})
        except Exception as e:
            outcome.status, outcome.error = "error", f"{type(e).__name__}: {e}"
            yield _sse("error", {"message": "Something went wrong answering that. Try rephrasing it."})
        finally:
            _log(user_id, body.question, outcome, int((time.monotonic() - started) * 1000))

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",   # nginx would otherwise hold the stream until it ends
    })


def _log(user_id, question: str, o: Outcome, latency_ms: int) -> None:
    """Runs in the stream's finally — also on a client disconnect — so every
    token spent is counted against the budget."""
    try:
        with SessionLocal() as s:
            s.execute(text("""
                INSERT INTO chat_usage (user_id, question, tier, escalated, escalation_reason, status,
                                        input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
                                        cost_usd, sql_log, error, latency_ms)
                VALUES (:u, :q, :tier, :esc, :reason, :status, :inp, :cw, :cr, :out, :cost,
                        CAST(:sql AS jsonb), :err, :lat)"""), {
                "u": str(user_id), "q": question, "tier": o.tier, "esc": o.escalated,
                "reason": o.escalation_reason, "status": o.status if o.status != "error" or o.error else "aborted",
                "inp": o.usage.input_tokens, "cw": o.usage.cache_write_tokens,
                "cr": o.usage.cache_read_tokens, "out": o.usage.output_tokens,
                "cost": round(o.usage.cost_usd, 6), "sql": json.dumps(o.sql_log, default=str),
                "err": o.error, "lat": latency_ms,
            })
            s.commit()
    except Exception:
        # Never let logging break the answer; the spend is still visible in the
        # Anthropic console, which is the backstop cap anyway.
        pass


@router.get("/usage")
def usage(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Spend and recent questions, for the superadmin's panel on the page."""
    if current_user.role != "superadmin":
        raise HTTPException(403, "Only a superadmin can see assistant usage")
    lim = _limits()
    totals = db.execute(text("""
        SELECT COALESCE(SUM(cost_usd), 0), COUNT(*),
               COUNT(*) FILTER (WHERE escalated), COUNT(*) FILTER (WHERE status <> 'ok')
        FROM chat_usage""")).one()
    by_user = db.execute(text("""
        SELECT COALESCE(u.name, '(deleted user)'), COUNT(*), SUM(c.cost_usd), MAX(c.created_at)
        FROM chat_usage c LEFT JOIN users u ON u.id = c.user_id
        GROUP BY 1 ORDER BY 3 DESC""")).fetchall()
    recent = db.execute(text("""
        SELECT c.created_at, COALESCE(u.name, '(deleted user)'), c.question, c.tier, c.escalated,
               c.escalation_reason, c.status, c.cost_usd, c.sql_log, c.error
        FROM chat_usage c LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC LIMIT 50""")).fetchall()
    return {
        "budget_usd": lim["budget"], "spent_usd": round(float(totals[0]), 4), "questions": totals[1],
        "escalated": totals[2], "not_ok": totals[3],
        "by_user": [{"name": r[0], "questions": r[1], "cost_usd": round(float(r[2]), 4),
                     "last": r[3].isoformat() if r[3] else None} for r in by_user],
        "recent": [{"at": r[0].isoformat(), "user": r[1], "question": r[2], "tier": r[3], "escalated": r[4],
                    "reason": r[5], "status": r[6], "cost_usd": round(float(r[7]), 5),
                    "sql": r[8] or [], "error": r[9]} for r in recent],
    }
