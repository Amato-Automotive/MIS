"""
AutoForm MIS — the one place the chatbot talks to a model provider.

Nothing outside this file imports `anthropic` (AI_CHATBOT_PLAN.md §4b). The
agent loop in services/chat_engine.py deals only in TurnResult / ToolCall and
the message dicts this adapter builds, so moving to another provider is a new
class here, not a rewrite of the loop, the guard or the router.

Two tiers, both Anthropic in phase 1:
  light  claude-haiku-5-5   — answers most questions; $0.10 / $0.50 per MTok
  heavy  claude-sonnet-5-5  — the escalation tier;   $2.00 / $10.00 per MTok
Both are env-configurable (CHAT_LIGHT_MODEL / CHAT_HEAVY_MODEL); a model
missing from PRICES is costed at the conservative fallback rate.
"""
import os
from dataclasses import dataclass, field
from typing import Any, Generator, Optional

import anthropic

# $ per million tokens: input, output, cache read, cache write (5-minute TTL =
# 1.25 × input). Haiku 5.5's prices hold for prompts up to 100K tokens; ours
# are ~10K. Checked 2026-10-19 — re-check before trusting them for a budget.
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
}
# Anything else — a renamed model, or a server-side refusal fallback that ran
# on another model — is costed as Opus 5. Over-counting spends the cap a
# little early; under-counting would overspend the real credit.
FALLBACK_PRICE = (5.00, 25.00, 0.50, 6.25)

_FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass
class Usage:
    input_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.cache_write_tokens += other.cache_write_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.output_tokens += other.output_tokens
        self.cost_usd += other.cost_usd


def cost(model: str, inp: int, out: int, cache_read: int, cache_write: int) -> float:
    p_in, p_out, p_read, p_write = PRICES.get(model, FALLBACK_PRICE)
    return (inp * p_in + out * p_out + cache_read * p_read + cache_write * p_write) / 1_000_000


@dataclass
class ToolCall:
    id: str
    name: str
    input: Any            # whatever the model sent; the loop validates it


@dataclass
class TurnResult:
    text: str
    tool_calls: list
    stop_reason: str      # end_turn | tool_use | max_tokens | refusal | …
    usage: Usage
    model: str
    assistant_message: dict = field(repr=False)   # append to messages as-is


class TierError(RuntimeError):
    """The provider call failed in a way the user should hear about."""


class AnthropicTier:
    def __init__(self, name: str, model: str, effort: str, max_tokens: int,
                 refusal_fallback: bool = False, client: Optional[anthropic.Anthropic] = None):
        self.name = name
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.refusal_fallback = refusal_fallback
        # Retries cover 429 / 5xx / connection drops. The timeout is per
        # attempt; a whole question is bounded by the loop's iteration cap.
        self._client = client or anthropic.Anthropic(max_retries=2, timeout=90.0)

    # ── message builders: the loop never constructs provider shapes itself ──
    @staticmethod
    def user_message(text: str) -> dict:
        return {"role": "user", "content": text}

    @staticmethod
    def assistant_text(text: str) -> dict:
        return {"role": "assistant", "content": text}

    @staticmethod
    def tool_results_message(results: list) -> dict:
        """results: [(tool_call_id, content_str, is_error)]. All results of one
        turn go back in ONE user message — splitting them teaches the model to
        stop making parallel calls."""
        return {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": content, **({"is_error": True} if err else {})}
            for tid, content, err in results
        ]}

    @staticmethod
    def _tools(tools: list) -> list:
        # eager_input_streaming: inputs stream as generated rather than in one
        # burst. It also means the server no longer validates them, so the loop
        # validates every input before running anything.
        return [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"],
                 "eager_input_streaming": True} for t in tools]

    def run(self, system: str, messages: list, tools: list) -> Generator[str, None, TurnResult]:
        """One model call. Yields the answer's text as it streams; returns the
        TurnResult (use `result = yield from tier.run(...)`)."""
        kwargs = dict(
            model=self.model,
            max_tokens=self.max_tokens,
            # The breakpoint on the system block caches tools + system (tools
            # render first). The top-level one also caches the growing message
            # list between tool-call rounds within a question.
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            cache_control={"type": "ephemeral"},
            tools=self._tools(tools),
            messages=messages,
            output_config={"effort": self.effort},
        )
        try:
            try:
                return (yield from self._stream(kwargs, with_fallback=self.refusal_fallback))
            except anthropic.BadRequestError as e:
                # The refusal fallback is a beta. If this account or model
                # rejects it (before any text has streamed), run without it
                # rather than failing every escalated question.
                if not (self.refusal_fallback and "fallback" in str(e).lower()):
                    raise
                self.refusal_fallback = False
                return (yield from self._stream(kwargs, with_fallback=False))
        except anthropic.BadRequestError as e:
            raise TierError(f"The model rejected the request: {e.message}") from e
        except anthropic.AuthenticationError as e:
            raise TierError("The Anthropic API key is missing or invalid (ANTHROPIC_API_KEY).") from e
        except anthropic.PermissionDeniedError as e:
            raise TierError("The Anthropic API key lacks permission for this model.") from e
        except anthropic.RateLimitError as e:
            raise TierError("The model provider is rate-limiting us; try again in a minute.") from e
        except anthropic.APIStatusError as e:
            if "credit" in str(e).lower() or "billing" in str(e).lower():
                raise TierError("The Anthropic account is out of credit.") from e
            raise TierError(f"The model provider returned an error ({e.status_code}).") from e
        except anthropic.APIConnectionError as e:
            raise TierError("Could not reach the model provider.") from e

    def _stream(self, kwargs: dict, with_fallback: bool) -> Generator[str, None, TurnResult]:
        if with_fallback:
            ctx = self._client.beta.messages.stream(betas=[_FALLBACK_BETA], fallbacks="default", **kwargs)
        else:
            ctx = self._client.messages.stream(**kwargs)
        with ctx as stream:
            for event in stream:
                if event.type == "text":
                    yield event.text
            msg = stream.get_final_message()

        u = msg.usage
        inp = u.input_tokens or 0
        out = u.output_tokens or 0
        read = getattr(u, "cache_read_input_tokens", 0) or 0
        write = getattr(u, "cache_creation_input_tokens", 0) or 0
        # If a fallback model served the turn, cost it at the dearer of the two.
        priced = max((self.model, msg.model), key=lambda m: PRICES.get(m, FALLBACK_PRICE)[1])
        usage = Usage(inp, write, read, out, cost(priced, inp, out, read, write))

        text = "".join(b.text for b in msg.content if b.type == "text")
        calls = [ToolCall(b.id, b.name, b.input) for b in msg.content if b.type == "tool_use"]
        return TurnResult(text=text, tool_calls=calls, stop_reason=msg.stop_reason or "",
                          usage=usage, model=msg.model,
                          # Thinking blocks included, unchanged: the next round
                          # of this question must replay them as they came.
                          assistant_message={"role": "assistant", "content": msg.content})


def tiers_from_env() -> dict:
    """The two tiers as configured. Effort is the main cost lever: Haiku at its
    default (medium) — SQL accuracy is worth the few thinking tokens at its
    price — and Sonnet one step below its default."""
    client = anthropic.Anthropic(max_retries=2, timeout=90.0)
    return {
        "light": AnthropicTier("light", os.getenv("CHAT_LIGHT_MODEL", "claude-haiku-5-5"),
                               os.getenv("CHAT_LIGHT_EFFORT", "medium"), 8000, client=client),
        "heavy": AnthropicTier("heavy", os.getenv("CHAT_HEAVY_MODEL", "claude-sonnet-5-5"),
                               os.getenv("CHAT_HEAVY_EFFORT", "medium"), 16000,
                               refusal_fallback=os.getenv("CHAT_REFUSAL_FALLBACK", "1") == "1",
                               client=client),
    }
