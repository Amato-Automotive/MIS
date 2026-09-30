// Export › Pipeline — where the UK / EU / AU leads stand today.
//
// Everything here is a snapshot: the sheet is overwritten as leads move, so
// there is no "last month" to compare with. Ageing comes from the team's own
// dates — Stage Since and Last Contact — measured against today.
//
// Most of this list is still unfilled (no estimate, no Stage Since), so every
// figure says how much of the list it actually covers, and the Data Gaps panel
// at the bottom is the to-do list for the export team.
import { Briefcase, IndianRupee, Trophy, Clock, AlarmClock } from "lucide-react";
import Select from "@/components/ui/Select";
import Explain from "../oe-network/dealers/Explain";
import {
  StatCard, KPI, VISIT_COLOR, TGT_TRACK, Panel, fmtCr, potCoverage, fmtDay, plural, NOT_SET,
  type Summary, type Group, type AttentionItem,
} from "./shared";

export const STALE_CHOICES = [14, 30, 60, 90];

export default function PipelineTab({ data, staleDays, setStaleDays, regionLabel, onPickStage }: {
  data: Summary; staleDays: number; setStaleDays: (n: number) => void;
  regionLabel: (r: string | null) => string; onPickStage: (stage: number) => void;
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
          sub={`${dq.missing_last_contact} open lead${dq.missing_last_contact === 1 ? " has" : "s have"} no date`}
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
                title={f.days_known ? `Median of the ${f.days_known} lead(s) with a Stage Since date` : "No Stage Since dates at this stage"}>
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
          <b className="text-gray-700">Median time</b> is how long open leads have sat at the stage,
          from their Stage Since date — it shows &ldquo;—&rdquo; until the team fills that date in
          ({dq.missing_stage_since} of {dq.open} open leads are still blank).
          {data.no_stage_open > 0 && <> {plural(data.no_stage_open, "open lead has", "open leads have")} no stage and {data.no_stage_open === 1 ? "is" : "are"} not in the funnel.</>}
          {" "}Click a stage to see its leads.
        </Explain>
      </Panel>

      {/* ── Needs attention ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
              ? `No open lead has a Last Contact date yet, so there is nothing to measure.`
              : `Every open lead with a Last Contact date was contacted in the last ${staleDays} days.`}
            tone="text-amber-600" />
          {dq.missing_last_contact > 0 && dq.missing_last_contact < dq.open && (
            <p className="text-[10px] text-gray-500 mt-2">
              {plural(dq.missing_last_contact, "open lead has", "open leads have")} no Last Contact
              date and cannot be judged either way — they are not counted here.
            </p>
          )}
        </Panel>
        <Panel title="Longest in Stage" sub="Open leads that have sat longest at their current stage">
          <AttentionList items={data.attention.longest_in_stage}
            total={data.attention.longest_in_stage.length}
            metric={(a) => `${a.days_in_stage}d`}
            detail={(a) => a.stage_name && `Stage ${a.stage_no} · ${a.stage_name}`}
            emptyText={dq.open
              ? "No open lead has a Stage Since date yet. Once the team fills it in, the leads stuck longest appear here."
              : "No open leads in this selection."}
            tone="text-gray-700" />
        </Panel>
      </div>

      {/* ── Splits ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="By Market" sub="UK, Europe and Australia — the region comes from each lead's country">
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
    { label: "Stage Since", filled: dq.open - dq.missing_stage_since, of: dq.open, of_label: "open leads" },
    { label: "Last Contact", filled: dq.open - dq.missing_last_contact, of: dq.open, of_label: "open leads" },
    { label: "Est. Potential", filled: dq.open - dq.missing_potential, of: dq.open, of_label: "open leads" },
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
        These are cells the export team has left blank in the Leads sheet. Stage Since and Last
        Contact matter most: without them the Median time, Gone Quiet and Longest in Stage panels
        have nothing to measure. Fix them in the sheet, then press Sync.
      </Explain>
    </Panel>
  );
}
