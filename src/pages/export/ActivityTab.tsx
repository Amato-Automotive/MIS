// Export › Activity — what happened in a period: contacts the team logged,
// stage moves the sync recorded, and leads won or lost.
//
// The one time-scoped tab in the module. Pipeline and Leads describe the list
// as it stands; this describes change, and change needs a window.
//
// Two limits it states on the page rather than hiding:
//   • A stage move is dated to the sync that saw it. Leads that move twice
//     between syncs show only the net move.
//   • History begins at the first sync after it shipped. Before that the only
//     dated things are the Activity tab and the team's own Closed Dates.
import { MessageSquare, Users, TrendingUp, TrendingDown, Trophy, XCircle } from "lucide-react";
import Explain from "../oe-network/dealers/Explain";
import {
  StatCard, KPI, CALL_COLOR, Panel, fmtCr, fmtDay, plural, NOT_SET,
  type ActivityResponse, type FeedItem,
} from "./shared";

export default function ActivityTab({ data, windowLabel, onAllTime, isAllTime }: {
  data: ActivityResponse; windowLabel: string; onAllTime: () => void; isAllTime: boolean;
}) {
  const m = data.movement;
  const a = data.activity;
  const nothing = a.touches === 0 && data.feed.length === 0 && data.closes.length === 0;

  const tracking = (
    <Explain>
      <b className="text-gray-700">Contacts</b> are rows on the Activity tab, dated by the team.{" "}
      <b className="text-gray-700">Moves</b> are recorded by the MIS each time the sheet syncs, by
      comparing it with the previous sync — so a move is dated to the sync that saw it, and a lead
      that moved twice in between shows only where it ended up.{" "}
      {data.tracking_since
        ? <>Moves have been recorded since <b className="text-gray-700">{fmtDay(data.tracking_since)}</b>; nothing
            before then can show a move.</>
        : <>No sync has recorded moves yet — they start with the next one.</>}{" "}
      <b className="text-gray-700">Won / Lost</b> use the Closed Date on the Leads tab, or the day a
      sync saw the status change when that is blank.
      {data.lead_filtered && <> With a lead filter on, removed leads and activity logged against a
        company not on the Leads tab cannot be matched and are left out.</>}
    </Explain>
  );

  if (nothing) {
    return (
      <div className="flex flex-col gap-4">
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
          <p className="font-semibold text-gray-600 mb-1.5">Nothing recorded for {windowLabel}</p>
          {isAllTime ? (
            <p>No contacts have been logged and no moves recorded yet. Contacts appear once the team
              adds rows to the Activity tab; moves, once the sheet has been synced after a lead changes.</p>
          ) : (
            <p>No contacts, moves or closes fall in this period.{" "}
              <button onClick={onAllTime}
                className="font-semibold text-brand-orange hover:text-orange-600 underline underline-offset-2">
                Show all time
              </button>{" "}to see everything recorded so far.</p>
          )}
        </div>
        {tracking}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Contacts Logged" value={a.touches}
          sub={`with ${plural(a.companies, "company", "companies")}`}
          icon={<MessageSquare size={18} />} {...KPI.activity} />
        <StatCard label="Open Leads Contacted" value={`${a.open_touched} of ${a.open_leads}`}
          sub={a.open_leads ? `${Math.round((a.open_touched / a.open_leads) * 100)}% had a contact` : undefined}
          icon={<Users size={18} />} {...KPI.activity} />
        <StatCard label="Moved Forward" value={m.advanced}
          sub={m.added ? `+ ${plural(m.added, "new lead")}` : "to a later stage"}
          icon={<TrendingUp size={18} />} {...KPI.conversion} />
        <StatCard label="Went Back" value={m.went_back} sub="to an earlier stage"
          icon={<TrendingDown size={18} />} {...KPI.warning} />
        <StatCard label="Won" value={m.won}
          sub={wonValue(data)} icon={<Trophy size={18} />} {...KPI.conversion} />
        <StatCard label="Lost" value={m.lost}
          sub={m.on_hold ? `${m.on_hold} put on hold` : undefined}
          icon={<XCircle size={18} />} {...KPI.neutral} />
      </div>

      {tracking}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Stage Flow" sub={`Leads arriving at and leaving each stage in ${windowLabel}`}>
          <StageFlow rows={data.stage_flow} />
        </Panel>
        <Panel title="Won & Lost" sub={`Leads that closed in ${windowLabel}, newest first`}>
          {data.closes.length === 0 ? (
            <p className="text-xs text-gray-500 py-3">No lead was won or lost in this period.</p>
          ) : (
            <div className="flex flex-col">
              {data.closes.map((c) => (
                <div key={c.company} className="flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-700 truncate">{c.company}</p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {[fmtDay(c.closed_on), c.owner ?? "No salesperson",
                        c.status === "Lost" ? (c.lost_reason ?? "no reason given") : null]
                        .filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <span className={`text-xs font-bold shrink-0 ${c.status === "Won" ? "text-green-700" : "text-gray-500"}`}>
                    {c.status}{c.status === "Won" && c.potential_cr != null ? ` · ${fmtCr(c.potential_cr)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Contacts by Type">
          <CountBars rows={a.by_type} empty="No contacts logged in this period." />
        </Panel>
        <Panel title="Contacts by Person" sub="The Activity tab's By column — who made the contact">
          <CountBars rows={a.by_person} empty="No contacts logged in this period." />
        </Panel>
      </div>

      <Panel title="Timeline"
        sub={`Everything recorded in ${windowLabel}, newest first${data.feed_total > data.feed.length ? ` — latest ${data.feed.length} of ${data.feed_total}` : ""}`}>
        <div className="flex flex-col mt-1">
          {data.feed.map((f, i) => <FeedRow key={i} f={f} />)}
        </div>
        {a.unmatched > 0 && (
          <p className="text-[10px] text-gray-500 mt-2">
            {plural(a.unmatched, "contact was", "contacts were")} logged against a company that is not
            on the Leads tab (marked &ldquo;not a lead&rdquo;). They are counted above but cannot set any
            lead&rsquo;s Last Contact.
          </p>
        )}
      </Panel>
    </div>
  );
}

function wonValue(d: ActivityResponse) {
  const won = d.closes.filter((c) => c.status === "Won");
  const vals = won.map((c) => c.potential_cr).filter((v): v is number => v != null);
  if (!won.length) return undefined;
  if (!vals.length) return "no estimates";
  return `${fmtCr(vals.reduce((s, v) => s + v, 0))} · ${vals.length} of ${won.length} estimated`;
}

function StageFlow({ rows }: { rows: ActivityResponse["stage_flow"] }) {
  const active = rows.filter((r) => r.entered || r.moved_on || r.went_back);
  if (!active.length) return <p className="text-xs text-gray-500 py-3">No stage moves recorded in this period.</p>;
  return (
    <>
      <table className="w-full text-xs mt-1">
        <thead>
          <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-gray-100">
            <th className="py-2 pr-3">Stage</th>
            <th className="py-2 pr-3 text-right">Arrived</th>
            <th className="py-2 pr-3 text-right">Moved on</th>
            <th className="py-2 text-right">Went back</th>
          </tr>
        </thead>
        <tbody>
          {active.map((r) => (
            <tr key={r.stage} className="border-b border-gray-50">
              <td className="py-1.5 pr-3 text-gray-600"><b className="text-gray-700">{r.stage}</b> · {r.name}</td>
              <td className="py-1.5 pr-3 text-right text-gray-700">{r.entered || <span className="text-gray-400">—</span>}</td>
              <td className="py-1.5 pr-3 text-right text-green-700 font-semibold">{r.moved_on || <span className="text-gray-400 font-normal">—</span>}</td>
              <td className="py-1.5 text-right text-amber-600 font-semibold">{r.went_back || <span className="text-gray-400 font-normal">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-500 mt-2">
        A lead that jumps from 2 to 5 counts as one arrival at 5 and one move on from 2 — the stages it
        skipped are not credited. Only stages with a move are listed.
      </p>
    </>
  );
}

function CountBars({ rows, empty }: { rows: { key: string | null; count: number }[]; empty: string }) {
  if (!rows.length) return <p className="text-xs text-gray-500 py-3">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {rows.map((r) => (
        <div key={r.key ?? "__none"} className="flex items-center gap-3">
          <span className={`w-32 shrink-0 text-xs truncate ${r.key == null ? "italic text-gray-500" : "text-gray-600"}`}>
            {r.key ?? NOT_SET}
          </span>
          <span className="relative flex-1 h-3.5 rounded-md overflow-hidden" style={{ background: "#f9fafb" }}>
            <span className="absolute inset-y-0 left-0 rounded-md"
              style={{ width: `${(r.count / max) * 100}%`, background: CALL_COLOR }} />
          </span>
          <span className="w-10 shrink-0 text-right text-xs font-semibold text-gray-700">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

const stageLabel = (n: number | null | undefined) => (n == null ? "no stage" : `stage ${n}`);

function FeedRow({ f }: { f: FeedItem }) {
  let what: React.ReactNode;
  let tone = "text-gray-600";
  if (f.type === "activity") {
    what = <>{f.activity_type ?? "Contact"}{f.by_person && <> by {f.by_person}</>}
      {f.matched === false && <span className="ml-1 text-[10px] text-gray-500">(not a lead)</span>}</>;
    tone = "text-blue-600";
  } else if (f.type === "stage") {
    const fwd = f.from_stage != null && f.to_stage != null && f.to_stage > f.from_stage;
    const back = f.from_stage != null && f.to_stage != null && f.to_stage < f.from_stage;
    what = <>{stageLabel(f.from_stage)} → {stageLabel(f.to_stage)}</>;
    tone = fwd ? "text-green-700" : back ? "text-amber-600" : "text-gray-600";
  } else if (f.type === "status") {
    what = <>{f.from_status ?? "no status"} → {f.to_status ?? "no status"}</>;
    tone = f.to_status === "Won" ? "text-green-700" : "text-gray-600";
  } else if (f.type === "added") {
    what = <>added to the list{f.to_stage != null && <> at {stageLabel(f.to_stage)}</>}</>;
  } else {
    what = <>removed from the list</>;
  }
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0 text-xs">
      <span className="w-16 shrink-0 text-gray-500">{fmtDay(f.date)}</span>
      <span className="w-44 shrink-0 font-semibold text-gray-700 truncate" title={f.company}>{f.company}</span>
      <span className="flex-1 min-w-0">
        <span className={`font-semibold ${tone}`}>{what}</span>
        {f.notes && <span className="block text-[11px] text-gray-500">{f.notes}</span>}
      </span>
    </div>
  );
}
