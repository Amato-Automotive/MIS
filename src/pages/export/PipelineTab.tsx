// Export › Pipeline — where the export leads stand today.
//
// Everything here is a snapshot: the sheet is overwritten as leads move, so
// there is no "last month" to compare with. Ageing comes from Last Contact
// (the Activity tab), the Target Closure Date, and the stage moves the sync
// has seen — all measured against today.
//
// Most of this list is still unfilled (no estimate, no target date), so every
// figure says how much of the list it actually covers, and the Data Gaps panel
// at the bottom is the to-do list for the export team.
import { Briefcase, IndianRupee, Trophy, Clock, AlarmClock } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import Select from "@/components/ui/Select";
import Explain from "../oe-network/dealers/Explain";
import {
  StatCard, KPI, VISIT_COLOR, TGT_TRACK, CHART_LABEL, Panel, fmtCr, potCoverage, fmtDay, fmtDays, plural, NOT_SET,
  HEALTH, HEALTH_ORDER,
  type Summary, type Group, type AttentionItem, type Filters, type HealthLevel,
} from "./shared";

export const STALE_CHOICES = [14, 30, 60, 90];

export default function PipelineTab({ data, staleDays, setStaleDays, regionLabel, onPickStage, onFilter }: {
  data: Summary; staleDays: number; setStaleDays: (n: number) => void;
  regionLabel: (r: string | null) => string; onPickStage: (stage: number) => void;
  onFilter: (patch: Partial<Filters>) => void;
}) {
  const k = data.kpis;
  const dq = data.data_quality;
  const maxReached = Math.max(1, ...data.funnel.map((f) => f.reached));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard label="Open Leads" value={k.open}
          sub={`${k.active} active · ${k.on_hold} on hold${k.no_status ? ` · ${k.no_status} no status` : ""}`}
          icon={<Briefcase size={18} />} {...KPI.ours} />
        <StatCard label="Open Pipeline"
          value={k.pipeline.potential_cr != null ? fmtCr(k.pipeline.potential_cr) : "—"}
          sub={potCoverage(k.pipeline)}
          icon={<IndianRupee size={18} />} {...KPI.ours} />
        <StatCard label="Won" value={k.won}
          sub={k.won_potential.potential_cr != null
            ? `${fmtCr(k.won_potential.potential_cr)} · ${potCoverage(k.won_potential)}`
            : k.lost ? `${k.lost} lost` : undefined}
          icon={<Trophy size={18} />} {...KPI.conversion} />
        <StatCard label={`No Contact ${staleDays}+ Days`} value={k.stale}
          sub={`${dq.missing_last_contact} open lead${dq.missing_last_contact === 1 ? " has" : "s have"} no logged activity`}
          icon={<Clock size={18} />} {...KPI.warning} />
        <StatCard label="Overdue Next Actions" value={k.overdue_actions}
          sub="next action date has passed"
          icon={<AlarmClock size={18} />} {...KPI.danger} />
      </div>

      <Explain>
        <b className="text-gray-700">Open</b> is every lead not marked Won or Lost — a lead with no
        status is still open, because nobody has closed it.{" "}
        <b className="text-gray-700">Open Pipeline</b> adds up the Est. Potential (₹ crore a year) of
        open leads that have one; a lead with no estimate adds nothing and is{" "}
        <b className="text-gray-700">not</b> counted as zero — read it with its &ldquo;
        {potCoverage(k.pipeline)}&rdquo; beside it. Won business is shown separately and is never part of
        the pipeline. This is the list as it stands today: the sheet is overwritten as leads move, so
        there is no period to pick.
      </Explain>

      {/* ── Stage funnel ─────────────────────────────────────────────────── */}
      <Panel title="Stage Funnel"
        sub="Orange: open leads sitting at this stage now · grey: every lead that has reached this stage or gone past it">
        <div className="flex flex-col gap-1.5 mt-2">
          {data.funnel.map((f) => (
            <button key={f.stage} onClick={() => onPickStage(f.stage)}
              title={`Show the ${f.open_here} lead${f.open_here === 1 ? "" : "s"} at stage ${f.stage}`}
              className="group flex items-center gap-3 text-left rounded-lg px-1 -mx-1 py-0.5 hover:bg-orange-50/60">
              <span className="w-44 shrink-0 text-xs text-gray-600 truncate">
                <b className="text-gray-700">{f.stage}</b> · {f.name}
              </span>
              <span className="relative flex-1 h-4 rounded-md overflow-hidden" style={{ background: "#f9fafb" }}>
                <span className="absolute inset-y-0 left-0 rounded-md"
                  style={{ width: `${(f.reached / maxReached) * 100}%`, background: TGT_TRACK }} />
                <span className="absolute inset-y-0 left-0 rounded-md"
                  style={{ width: `${(f.open_here / maxReached) * 100}%`, background: VISIT_COLOR }} />
              </span>
              <span className="w-24 shrink-0 text-right text-xs">
                <b className="text-gray-800">{f.open_here}</b>
                <span className="text-gray-500"> / {f.reached}</span>
              </span>
              <span className="hidden md:block w-28 shrink-0 text-right text-[11px] text-gray-500">
                {f.pipeline.potential_cr != null ? fmtCr(f.pipeline.potential_cr) : "—"}
              </span>
              <span className="hidden md:block w-24 shrink-0 text-right text-[11px] text-gray-500"
                title={f.days_known
                  ? `Median of the ${f.days_known} lead(s) whose arrival at this stage is known`
                  : "No lead's arrival at this stage is known yet"}>
                {f.median_days_in_stage != null ? `${Math.round(f.median_days_in_stage)}d here` : "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="hidden md:flex justify-end gap-0 text-[10px] font-bold uppercase tracking-wider text-gray-500 mt-2">
          <span className="w-24 text-right">Here / reached</span>
          <span className="w-28 text-right">Potential</span>
          <span className="w-24 text-right">Median time</span>
        </div>
        <Explain>
          Stages run in order, so a lead at stage 6 has been through 1–5:{" "}
          <b className="text-gray-700">reached</b> counts every lead whose current stage is this one
          or later, including lost ones (they reached the stage where they were lost). The gap
          between two neighbouring grey bars is how many leads have stopped there.{" "}
          <b className="text-gray-700">Median time</b> is how long open leads have sat at the stage.
          It is measured from the day a sync saw the lead move into it.{" "}
          {data.tracking_since
            ? <>Stage moves have been recorded since <b className="text-gray-700">{fmtDay(data.tracking_since)}</b>; a
                lead already at its stage then has only a minimum (&ldquo;≥&rdquo; below) and is left
                out of the median.</>
            : <>No sync has recorded stage moves yet.</>}
          {data.no_stage_open > 0 && <> {plural(data.no_stage_open, "open lead has", "open leads have")} no stage and {data.no_stage_open === 1 ? "is" : "are"} not in the funnel.</>}
          {" "}Click a stage to see its leads.
        </Explain>
      </Panel>

      {/* ── Health ──────────────────────────────────────────────────────── */}
      <HealthByStage data={data} onFilter={onFilter} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StageAge data={data} />
        <TargetTimeline data={data} />
      </div>

      {/* ── Needs attention ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Overdue Next Actions" sub="Open leads whose next action date has passed, most overdue first">
          <AttentionList items={data.attention.overdue_actions} total={k.overdue_actions}
            metric={(a) => a.next_action_date ? `due ${fmtDay(a.next_action_date)}` : "—"}
            detail={(a) => a.next_action}
            emptyText={dq.open ? "Nothing overdue." : "No open leads in this selection."}
            tone="text-red-600" />
        </Panel>
        <Panel title="Gone Quiet"
          sub={`Open leads with no contact for more than ${staleDays} days, longest first`}
          right={
            <Select value={String(staleDays)} onChange={(v) => setStaleDays(Number(v))}
              options={STALE_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }))} />
          }>
          <AttentionList items={data.attention.stale} total={k.stale}
            metric={(a) => `${a.days_since_contact}d`}
            detail={(a) => a.stage_name && `Stage ${a.stage_no} · ${a.stage_name}`}
            emptyText={dq.missing_last_contact === dq.open && dq.open > 0
              ? `No open lead has any activity logged yet, so there is nothing to measure.`
              : `Every open lead with logged activity was contacted in the last ${staleDays} days.`}
            tone="text-amber-600" />
          {dq.missing_last_contact > 0 && dq.missing_last_contact < dq.open && (
            <p className="text-[10px] text-gray-500 mt-2">
              {plural(dq.missing_last_contact, "open lead has", "open leads have")} nothing on the
              Activity tab and cannot be judged either way — they are not counted here. Last contact
              is the newest Activity entry for the company.
            </p>
          )}
        </Panel>
        <Panel title="Past Target Closure"
          sub="Open leads whose Target Closure Date has passed, furthest past first">
          <AttentionList items={data.attention.past_target} total={k.past_target}
            metric={(a) => a.target_close_date ? `target ${fmtDay(a.target_close_date)}` : "—"}
            detail={(a) => a.stage_name && `Stage ${a.stage_no} · ${a.stage_name}`}
            emptyText={!dq.open
              ? "No open leads in this selection."
              : dq.missing_target_close === dq.open
                ? "No open lead has a Target Closure Date yet, so there is nothing to check."
                : "Every open lead with a target date is still within it."}
            tone="text-amber-600" />
          {dq.missing_target_close > 0 && dq.missing_target_close < dq.open && (
            <p className="text-[10px] text-gray-500 mt-2">
              {plural(dq.missing_target_close, "open lead has", "open leads have")} no Target Closure
              Date and cannot be judged either way — they are not counted here.
            </p>
          )}
        </Panel>
        <Panel title="Longest in Stage" sub="Open leads that have sat longest at their current stage">
          <AttentionList items={data.attention.longest_in_stage}
            total={data.attention.longest_in_stage.length}
            metric={(a) => fmtDays(a.days_in_stage, a.days_in_stage_basis)}
            detail={(a) => a.stage_name && `Stage ${a.stage_no} · ${a.stage_name}`}
            emptyText={dq.open
              ? "No open lead's time in stage is known yet. It fills in from the next sync onward."
              : "No open leads in this selection."}
            tone="text-gray-700" />
          {data.attention.longest_in_stage.some((a) => a.days_in_stage_basis === "floor") && (
            <p className="text-[10px] text-gray-500 mt-2">
              &ldquo;≥&rdquo; is a minimum: the lead was already at that stage when tracking began.
            </p>
          )}
        </Panel>
      </div>

      {/* ── Splits ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="By Market"
          sub="UK, Europe and Australia, from each lead's country — any other country is Other">
          <GroupBars rows={data.by_region} label={regionLabel} />
        </Panel>
        <Panel title="By Salesperson" sub="Whoever the sheet names as the lead's owner, joint owners as their own row">
          <GroupBars rows={data.by_owner} label={(k) => k ?? NOT_SET} />
        </Panel>
        <Panel title="By Customer Type">
          <GroupBars rows={data.by_customer_type} label={(k) => k ?? NOT_SET} />
        </Panel>
        <Panel title="By Source" sub="Where the lead came from">
          <GroupBars rows={data.by_source} label={(k) => k ?? NOT_SET} />
        </Panel>
      </div>

      <LostReasons data={data} />

      <DataGaps dq={data.data_quality} />
    </div>
  );
}

function AttentionList({ items, total, metric, detail, emptyText, tone }: {
  items: AttentionItem[]; total: number;
  metric: (a: AttentionItem) => string; detail: (a: AttentionItem) => string | null | undefined;
  emptyText: string; tone: string;
}) {
  if (!items.length) return <p className="text-xs text-gray-500 py-3">{emptyText}</p>;
  return (
    <div className="flex flex-col">
      {items.map((a) => (
        <div key={a.company} className="flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-700 truncate" title={a.company}>{a.company}</p>
            <p className="text-[10px] text-gray-500 truncate" title={detail(a) ?? undefined}>
              {[a.owner ?? "No salesperson", detail(a)].filter(Boolean).join(" · ")}
            </p>
          </div>
          <span className={`text-xs font-bold shrink-0 ${tone}`}>{metric(a)}</span>
        </div>
      ))}
      {total > items.length && (
        <p className="text-[10px] text-gray-500 pt-2">and {total - items.length} more — see the Leads tab</p>
      )}
    </div>
  );
}

/** One row per group: an orange bar for its open leads, the won count, and its
 *  open potential with how many leads that total covers. */
function GroupBars({ rows, label }: { rows: Group[]; label: (k: string | null) => string }) {
  if (!rows.length) return <p className="text-xs text-gray-500 py-3">No leads in this selection.</p>;
  const max = Math.max(1, ...rows.map((r) => r.open));
  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {rows.map((r) => (
        <div key={r.key ?? "__none"} className="flex items-center gap-3">
          <span className={`w-36 shrink-0 text-xs truncate ${r.key == null ? "italic text-gray-500" : "text-gray-600"}`}
            title={label(r.key)}>{label(r.key)}</span>
          <span className="relative flex-1 h-3.5 rounded-md overflow-hidden" style={{ background: "#f9fafb" }}>
            <span className="absolute inset-y-0 left-0 rounded-md"
              style={{ width: `${(r.open / max) * 100}%`, background: VISIT_COLOR }} />
          </span>
          <span className="w-16 shrink-0 text-right text-xs">
            <b className="text-gray-800">{r.open}</b>
            <span className="text-gray-500"> open</span>
          </span>
          <span className="w-12 shrink-0 text-right text-[11px] text-green-700">
            {r.won ? `${r.won} won` : ""}
          </span>
          <span className="hidden sm:block w-24 shrink-0 text-right text-[11px] text-gray-500"
            title={potCoverage(r.pipeline)}>
            {r.pipeline.potential_cr != null ? fmtCr(r.pipeline.potential_cr) : "—"}
          </span>
        </div>
      ))}
      <p className="text-[10px] text-gray-500 mt-1">
        Right-hand figure is open potential — hover it for how many leads it covers.
      </p>
    </div>
  );
}

/** How much of the list the team has filled in. Grey, never red: an empty
 *  cell is missing information, not a bad result. */
function DataGaps({ dq }: { dq: Summary["data_quality"] }) {
  const rows = [
    { label: "Salesperson", filled: dq.leads - dq.missing_owner, of: dq.leads, of_label: "leads" },
    { label: "Stage", filled: dq.leads - dq.missing_stage, of: dq.leads, of_label: "leads" },
    { label: "Market (from Country)", filled: dq.leads - dq.missing_region, of: dq.leads, of_label: "leads" },
    { label: "Target Closure Date", filled: dq.open - dq.missing_target_close, of: dq.open, of_label: "open leads" },
    { label: "Any logged activity", filled: dq.open - dq.missing_last_contact, of: dq.open, of_label: "open leads" },
    { label: "Est. Potential", filled: dq.open - dq.missing_potential, of: dq.open, of_label: "open leads" },
    // Only meaningful once something has been lost; hidden rather than "0 of 0".
    ...(dq.lost ? [{ label: "Lost Reason", filled: dq.lost - dq.missing_lost_reason, of: dq.lost, of_label: "lost leads" }] : []),
  ];
  return (
    <Panel title="Data Gaps"
      sub="How much of the sheet is filled in — everything above can only be as complete as this">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 mt-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-xs text-gray-600">{r.label}</span>
            <span className="relative flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <span className="absolute inset-y-0 left-0 rounded-full bg-gray-500"
                style={{ width: r.of ? `${(r.filled / r.of) * 100}%` : "0%" }} />
            </span>
            <span className="w-32 shrink-0 text-right text-[11px] text-gray-600">
              <b>{r.filled}</b> of {r.of} {r.of_label}
            </span>
          </div>
        ))}
      </div>
      <Explain>
        These are gaps in the export team&rsquo;s sheet. <b className="text-gray-700">Any logged
        activity</b> counts open leads with at least one row on the Activity tab — that is where
        Last Contact comes from, so a lead with none cannot show up as gone quiet.{" "}
        <b className="text-gray-700">Target Closure Date</b> is what Past Target Closure checks
        against. Fix them in the sheet, then press Sync.
      </Explain>
    </Panel>
  );
}

/** Where in the funnel the trouble sits: one row per stage, its open leads
 *  split by health. Clicking a coloured block lists exactly those leads. */
function HealthByStage({ data, onFilter }: { data: Summary; onFilter: (p: Partial<Filters>) => void }) {
  const rows = data.health.by_stage;
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <Panel title="Health by Stage"
      sub="Open leads at each stage, coloured by how urgent they are — click a colour to list those leads">
      <div className="flex flex-col gap-1.5 mt-2">
        {rows.map((r) => (
          <div key={String(r.key)} className="flex items-center gap-3">
            <span className={`w-44 shrink-0 text-xs truncate ${r.key == null ? "italic text-gray-500" : "text-gray-600"}`}
              title={r.label ?? ""}>{r.label}</span>
            <span className="flex-1 flex h-4 rounded-md overflow-hidden bg-gray-50">
              {r.leads > 0 && HEALTH_ORDER.map((lv) => r.counts[lv] ? (
                <button key={lv} title={`${HEALTH[lv].label}: ${r.counts[lv]} — click to list`}
                  onClick={() => onFilter({ health: lv, stage: r.key == null ? "" : String(r.key) })}
                  className="h-full hover:opacity-80"
                  style={{ width: `${(r.counts[lv] / max) * 100}%`, background: HEALTH[lv].swatch }} />
              ) : null)}
            </span>
            <span className="w-28 shrink-0 text-right text-xs">
              <b className="text-gray-800">{r.leads}</b>
              {(r.counts.critical + r.counts.at_risk) > 0 && (
                <span className="text-red-600 font-semibold"> · {r.counts.critical + r.counts.at_risk} red/amber</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <Legend />
    </Panel>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
      {HEALTH_ORDER.map((lv) => (
        <span key={lv} className="flex items-center gap-1.5 text-[10px] text-gray-600">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: HEALTH[lv].swatch }} />
          {HEALTH[lv].label}
        </span>
      ))}
      <span className="text-[10px] text-gray-500">· the rules are on the Highlights tab</span>
    </div>
  );
}

// Each age bucket wears the colour the stage clock gives a lead in it.
const AGE_LEVEL: Record<string, HealthLevel> = {
  "0–29 days": "on_track", "30–59 days": "watch", "60–89 days": "at_risk", "90+ days": "critical",
};

function StageAge({ data }: { data: Summary }) {
  const rows = data.health.stage_age;
  const unknown = rows.find((r) => r.key == null)?.leads ?? 0;
  const known = rows.filter((r) => r.key != null) as { key: string; leads: number }[];
  const max = Math.max(1, ...known.map((r) => r.leads));
  return (
    <Panel title="Time at Current Stage" sub="Open leads by how long they have sat without moving stage">
      <div className="flex flex-col gap-2 mt-2">
        {known.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs text-gray-600">{r.key}</span>
            <span className="flex-1 h-4 rounded-md bg-gray-50 overflow-hidden">
              <span className="block h-full rounded-md"
                style={{ width: `${(r.leads / max) * 100}%`, background: HEALTH[AGE_LEVEL[r.key]].swatch }} />
            </span>
            <span className="w-10 shrink-0 text-right text-xs font-bold text-gray-800">{r.leads}</span>
          </div>
        ))}
      </div>
      <Explain>
        Measured from the day a sync saw the lead arrive at its stage.{" "}
        {unknown > 0 && <><b className="text-gray-700">{plural(unknown, "open lead")}</b> {unknown === 1 ? "is" : "are"} not
          in a bucket yet: {unknown === 1 ? "it was" : "they were"} already at {unknown === 1 ? "its" : "their"} stage
          when tracking began{data.tracking_since && <> ({fmtDay(data.tracking_since)})</>}, so only a minimum is
          known. Each one moves into 90+ by itself if it still has not moved 90 days after that.</>}
      </Explain>
    </Panel>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WHEN_LEVEL: Record<"past" | "current" | "future", HealthLevel> = {
  past: "critical", current: "watch", future: "on_track",
};

function TargetTimeline({ data }: { data: Summary }) {
  const tl = data.health.target_timeline.map((m) => ({
    ...m, name: `${MONTHS[m.month - 1]} ${String(m.year).slice(2)}`,
  }));
  const noTarget = data.health.no_target;
  return (
    <Panel title="Target Closure Timeline"
      sub="Open leads by the month they are meant to close — red months have already gone by">
      {!tl.length ? (
        <p className="text-xs text-gray-500 py-6 text-center">
          No open lead has a Target Closure Date yet. Fill the column on the Leads tab and this
          becomes the closing calendar.
        </p>
      ) : (
        <div className="h-56 mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={tl} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_LABEL }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: CHART_LABEL }} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "#fff7ed" }} content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const m = payload[0].payload as (typeof tl)[number];
                return (
                  <div className="bg-gray-900 rounded-lg px-3 py-2 text-[11px] text-white shadow-lg">
                    <p className="font-bold">{m.name}</p>
                    <p className="text-white/70">{plural(m.leads, "lead")} due to close</p>
                    <p className="text-white/70">
                      {m.potential_cr != null
                        ? `${fmtCr(m.potential_cr)} across ${m.potential_count} with an estimate`
                        : "no estimates"}
                    </p>
                  </div>
                );
              }} />
              <Bar dataKey="leads" radius={[4, 4, 0, 0]}>
                {tl.map((m) => <Cell key={m.name} fill={HEALTH[WHEN_LEVEL[m.when]].swatch} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-[10px] text-gray-500 mt-2">
        {plural(noTarget, "open lead")} of {data.health.open} {noTarget === 1 ? "has" : "have"} no
        Target Closure Date and {noTarget === 1 ? "is" : "are"} not on this chart. Yellow is this month.
      </p>
    </Panel>
  );
}

/** Why we lose. Only drawn once something has been lost — an empty chart of
 *  reasons says nothing the Won/Lost count doesn't. */
function LostReasons({ data }: { data: Summary }) {
  const rows = data.lost_reasons;
  if (!data.kpis.lost) return null;
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <Panel title="Why Leads Are Lost"
      sub={`All ${plural(data.kpis.lost, "lost lead")} in this selection, by the reason the team gave`}>
      <div className="flex flex-col gap-1.5 mt-2">
        {rows.map((r) => (
          <div key={r.key ?? "__none"} className="flex items-center gap-3">
            <span className={`w-44 shrink-0 text-xs truncate ${r.key == null ? "italic text-gray-500" : "text-gray-600"}`}>
              {r.key ?? "No reason given"}
            </span>
            <span className="relative flex-1 h-3.5 rounded-md overflow-hidden" style={{ background: "#f9fafb" }}>
              <span className="absolute inset-y-0 left-0 rounded-md bg-gray-400"
                style={{ width: `${(r.leads / max) * 100}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right text-xs font-semibold text-gray-700">{r.leads}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
