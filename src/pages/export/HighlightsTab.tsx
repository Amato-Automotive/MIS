// Export › Highlights — the page to open first: what needs doing, in the
// order to do it, and why each lead is the colour it is.
//
// Every lead's colour comes from services/export_health.py, which reads four
// clocks (time at stage, time since contact, next action date, target closure
// date) and takes the worst. This tab draws that verdict and, next to every
// number, says how it was reached — the legend printed here is built from the
// thresholds the API sends, so the page cannot drift from the rule.
import { AlertOctagon, AlertTriangle, Eye, CheckCircle2, PauseCircle, HelpCircle } from "lucide-react";
import Explain from "../oe-network/dealers/Explain";
import {
  StatCard, KPI, Panel, HEALTH, HEALTH_ORDER, HealthPill, HealthBar, fmtCr, fmtDay, plural, NOT_SET,
  type Summary, type HealthLevel, type HealthItem, type HealthSplit, type Filters, type FeedItem,
} from "./shared";

const TILE: Record<HealthLevel, { icon: React.ReactNode; role: { color: string; bg: string }; sub: string }> = {
  critical: { icon: <AlertOctagon size={18} />,  role: KPI.danger,     sub: "a clock is past its red line" },
  at_risk:  { icon: <AlertTriangle size={18} />, role: KPI.warning,    sub: "slipping — fix before it goes red" },
  watch:    { icon: <Eye size={18} />,           role: KPI.caution,    sub: "something falls due soon" },
  on_track: { icon: <CheckCircle2 size={18} />,  role: KPI.conversion, sub: "contacted recently, nothing overdue" },
  parked:   { icon: <PauseCircle size={18} />,   role: KPI.neutral,    sub: "status On Hold — not judged" },
  unknown:  { icon: <HelpCircle size={18} />,    role: KPI.neutral,    sub: "no contact logged yet" },
};

export default function HighlightsTab({ data, regionLabel, onFilter }: {
  data: Summary; regionLabel: (r: string | null) => string;
  onFilter: (patch: Partial<Filters>) => void;
}) {
  const h = data.health;
  const c = h.counts;

  if (!h.open) {
    return (
      <Panel title="Highlights">
        <p className="text-xs text-gray-500 py-6 text-center">
          No open leads in this selection — everything here is Won or Lost, so there is nothing to chase.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Headline data={data} />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {HEALTH_ORDER.map((lv) => (
          <button key={lv} onClick={() => onFilter({ health: lv })} disabled={!c[lv]}
            title={c[lv] ? `Show the ${plural(c[lv], "lead")} marked ${HEALTH[lv].label}` : undefined}
            className="text-left w-full rounded-2xl transition hover:-translate-y-0.5 disabled:hover:translate-y-0 disabled:cursor-default">
            <StatCard label={HEALTH[lv].label} value={c[lv]} sub={TILE[lv].sub}
              icon={TILE[lv].icon} {...TILE[lv].role} />
          </button>
        ))}
      </div>

      <Panel title="All Open Leads at a Glance" sub={`${plural(h.open, "open lead")}, worst first — click a colour to list them`}>
        <div className="flex h-7 rounded-lg overflow-hidden mt-1">
          {HEALTH_ORDER.map((lv) => c[lv] ? (
            <button key={lv} onClick={() => onFilter({ health: lv })}
              title={`${HEALTH[lv].label}: ${c[lv]}`}
              className="h-full flex items-center justify-center text-[11px] font-bold hover:opacity-90"
              style={{ width: `${(c[lv] / h.open) * 100}%`, background: HEALTH[lv].swatch, color: HEALTH[lv].ink }}>
              {c[lv] / h.open >= 0.06 ? c[lv] : ""}
            </button>
          ) : null)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
          {HEALTH_ORDER.map((lv) => (
            <span key={lv} className="flex items-center gap-1.5 text-[11px] text-gray-600">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: HEALTH[lv].swatch }} />
              {HEALTH[lv].label} <b className="text-gray-800">{c[lv]}</b>
            </span>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <LeadList level="critical" title="Act Now" data={data} regionLabel={regionLabel} onFilter={onFilter}
          empty="Nothing is red. No lead has a clock past its red line." />
        <LeadList level="at_risk" title="At Risk" data={data} regionLabel={regionLabel} onFilter={onFilter}
          empty="Nothing is amber." />
        <LeadList level="watch" title="Coming Up" data={data} regionLabel={regionLabel} onFilter={onFilter}
          empty="Nothing falls due in the next few weeks." />
      </div>

      <Rules data={data} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Who Holds the Red" sub="Open leads per salesperson, coloured by health — click a name to see their list">
          <SplitBars rows={h.by_owner} label={(k) => (k as string | null) ?? NOT_SET}
            onPick={(k) => onFilter({ owner: (k as string | null) ?? "" })} pickable={(k) => k != null} />
        </Panel>
        <Panel title="Health by Market" sub="UK, Europe, Australia and Other — from each lead's country">
          <SplitBars rows={h.by_region} label={(k) => regionLabel(k as string | null)}
            onPick={(k) => onFilter({ region: (k as string | null) ?? "" })} pickable={(k) => k != null} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Recent data={data} />
        <FixTheSheet data={data} />
      </div>
    </div>
  );
}

/** The page in words — what someone reads if they read nothing else. */
function Headline({ data }: { data: Summary }) {
  const h = data.health;
  const c = h.counts;
  const judged = h.open - c.unknown - c.parked;
  const topGap = [
    { n: h.gaps.no_activity, text: "nothing logged on the Activity tab" },
    { n: h.gaps.no_owner, text: "no salesperson" },
    { n: h.gaps.no_target, text: "no Target Closure Date" },
  ].sort((a, b) => b.n - a.n)[0];
  const red = h.lists.critical;

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">In one line</p>
      <p className="text-base text-gray-800 leading-relaxed">
        Of <b>{plural(h.open, "open lead")}</b>,{" "}
        {c.critical
          ? <><b className="text-red-600">{c.critical} need action now</b>{red.potential_cr != null && <> ({fmtCr(red.potential_cr)} across the {red.potential_count} with an estimate)</>}</>
          : <b className="text-green-700">none need action now</b>}
        {c.at_risk ? <>, <b className="text-amber-600">{c.at_risk} {c.at_risk === 1 ? "is" : "are"} slipping</b></> : null}
        {c.watch ? <> and <b className="text-yellow-700">{c.watch} {c.watch === 1 ? "has" : "have"} something due soon</b></> : null}.
        {c.unknown > 0 && (
          <> <b className="text-gray-700">{c.unknown}</b> cannot be judged yet: nobody has logged a contact
            with {c.unknown === 1 ? "it" : "them"} and nothing else is overdue
            {topGap.n > 0 && <> — the biggest gap is {plural(topGap.n, "lead")} with {topGap.text}</>}.</>
        )}
      </p>
      {judged > 0 && c.on_track === judged && (
        <p className="text-xs text-gray-500 mt-1">Every lead that can be judged is on track.</p>
      )}
    </div>
  );
}

function LeadList({ level, title, data, regionLabel, onFilter, empty }: {
  level: "critical" | "at_risk" | "watch"; title: string; data: Summary;
  regionLabel: (r: string | null) => string; onFilter: (patch: Partial<Filters>) => void; empty: string;
}) {
  const { items, total } = data.health.lists[level];
  return (
    <Panel title={title}
      sub={level === "critical" ? "Worst first, then biggest potential — start at the top"
        : level === "at_risk" ? "Will turn red if nothing happens"
        : "Next actions due within a week, target closures within a month"}
      right={<HealthPill level={level} />}>
      {!items.length ? <p className="text-xs text-gray-500 py-3">{empty}</p> : (
        <div className="flex flex-col">
          {items.map((i) => <LeadCard key={i.company} item={i} level={level} regionLabel={regionLabel} />)}
          {total > items.length && (
            <button onClick={() => onFilter({ health: level })}
              className="text-[11px] font-semibold text-brand-orange hover:text-orange-600 pt-2 text-left">
              and {total - items.length} more — see them all on the Leads tab →
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

function LeadCard({ item, level, regionLabel }: {
  item: HealthItem; level: HealthLevel; regionLabel: (r: string | null) => string;
}) {
  // Only the clocks that put it in this list; a green clock beside a red one
  // is noise on a to-do list (the Leads tab shows every clock).
  const why = item.health.reasons.filter((r) => r.level !== "on_track");
  return (
    <div className="py-2.5 border-b border-gray-50 last:border-0"
      style={{ borderLeft: `3px solid ${HEALTH[level].swatch}`, paddingLeft: 10 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-800 truncate" title={item.company}>{item.company}</p>
          <p className="text-[10px] text-gray-500 truncate">
            {[item.owner ?? "No salesperson", item.region ? regionLabel(item.region) : null,
              item.stage_no ? `Stage ${item.stage_no} · ${item.stage_name}` : "No stage"].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span className="text-xs font-bold text-gray-700 shrink-0">
          {item.potential_cr != null ? fmtCr(item.potential_cr) : <span className="text-gray-400">—</span>}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {why.map((r) => (
          <span key={r.clock} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${HEALTH[r.level].chip}`}>
            {r.text}
          </span>
        ))}
      </div>
      {item.next_action && (
        <p className="text-[10px] text-gray-600 mt-1">
          Next: <b className="text-gray-700">{item.next_action}</b>
          {item.next_action_date && <> · by {fmtDay(item.next_action_date)}</>}
        </p>
      )}
    </div>
  );
}

/** The colour rules as a table — the same numbers the server used. */
function Rules({ data }: { data: Summary }) {
  const t = data.health.thresholds;
  const [sw, sr, sc] = t.stage_days;
  const [cw, cr, cc] = t.contact_days;
  const rows = [
    { clock: "Stage not moved", watch: `${sw}+ days`, risk: `${sr}+ days`, crit: `${sc}+ days`,
      note: "From the day a sync saw the lead arrive at its stage" },
    { clock: "No contact logged", watch: `${cw}+ days`, risk: `${cr}+ days`, crit: `${cc}+ days`,
      note: "Since the newest Activity row for the company" },
    { clock: "Next action date", watch: `due within ${t.next_action_due_soon} days`,
      risk: `${t.next_action_overdue[0]}–${t.next_action_overdue[1] - 1} days overdue`,
      crit: `${t.next_action_overdue[1]}+ days overdue`, note: "Next Action Date column" },
    { clock: "Target closure", watch: `due within ${t.target_due_soon} days`,
      risk: `${t.target_past[0]}–${t.target_past[1] - 1} days past`,
      crit: `${t.target_past[1]}+ days past`, note: "Target Closure Date column" },
  ];
  const cell = (lv: HealthLevel, text: string) => (
    <td className="py-2 px-2">
      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md border ${HEALTH[lv].chip}`}>{text}</span>
    </td>
  );
  return (
    <Panel title="How a Lead Gets Its Colour"
      sub="Four clocks are checked on every open lead; the lead takes the colour of its worst clock">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
              <th className="py-2 pr-3">Clock</th>
              <th className="py-2 px-2">{HEALTH.watch.label}</th>
              <th className="py-2 px-2">{HEALTH.at_risk.label}</th>
              <th className="py-2 px-2">{HEALTH.critical.label}</th>
              <th className="py-2 pl-3 hidden md:table-cell">Measured from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.clock} className="border-b border-gray-50">
                <td className="py-2 pr-3 font-semibold text-gray-700">{r.clock}</td>
                {cell("watch", r.watch)}{cell("at_risk", r.risk)}{cell("critical", r.crit)}
                <td className="py-2 pl-3 text-[11px] text-gray-500 hidden md:table-cell">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Explain>
        <b className="text-gray-700">{HEALTH.on_track.label}</b> means a contact is logged on the Activity
        tab and every clock that can be read is inside its first line. A clock with no date is never
        counted as fine, so <b className="text-gray-700">{HEALTH.unknown.label}</b> is a lead nobody has
        logged a contact with and that has nothing overdue — it may be fine, the sheet just does not
        say. Logging contacts on the Activity tab is what turns grey into a colour. A lead
        that was already at its stage when tracking began shows its time as a minimum (&ldquo;≥&rdquo;)
        and is only coloured by it once that minimum crosses a line.{" "}
        <b className="text-gray-700">{HEALTH.parked.label}</b> leads are paused on purpose and are not
        judged. Won and Lost leads are finished and never appear here.
      </Explain>
    </Panel>
  );
}

function SplitBars({ rows, label, onPick, pickable }: {
  rows: HealthSplit[]; label: (k: HealthSplit["key"]) => string;
  onPick: (k: HealthSplit["key"]) => void; pickable: (k: HealthSplit["key"]) => boolean;
}) {
  if (!rows.length) return <p className="text-xs text-gray-500 py-3">No open leads in this selection.</p>;
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {rows.map((r) => {
        const bad = r.counts.critical + r.counts.at_risk;
        return (
          <button key={String(r.key)} onClick={() => pickable(r.key) && onPick(r.key)} disabled={!pickable(r.key)}
            className="flex items-center gap-3 text-left rounded-lg px-1 -mx-1 py-0.5 hover:bg-orange-50/60 disabled:hover:bg-transparent">
            <span className={`w-32 shrink-0 text-xs truncate ${r.key == null ? "italic text-gray-500" : "text-gray-600"}`}
              title={label(r.key)}>{label(r.key)}</span>
            <span className="flex-1" style={{ maxWidth: `${(r.leads / max) * 100}%` }}>
              <HealthBar counts={r.counts} total={r.leads} />
            </span>
            <span className="w-24 shrink-0 text-right text-[11px]">
              <b className="text-gray-800">{r.leads}</b>
              {bad > 0 && <span className="text-red-600 font-semibold"> · {bad} red/amber</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const FEED_TEXT = (f: FeedItem): string => {
  if (f.type === "activity") return `${f.activity_type ?? "Contact"}${f.notes ? ` — ${f.notes}` : ""}`;
  if (f.type === "added") return "Added to the list";
  if (f.type === "removed") return "Removed from the list";
  if (f.type === "status") return `${f.from_status ?? "No status"} → ${f.to_status ?? "no status"}`;
  return `Stage ${f.from_stage ?? "—"} → ${f.to_stage ?? "—"}`;
};

function Recent({ data }: { data: Summary }) {
  const r = data.recent;
  const m = r.movement;
  const tiles = [
    { label: "contacts logged", n: r.touches },
    { label: "moved forward", n: m.advanced },
    { label: "went back", n: m.went_back },
    { label: "won", n: m.won },
    { label: "lost", n: m.lost },
    { label: "new leads", n: m.added },
  ];
  return (
    <Panel title={`Last ${r.days} Days`} sub={`Since ${fmtDay(r.from)} — the full history is on the Activity tab`}>
      <div className="grid grid-cols-3 gap-2 mt-1">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-gray-50 px-3 py-2">
            <p className="text-lg font-black text-gray-800 leading-tight">{t.n}</p>
            <p className="text-[10px] text-gray-500">{t.label}</p>
          </div>
        ))}
      </div>
      {r.feed.length ? (
        <div className="flex flex-col mt-3">
          {r.feed.map((f, i) => (
            <p key={i} className="text-[11px] text-gray-600 py-1 border-b border-gray-50 last:border-0 truncate"
              title={FEED_TEXT(f)}>
              <b className="text-gray-700">{fmtDay(f.date)}</b> · <b className="text-gray-700">{f.company}</b> · {FEED_TEXT(f)}
            </p>
          ))}
          {r.feed_total > r.feed.length && (
            <p className="text-[10px] text-gray-500 pt-1">and {r.feed_total - r.feed.length} more on the Activity tab</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-500 mt-3">
          Nothing recorded in the last {r.days} days — no contacts logged, no stage or status changes seen.
        </p>
      )}
      <p className="text-[10px] text-gray-500 mt-2">
        Stage and status changes are dated to the sync that noticed them, not the day they happened.
      </p>
    </Panel>
  );
}

/** What stops leads being judged, as a to-do list for the export team. */
function FixTheSheet({ data }: { data: Summary }) {
  const g = data.health.gaps;
  const rows = [
    { n: g.no_owner, text: "have no salesperson", fix: "fill Owner on the Leads tab" },
    { n: g.no_activity, text: "have nothing on the Activity tab", fix: "log the last contact" },
    { n: g.no_next_action, text: "have no next action", fix: "fill Next Action and its date" },
    { n: g.no_target, text: "have no Target Closure Date", fix: "agree a date and enter it" },
    { n: g.no_potential, text: "have no potential estimate", fix: "fill Est. Potential (₹ Cr)" },
  ].filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  return (
    <Panel title="Fix the Sheet First"
      sub={`Of ${plural(g.working, "lead")} being worked (open, not on hold) — each gap hides leads from the colours above`}>
      {!rows.length ? (
        <p className="text-xs text-gray-500 py-3">Every working lead has an owner, activity, a next action, a target date and an estimate.</p>
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          {rows.map((r) => (
            <div key={r.text} className="flex items-center gap-3">
              <span className="w-10 shrink-0 text-right text-sm font-black text-gray-800">{r.n}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-700">leads {r.text}</p>
                <span className="block h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1">
                  <span className="block h-full rounded-full bg-gray-500" style={{ width: `${(r.n / g.working) * 100}%` }} />
                </span>
              </div>
              <span className="hidden sm:block w-44 shrink-0 text-[10px] text-gray-500">→ {r.fix}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
