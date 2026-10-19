// Export › Leads — the filtered list itself, with the ageing figures the
// pipeline tab summarises. A few dozen rows, so it is sorted here rather than
// paged by the server.
import { Fragment, useMemo, useState } from "react";
import { ChevronRight, ArrowUpDown } from "lucide-react";
import {
  Panel, fmtCr, fmtDay, fmtDays, BASIS_NOTE, NOT_SET, STATUS_STYLE, HEALTH, HEALTH_ORDER, HealthPill,
  type Lead, type Clock,
} from "./shared";

type SortKey = "sheet" | "health" | "company" | "owner" | "stage" | "potential" | "in_stage" | "contact" | "next";

/** The colour a single clock gave this lead, for tinting that clock's cell. */
const clockText = (l: Lead, clock: Clock) => {
  const r = l.health?.reasons.find((x) => x.clock === clock);
  return r && r.level !== "on_track" ? `font-semibold ${HEALTH[r.level].text}` : "text-gray-600";
};

/** Nulls always sort last, whichever way the column runs — a blank is not the
 *  smallest or the largest value, it is no value. */
function compare(a: number | string | null, b: number | string | null, dir: 1 | -1) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a < b ? -1 : a > b ? 1 : 0) * dir;
}

const SORT_VALUE: Record<SortKey, (l: Lead) => number | string | null> = {
  sheet: (l) => l.sheet_row,
  // Worst first; closed leads (no health) last.
  health: (l) => (l.health ? HEALTH_ORDER.indexOf(l.health.level) : null),
  company: (l) => l.company.toUpperCase(),
  owner: (l) => l.owner?.toUpperCase() ?? null,
  stage: (l) => l.stage_no,
  potential: (l) => l.potential_cr,
  in_stage: (l) => l.days_in_stage,
  contact: (l) => l.days_since_contact,
  next: (l) => (l.is_open ? l.next_action_date : null),
};

export default function LeadsTab({ leads, staleDays, regionLabel }: {
  leads: Lead[]; staleDays: number; regionLabel: (r: string | null) => string;
}) {
  const [sort, setSort] = useState<SortKey>("sheet");
  const [dir, setDir] = useState<1 | -1>(1);
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(
    () => [...leads].sort((a, b) => compare(SORT_VALUE[sort](a), SORT_VALUE[sort](b), dir)),
    [leads, sort, dir]);

  const header = (key: SortKey, label: string, className = "") => (
    <th className={`py-2 pr-3 ${className}`}>
      <button onClick={() => {
        // Figures open largest-first; names and the sheet's own order open A→Z.
        // Health opens worst-first, which is its natural (ascending) order.
        const numeric = ["potential", "in_stage", "contact", "stage"].includes(key);
        if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
        else { setSort(key); setDir(numeric ? -1 : 1); }
      }}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-brand-orange ${
          sort === key ? "text-brand-orange" : ""}`}>
        {label} <ArrowUpDown size={10} />
      </button>
    </th>
  );

  return (
    <Panel title="Leads"
      sub={<>
        {rows.length} lead{rows.length === 1 ? "" : "s"} ·
        in the sheet&rsquo;s order until you sort a column · click a row for contact details and remarks
      </>}>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500 py-6 text-center">No leads in this selection.</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
                <th className="w-5" />
                {header("health", "Health")}
                {header("company", "Company")}
                {header("owner", "Salesperson")}
                <th className="py-2 pr-3">Market</th>
                {header("stage", "Stage")}
                <th className="py-2 pr-3">Status</th>
                {header("potential", "Potential", "text-right")}
                {header("in_stage", "In stage", "text-right")}
                {header("contact", "Last contact", "text-right")}
                {header("next", "Next action")}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const expanded = open === l.company;
                return (
                  <Fragment key={l.company}>
                    <tr onClick={() => setOpen(expanded ? null : l.company)}
                      className="border-b border-gray-50 hover:bg-orange-50/40 cursor-pointer align-top">
                      <td className="py-2 pl-1"
                        style={{ boxShadow: l.health ? `inset 3px 0 0 ${HEALTH[l.health.level].swatch}` : undefined }}>
                        <ChevronRight size={12} className={`text-gray-400 mt-0.5 ml-1 transition-transform ${expanded ? "rotate-90" : ""}`} />
                      </td>
                      <td className="py-2 pr-3">
                        {l.health ? <HealthPill level={l.health.level} />
                          : <span className="text-[10px] text-gray-500" title="Won and Lost leads are finished and not judged">closed</span>}
                      </td>
                      <td className="py-2 pr-3 min-w-[160px]">
                        <p className="font-semibold text-gray-700">{l.company}</p>
                        <p className="text-[10px] text-gray-500">
                          {[l.customer_type, l.city].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </td>
                      <td className={`py-2 pr-3 ${l.owner ? "text-gray-600" : "italic text-gray-500"}`}>
                        {l.owner ?? NOT_SET}
                      </td>
                      <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">
                        {l.region ? regionLabel(l.region) : <span className="text-gray-400">—</span>}
                        {l.country && l.country !== regionLabel(l.region) && (
                          <p className="text-[10px] text-gray-500">{l.country}</p>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-600 min-w-[130px]">
                        {l.stage_no != null
                          ? <><b className="text-gray-700">{l.stage_no}</b> · {l.stage_name}</>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {l.status
                          ? <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[l.status] ?? ""}`}>{l.status}</span>
                          : <span className="text-gray-400">—</span>}
                        {l.is_open && l.target_close_date && (
                          <p className={`text-[10px] mt-1 whitespace-nowrap ${clockText(l, "target")}`}
                            title="Target Closure Date">
                            target {fmtDay(l.target_close_date)}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right text-gray-700 whitespace-nowrap">
                        {l.potential_cr != null ? fmtCr(l.potential_cr) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className={`py-2 pr-3 text-right whitespace-nowrap ${clockText(l, "stage")}`}
                        title={l.days_in_stage_basis ? BASIS_NOTE[l.days_in_stage_basis] : "Not known yet"}>
                        {l.days_in_stage != null
                          ? fmtDays(l.days_in_stage, l.days_in_stage_basis)
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap"
                        title={l.last_contact ? `${fmtDay(l.last_contact)} — newest Activity entry` : "Nothing on the Activity tab"}>
                        {l.days_since_contact != null
                          ? <span className={clockText(l, "contact")}>
                              {l.days_since_contact}d ago
                            </span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="py-2 pr-3 min-w-[180px]">
                        {l.next_action || l.next_action_date ? (
                          <>
                            <p className="text-gray-600">{l.next_action ?? "—"}</p>
                            {l.next_action_date && (
                              <p className={`text-[10px] ${l.is_open ? clockText(l, "next_action") : "text-gray-500"}`}>
                                {l.next_action_overdue ? "overdue · " : "by "}{fmtDay(l.next_action_date)}
                              </p>
                            )}
                          </>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-gray-50/60 border-b border-gray-100">
                        <td />
                        <td colSpan={10} className="py-3 pr-3">
                          {l.health && (
                            <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[11px]">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mr-1">Why this colour</span>
                              {l.health.reasons.length ? l.health.reasons.map((r) => (
                                <span key={r.clock} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${HEALTH[r.level].chip}`}>
                                  {r.text}
                                </span>
                              )) : (
                                <span className="text-gray-500">
                                  {l.health.level === "parked"
                                    ? "Status is On Hold, so it is not judged."
                                    : "Nothing to measure yet — no activity logged, no next action or target date, and no stage move seen."}
                                </span>
                              )}
                              {l.health.level === "unknown" && l.health.reasons.length > 0 && (
                                <span className="text-gray-500">
                                  · nothing is overdue, but no contact is logged, so it cannot be called on track
                                </span>
                              )}
                            </div>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-[11px]">
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Contact</p>
                              <p className="text-gray-700">{l.contact_person ?? "—"}</p>
                              {l.contact_email && <p className="text-gray-600 break-all">{l.contact_email}</p>}
                              {l.contact_phone && <p className="text-gray-600">{l.contact_phone}</p>}
                            </div>
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Dates</p>
                              <p className="text-gray-600">Last contact: <b className="text-gray-700">{fmtDay(l.last_contact)}</b></p>
                              <p className="text-gray-600">
                                Target closure: <b className={l.past_target ? "text-amber-600" : "text-gray-700"}>{fmtDay(l.target_close_date)}</b>
                                {l.past_target && <span className="text-amber-600"> · passed</span>}
                              </p>
                              {!l.is_open && (
                                <p className="text-gray-600"
                                  title={l.closed_on ? "The day a sync saw the status change" : "Closed before tracking began, so the day is not known"}>
                                  {l.status}: <b className="text-gray-700">{fmtDay(l.closed_on)}</b>
                                </p>
                              )}
                              {l.status === "Lost" && (
                                <p className="text-gray-600">Reason: <b className="text-gray-700">{l.lost_reason ?? "—"}</b></p>
                              )}
                              <p className="text-gray-600">Source: <b className="text-gray-700">{l.source ?? "—"}</b></p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Recent activity</p>
                              {l.recent_activity.length ? l.recent_activity.map((a, i) => (
                                <p key={i} className="text-gray-600">
                                  <b className="text-gray-700">{fmtDay(a.date)}</b> · {a.activity_type ?? "—"}
                                  {a.by_person && <> · {a.by_person}</>}
                                  {a.notes && <span className="block text-[10px] text-gray-500">{a.notes}</span>}
                                </p>
                              )) : <p className="text-gray-500">Nothing on the Activity tab</p>}
                            </div>
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Remarks</p>
                              <p className="text-gray-600 whitespace-pre-wrap">{l.remarks ?? "—"}</p>
                              <p className="text-[10px] text-gray-500 mt-1">Row {l.sheet_row} of the Leads sheet</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-gray-500 mt-3">
        <b className="text-gray-600">Health</b> is the worst of four clocks — time at stage, time since
        contact, next action date and target closure — and each of those cells is tinted with the colour
        its own clock gave; the rules are on the Highlights tab. Sort by Health to see the worst first.{" "}
        <b className="text-gray-600">In stage</b> counts days from when a sync saw the lead move into
        its stage; &ldquo;≥&rdquo; means it was already there when tracking began, so the real figure
        is longer. <b className="text-gray-600">Last contact</b> is the newest entry on the Activity tab
        (the Pipeline tab&rsquo;s &ldquo;gone quiet&rdquo; list uses its own {staleDays}-day setting).
        A dash means the sheet leaves that cell blank — it is not a zero.
      </p>
    </Panel>
  );
}
