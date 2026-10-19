// AI Assistant — ask about the MIS data in plain English (backend/routers/chat.py).
//
// The answer streams in as Server-Sent Events over a POST (EventSource cannot
// send the Authorization header). Every figure comes from a query the user can
// open under "Sources": the SQL that ran and the rows it returned. That is the
// trust model — a wrong answer is auditable rather than silent.
//
// What the assistant can see is decided by the server per user (row-level
// security on the database), never by this page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUp, ChevronDown, ChevronRight, Database, Gauge, Layers, RotateCcw, Sparkles, Square,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { canAccessModule } from "@/lib/modules";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const STORE_KEY = "mis_assistant_thread";
const HISTORY_SENT = 6;

interface SqlRun {
  tier: string;
  purpose: string;
  query: string;
  error: string | null;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
}

interface ToolRun {
  name: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

interface Turn {
  id: string;
  question: string;
  answer: string;
  state: "streaming" | "done" | "error";
  deep: boolean;
  tier?: string;
  escalated?: boolean;
  reason?: string | null;
  status?: string;
  sqls: SqlRun[];
  tools: ToolRun[];
  error?: string;
}

interface Status {
  available: boolean;
  reason: string | null;
  budget_left?: boolean;
  deep_available?: boolean;
  user_today_usd?: number;
  user_daily_usd?: number;
  budget_usd?: number;
  spent_usd?: number;
  models?: Record<string, string> | null;
}

interface Usage {
  budget_usd: number;
  spent_usd: number;
  questions: number;
  escalated: number;
  not_ok: number;
  by_user: { name: string; questions: number; cost_usd: number; last: string | null }[];
  recent: { at: string; user: string; question: string; tier: string; escalated: boolean; reason: string | null;
            status: string; cost_usd: number; error: string | null }[];
}

// Suggestions per module, shown only for modules the user holds — a question
// about data they cannot see would only teach them the assistant is broken.
const SUGGESTIONS: { module: Parameters<typeof canAccessModule>[1]; q: string }[] = [
  { module: "sales", q: "Which distributor grew the most last quarter?" },
  { module: "sales", q: "Compare Janak Motors and United Auto month by month this FY" },
  { module: "leads", q: "Which source brought the most leads last month?" },
  { module: "finance", q: "How did sales and net profit move over the last 6 months?" },
  { module: "oe_network", q: "Which dealers were planned but never visited last month?" },
  { module: "oe_network", q: "What was MSIL seat-cover penetration last month?" },
  { module: "export", q: "Which open export leads haven't been contacted in 30 days?" },
  { module: "export", q: "How many export leads are at each stage?" },
];

function loadThread(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const turns: Turn[] = raw ? JSON.parse(raw) : [];
    // A turn interrupted by navigation cannot resume.
    return turns.map((t) => (t.state === "streaming" ? { ...t, state: "error", error: "Interrupted." } : t));
  } catch {
    return [];
  }
}

function saveThread(turns: Turn[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-20)));
  } catch {
    /* storage full or blocked: the thread just won't survive navigation */
  }
}

/** Plain text with "- " bullets and **bold** → React. No HTML injection: the
 *  model's text is never set as markup. */
function AnswerText({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-2.5 text-sm leading-relaxed text-gray-800">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc pl-5 flex flex-col gap-1">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ""))}</li>)}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => <span key={j}>{inline(l)}{j < lines.length - 1 && <br />}</span>)}
          </p>
        );
      })}
    </div>
  );
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return String(v);
}

function Sources({ sqls, tools }: { sqls: SqlRun[]; tools: ToolRun[] }) {
  const [open, setOpen] = useState(false);
  const n = sqls.length + tools.length;
  if (!n) return null;
  return (
    <div className="mt-4 border-t border-orange-50 pt-3">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-800">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Database size={13} />
        Sources · {sqls.length} {sqls.length === 1 ? "query" : "queries"}
        {tools.length > 0 && ` · ${tools.length} calculation${tools.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-4">
          {sqls.map((s, i) => (
            <div key={i} className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-gray-700">
                {s.purpose || `Query ${i + 1}`}
                {s.error
                  ? <span className="ml-2 font-normal text-amber-700">— {s.error}</span>
                  : <span className="ml-2 font-normal text-gray-500">
                      — {s.row_count} row{s.row_count === 1 ? "" : "s"}{s.truncated ? ", first 50 shown" : ""}
                    </span>}
              </p>
              <pre className="text-[11px] leading-relaxed bg-gray-50 border border-gray-100 rounded-xl p-3 overflow-x-auto text-gray-700 whitespace-pre-wrap">
                {s.query}
              </pre>
              {s.columns.length > 0 && s.rows.length > 0 && (
                <div className="overflow-x-auto max-h-72 overflow-y-auto border border-gray-100 rounded-xl">
                  <table className="text-xs w-full">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>{s.columns.map((c) => (
                        <th key={c} className="text-left font-semibold text-gray-600 px-3 py-1.5 whitespace-nowrap">{c}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r, j) => (
                        <tr key={j} className="border-t border-gray-50">
                          {r.map((v, k) => (
                            <td key={k} className={`px-3 py-1 whitespace-nowrap ${
                              v === null ? "text-gray-400" : typeof v === "number" ? "text-right tabular-nums text-gray-800" : "text-gray-700"}`}>
                              {cell(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {tools.map((t, i) => (
            <div key={`t${i}`} className="flex flex-col gap-1">
              <p className="text-xs font-semibold text-gray-700">
                {t.name === "linear_extrapolate" ? "Projection" : "Growth rate"}
                {t.error && <span className="ml-2 font-normal text-amber-700">— {t.error}</span>}
              </p>
              <pre className="text-[11px] bg-gray-50 border border-gray-100 rounded-xl p-3 overflow-x-auto text-gray-700 whitespace-pre-wrap">
                {JSON.stringify({ input: t.input, result: t.result }, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsagePanel({ headers }: { headers: Record<string, string> }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_URL}/chat/usage`, { headers, signal: ctrl.signal })
      .then(async (r) => (r.ok ? setUsage(await r.json()) : setError((await r.json()).detail ?? "Failed")))
      .catch((e) => { if (e.name !== "AbortError") setError(String(e)); });
    return () => ctrl.abort();
  }, [headers]);
  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!usage) return <p className="text-xs text-gray-500">Loading usage…</p>;
  const pct = Math.min(100, (usage.spent_usd / Math.max(usage.budget_usd, 0.0001)) * 100);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl shadow-sm p-5 flex flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-bold text-gray-800">API credit used</p>
          <p className="text-sm tabular-nums text-gray-700">
            ${usage.spent_usd.toFixed(2)} of ${usage.budget_usd.toFixed(2)}
          </p>
        </div>
        <div className="h-2 rounded-full bg-gray-100 mt-2 overflow-hidden">
          <div className="h-full rounded-full bg-brand-orange" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {usage.questions} questions · {usage.escalated} handed to the stronger model · {usage.not_ok} not answered
          cleanly. The cap is <code>CHAT_BUDGET_USD</code> on the server; the Anthropic console's spend limit is the
          backstop.
        </p>
      </div>
      {usage.by_user.length > 0 && (
        <table className="text-xs w-full">
          <thead><tr className="text-left text-gray-500">
            <th className="font-semibold py-1">User</th><th className="font-semibold py-1 text-right">Questions</th>
            <th className="font-semibold py-1 text-right">Cost</th></tr></thead>
          <tbody>{usage.by_user.map((u) => (
            <tr key={u.name} className="border-t border-gray-50 text-gray-700">
              <td className="py-1">{u.name}</td><td className="py-1 text-right tabular-nums">{u.questions}</td>
              <td className="py-1 text-right tabular-nums">${u.cost_usd.toFixed(3)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {usage.recent.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Recent questions</p>
          {usage.recent.map((r, i) => (
            <div key={i} className="text-xs text-gray-700 flex gap-2">
              <span className="text-gray-500 tabular-nums shrink-0">
                {new Date(r.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="shrink-0 font-semibold">{r.user}</span>
              <span className="truncate" title={r.question}>{r.question}</span>
              <span className="ml-auto shrink-0 tabular-nums text-gray-500">
                {r.tier}{r.escalated ? "*" : ""} · {r.status} · ${r.cost_usd.toFixed(4)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AssistantPage() {
  const { token, user } = useAuth();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const isAdmin = user?.role === "superadmin";

  const [status, setStatus] = useState<Status | null>(null);
  const [turns, setTurns] = useState<Turn[]>(loadThread);
  const [input, setInput] = useState("");
  const [deep, setDeep] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const busy = turns.some((t) => t.state === "streaming");

  const loadStatus = useCallback(() => {
    fetch(`${API_URL}/chat/status`, { headers })
      .then(async (r) => setStatus(r.ok ? await r.json()
        : { available: false, reason: (await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}` }))
      .catch(() => setStatus({ available: false, reason: "Could not reach the server" }));
  }, [headers]);
  useEffect(loadStatus, [loadStatus]);
  useEffect(() => saveThread(turns), [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns]);

  const patch = (id: string, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));

  const ask = useCallback(async (question: string, askDeep: boolean) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = `${Date.now()}`;
    const history = turns.filter((t) => t.state === "done" && t.answer).slice(-HISTORY_SENT).map((t) => ({
      question: t.question, answer: t.answer, queries: t.sqls.filter((s) => !s.error).map((s) => s.query).slice(0, 3),
    }));
    setTurns((ts) => [...ts, { id, question: q, answer: "", state: "streaming", deep: askDeep, sqls: [], tools: [] }]);
    setInput("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${API_URL}/chat/ask`, {
        method: "POST", signal: ctrl.signal,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history, deep: askDeep }),
      });
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => ({}))).detail;
        throw new Error(typeof detail === "string" ? detail : `The server returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev || !raw) continue;
          const d = JSON.parse(raw);
          if (ev === "text") patch(id, (t) => ({ ...t, answer: t.answer + d.delta }));
          else if (ev === "meta") patch(id, (t) => ({ ...t, tier: d.tier }));
          else if (ev === "sql") patch(id, (t) => ({ ...t, sqls: [...t.sqls, d] }));
          else if (ev === "tool") patch(id, (t) => ({ ...t, tools: [...t.tools, d] }));
          // Escalating: the light model's draft and its queries are withdrawn.
          else if (ev === "reset") patch(id, (t) => ({ ...t, answer: "", sqls: [], tools: [], escalated: true, reason: d.reason }));
          else if (ev === "done") patch(id, (t) => ({ ...t, state: "done", tier: d.tier, escalated: d.escalated, reason: d.reason, status: d.status }));
          else if (ev === "error") patch(id, (t) => ({ ...t, state: "error", error: d.message }));
        }
      }
      patch(id, (t) => (t.state === "streaming" ? { ...t, state: "error", error: "The answer stopped early." } : t));
    } catch (e) {
      const stopped = e instanceof DOMException && e.name === "AbortError";
      patch(id, (t) => ({ ...t, state: "error", error: stopped ? "Stopped." : e instanceof Error ? e.message : String(e) }));
    } finally {
      abortRef.current = null;
      loadStatus();
    }
  }, [busy, turns, headers, loadStatus]);

  const suggestions = SUGGESTIONS.filter((s) => canAccessModule(user, s.module)).slice(0, 6);
  const deepOk = status?.deep_available !== false;
  const blocked = !status?.available || status?.budget_left === false;

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 pb-3 flex flex-col gap-4 shrink-0">
        {/* Title shrinks, controls do not — see CLAUDE.md § Page header. */}
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-x-3">
              <span className="page-title-dark">AI</span>
              <span className="page-title-orange">ASSISTANT</span>
            </h1>
            <div className="flex items-center gap-2 mt-1 min-w-0">
              <div className="w-8 h-0.5 bg-gray-800 rounded shrink-0" />
              <div className="w-4 h-0.5 rounded shrink-0" style={{ background: "#f46617" }} />
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 truncate">
                Ask about your data in plain English — every figure comes from a query you can open
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isAdmin && (
              <button onClick={() => setShowUsage(!showUsage)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-gray-300">
                <Gauge size={14} /> Usage
              </button>
            )}
            {turns.length > 0 && (
              <button onClick={() => { abortRef.current?.abort(); setTurns([]); }} disabled={busy}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-gray-300 disabled:opacity-50">
                <RotateCcw size={14} /> New conversation
              </button>
            )}
          </div>
        </motion.div>
        {isAdmin && showUsage && <UsagePanel headers={headers} />}
        {status && !status.available && (
          <div className="bg-white border border-orange-100 rounded-2xl shadow-sm p-5 text-sm text-gray-700">
            <p className="font-semibold text-gray-800">The assistant isn't available right now.</p>
            <p className="mt-1 text-gray-600">
              {isAdmin ? status.reason : "An administrator needs to finish setting it up."}
            </p>
          </div>
        )}
        {status?.available && status.budget_left === false && (
          <div className="bg-white border border-orange-100 rounded-2xl shadow-sm p-5 text-sm text-gray-700">
            The assistant's API budget is used up. An administrator can raise it.
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6">
        <div className="max-w-4xl mx-auto flex flex-col gap-5 pb-6">
          {turns.length === 0 && status?.available && (
            <div className="bg-white border border-orange-100 rounded-2xl shadow-sm p-5">
              <div className="flex items-center gap-2 text-gray-800">
                <Sparkles size={16} className="text-brand-orange" />
                <p className="text-sm font-bold">What would you like to know?</p>
              </div>
              <p className="text-xs text-gray-500 mt-1.5 max-w-2xl">
                The assistant answers from the same data as your MIS pages, and only from the modules you have
                access to. It can be wrong: open <span className="font-semibold">Sources</span> under an answer to see
                exactly what it queried. Data is as fresh as the last sheet sync.
              </p>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-4">
                  {suggestions.map((s) => (
                    <button key={s.q} onClick={() => ask(s.q, false)}
                      className="text-xs text-gray-700 px-3 py-1.5 rounded-xl border border-orange-100 bg-orange-50/40 hover:bg-orange-50 hover:border-orange-200 text-left">
                      {s.q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {turns.map((t) => (
            <div key={t.id} className="flex flex-col gap-2">
              <div className="self-end max-w-[85%] bg-gray-100 text-gray-800 text-sm rounded-2xl rounded-br-md px-4 py-2.5 whitespace-pre-wrap">
                {t.question}
              </div>
              <div className="bg-white border border-orange-100 rounded-2xl shadow-sm p-5">
                {t.answer ? <AnswerText text={t.answer} /> : t.state === "streaming" && (
                  <p className="text-sm text-gray-500 animate-pulse">
                    {t.sqls.length ? "Reading the results…" : t.escalated ? "Taking a closer look…" : "Working on it…"}
                  </p>
                )}
                {t.state === "error" && (
                  <p className={`text-sm ${t.answer ? "mt-3" : ""} text-red-600`}>{t.error}</p>
                )}
                <Sources sqls={t.sqls} tools={t.tools} />
                {t.state === "done" && (
                  <div className="mt-3 flex items-center gap-3 flex-wrap text-xs text-gray-500">
                    {/* Shown, not hidden: it tells the reader which answers
                        got the second look, and builds trust in the rest. */}
                    {t.escalated && (
                      <span className="flex items-center gap-1" title={t.reason ?? undefined}>
                        <Layers size={12} /> Answered by the stronger model{t.reason ? ` — ${t.reason}` : ""}
                      </span>
                    )}
                    {!t.escalated && t.tier === "light" && deepOk && !busy && (
                      <button onClick={() => ask(t.question, true)}
                        className="font-semibold text-gray-600 hover:text-brand-orange">
                        Not right? Ask again with deep dive
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-6 pb-6 pt-2 shrink-0">
        <div className="max-w-4xl mx-auto bg-white border border-orange-100 rounded-2xl shadow-sm p-3 flex flex-col gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} maxLength={1000}
            disabled={blocked}
            placeholder={blocked ? "The assistant is unavailable" : "Ask a question about your data…"}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input, deep); }
            }}
            className="w-full resize-none text-sm text-gray-800 placeholder:text-gray-500 outline-none px-2 py-1 bg-transparent" />
          <div className="flex items-center justify-between gap-3">
            <label className={`flex items-center gap-2 text-xs ${deepOk ? "text-gray-600" : "text-gray-400 line-through"}`}
              title={deepOk ? "Use the stronger, slower model from the start — for multi-step or forecasting questions"
                : "Not available: the API budget is running low"}>
              <input type="checkbox" checked={deep && deepOk} disabled={!deepOk}
                onChange={(e) => setDeep(e.target.checked)} className="accent-brand-orange" />
              Deep dive
            </label>
            <div className="flex items-center gap-3">
              {status?.user_daily_usd !== undefined && (status.user_today_usd ?? 0) > status.user_daily_usd * 0.8 && (
                <span className="text-xs text-gray-500">Near today's limit</span>
              )}
              {busy ? (
                <button onClick={() => abortRef.current?.abort()}
                  className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border border-gray-200 text-gray-700 hover:border-gray-300">
                  <Square size={12} /> Stop
                </button>
              ) : (
                <button onClick={() => ask(input, deep)} disabled={!input.trim() || blocked}
                  className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-xl bg-brand-orange text-white hover:opacity-90 disabled:opacity-40">
                  <ArrowUp size={14} /> Ask
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
