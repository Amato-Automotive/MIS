// Shared primitives for the OE Network page — the palette, the period-selection
// plumbing and the small building blocks every tab uses. Extracted from
// OENetworkPage.tsx so the dealer half of the module can live in its own files
// (see ./dealers) without duplicating any of this.
import React, { useState, useEffect, useMemo } from "react";
import { Footprints, Phone, UserRound } from "lucide-react";
import Select, { type SelectOption } from "@/components/ui/Select";
import DateRangePicker, { dayPresets } from "@/components/ui/DateRangePicker";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Series colors follow the entity everywhere on this page: field visits are
// orange, phone calls are blue (same palette as the rest of the app).
// VISIT_COLOR is the same hex as Tailwind's `brand-orange` token — text and
// borders should use the `brand-orange` classes, never `orange-500`, which is a
// visibly different orange (#f97316).
export const VISIT_COLOR = "#f46617";
export const CALL_COLOR = "#3b82f6";
// On the bullet charts the grey track is the goal (planned visits / the target).
export const TGT_TRACK = "#e5e7eb";
// A grey that is actually VISIBLE as a filled series. TGT_TRACK is a background
// track and is nearly invisible when used as a bar on a white card next to a
// #f3f4f6 grid, so anything carrying data uses this instead.
export const NEUTRAL_BAR = "#c2c8d0";
// The funnel bar stacks three bands directly on top of each other, so its two
// non-orange bands need to separate from EACH OTHER, not just from the card.
// NEUTRAL_BAR (#c2c8d0) over TGT_TRACK (#e5e7eb) is two steps on one ramp and
// reads as a single grey block. This is the darker "we could have won it" band;
// the pale TGT_TRACK stays on top for "no part number exists".
export const FUNNEL_MISSED = "#8b95a5";
// Chart labels must never inherit their series colour — recharts draws legend
// and tooltip text in the series colour by default, which makes any pale series
// unreadable. Text stays dark; the colour swatch does the identifying.
export const CHART_LABEL = "#4b5563";
export const OVER_COLOR = "#22c55e";
// Targets that belong to no salesperson (MSIL/TATA accessories) get a colour of
// their own on the bullet charts — they sit in the same total as the people bars
// but are not a person, and must never be read as one.
export const UNOWNED_COLOR = "#8b5cf6";
// A quarter from 90% of target up counts as on-track for the business, so the
// target bars turn green there rather than at a literal 100%.
export const ON_TRACK_PCT = 90;

/** Product lines, in the OE team's own codes. One label per concept, module-wide:
 *  the Targets tab reads these off its block titles ("TATA MAT (AMJ'26)") and the
 *  Dealers tab off its dealer file's columns ("TGT FOR JAS'26 MAT"), and they must
 *  never end up saying "Mats" on one tab and "MAT" on the next.
 *  An unknown code is shown AS TYPED rather than hidden behind a guess. */
export const CATEGORY_LABELS: Record<string, string> = {
  SC: "Seat Covers", MAT: "Mats", ACC: "Accessories",
  // The OEM target sheet buckets a couple more product lines than the
  // quarterly one does. They live in the SAME map, not a second one, or the
  // module ends up with two names for one thing again.
  STEERING: "Steering Covers", OTHER: "Other Products",
};
export const categoryLabel = (c: string | null | undefined) =>
  (c && (CATEGORY_LABELS[c] ?? c)) || "\u2014";

export interface Period { year: number; month: number }
export type PeriodMode = "monthly" | "quarterly" | "yearly";

export function monthToken(p: Period) { return `${p.year}-${p.month}`; }
export function tokenLabel(t: string) {
  const [y, m] = t.split("-").map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// Indian FY (Apr–Mar), same convention as the Sales module: Q1 = Apr–Jun and
// "FY26-27" starts April 2026.
export function fyOf(year: number, month: number) { return month >= 4 ? year : year - 1; }
export function fqOf(month: number) { return month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4; }
export function quarterToken(fy: number, q: number) { return `${fy}-Q${q}`; }
export function quarterLabel(t: string) {
  const [fyStr, qStr] = t.split("-Q");
  // Spelled out as the full financial year, not "FY27". One workbook per FY
  // made the short form look harmless; with two registered the picker offered
  // "Q1 FY27" beside "Q1 FY28" while the yearly picker said "FY26-27", so the
  // same three months had two names and neither said which year it started in.
  return `Q${qStr} ${fyLabel(Number(fyStr))}`;
}
export function fyLabel(fy: number) { return `FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`; }
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Expands a selected period token into the inclusive YYYY-MM range the API takes. */
export function periodRange(mode: PeriodMode, token: string): [string, string] {
  if (mode === "monthly") {
    const [y, m] = token.split("-").map(Number);
    return [`${y}-${pad2(m)}`, `${y}-${pad2(m)}`];
  }
  if (mode === "quarterly") {
    const [fyStr, qStr] = token.split("-Q");
    const fy = Number(fyStr), q = Number(qStr);
    if (q === 4) return [`${fy + 1}-01`, `${fy + 1}-03`];
    const start = 4 + (q - 1) * 3;
    return [`${fy}-${pad2(start)}`, `${fy}-${pad2(start + 2)}`];
  }
  const fy = Number(token);
  return [`${fy}-04`, `${fy + 1}-03`];
}

/**
 * Period selection, shared by every tab so the behaviour can't drift between
 * them. The three preset modes send a month range; "custom" sends exact dates.
 *
 * What the two produce is genuinely different, not just finer:
 *   • from_date/to_date cut the LOG BOOK to the day, because a visit has a date.
 *   • Visit plans and dealer sales have no day on them — they are one row per
 *     month — so on those the range widens to the months it touches. The
 *     endpoints that compare logs against plans widen BOTH sides rather than
 *     cutting one finer than the other, which would deflate every coverage
 *     percentage. Each tab says which happened.
 */
export type PeriodChoice = PeriodMode | "custom" | "all";
export interface DateRange { from: string; to: string }

// Indian FY quarters, as the target sheets publish them.
export const QUARTER_MONTHS: Record<number, number[]> = {
  1: [4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12], 4: [1, 2, 3],
};

const PERIOD_CHOICES: PeriodChoice[] = ["monthly", "quarterly", "yearly", "custom", "all"];
const PERIOD_LABELS: Record<PeriodChoice, string> = {
  monthly: "monthly", quarterly: "quarterly", yearly: "yearly",
  custom: "custom", all: "all time",
};

export function PeriodControls({ mode, onMode, token, onToken, options, range, onRange }: {
  mode: PeriodChoice; onMode: (m: PeriodChoice) => void;
  token: string; onToken: (t: string) => void;
  options: SelectOption[];
  range: DateRange; onRange: (r: DateRange) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
        {PERIOD_CHOICES.map((m) => (
          <button key={m} onClick={() => onMode(m)}
            className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg capitalize transition-all ${
              mode === m ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            {PERIOD_LABELS[m]}
          </button>
        ))}
      </div>
      {mode === "all" ? null : mode === "custom" ? (
        <DateRangePicker value={range} onChange={onRange} presets={dayPresets()}
          placeholder="Pick dates" />
      ) : (
        <Select value={token} onChange={onToken} options={options} placeholder="Period…" />
      )}
    </>
  );
}

/** Query params for a period selection, or null when it isn't usable yet —
 *  a half-entered custom range must not fire a request for "everything". */
export function periodParams(mode: PeriodChoice, token: string, range: DateRange):
  Record<string, string> | null {
  if (mode === "all") return {};        // no period params at all = every month
  if (mode === "custom") {
    if (!range.from || !range.to) return null;
    return { from_date: range.from, to_date: range.to };
  }
  if (!token) return null;
  const [fromYm, toYm] = periodRange(mode, token);
  return { from_ym: fromYm, to_ym: toYm };
}

/**
 * The selected period as inclusive `YYYY-MM` bounds, or null when there is no
 * month window to apply — either "all time" or a custom range still being
 * typed. Both mean "don't filter", which is why they share a return value.
 *
 * Used to cut month-grain data client-side (a trend already fetched whole)
 * without a second request. A day range widens to the months it touches, the
 * same rule the backend applies.
 */
export function periodMonthBounds(mode: PeriodChoice, token: string, range: DateRange):
  [string, string] | null {
  const pp = periodParams(mode, token, range);
  if (!pp) return null;
  if (pp.from_ym && pp.to_ym) return [pp.from_ym, pp.to_ym];
  if (pp.from_date && pp.to_date) return [pp.from_date.slice(0, 7), pp.to_date.slice(0, 7)];
  return null;
}

/** Is `YYYY-M` (or a year/month pair) inside the bounds? Zero-pads first, so
 *  "2026-8" compares correctly against "2026-08". */
export function monthInBounds(year: number, month: number, bounds: [string, string] | null) {
  if (!bounds) return true;
  const ym = `${year}-${pad2(month)}`;
  return ym >= bounds[0] && ym <= bounds[1];
}

/** Period option lists derived from the months that actually hold data, so
 *  future months make new options appear on their own. */
export function buildPeriodOptions(months: Period[]): Record<PeriodMode, SelectOption[]> {
  // Deduped here rather than by each caller: a tab whose months come from two
  // sheets (the Overview unions plan months with log months) would otherwise
  // offer the same month twice in the picker.
  const uniq = new Map<string, Period>();
  months.forEach((p) => uniq.set(monthToken(p), p));
  const sorted = [...uniq.values()].sort((a, b) => b.year - a.year || b.month - a.month);
  const quarters = new Set<string>();
  const fys = new Set<number>();
  sorted.forEach((p) => {
    const fy = fyOf(p.year, p.month);
    quarters.add(quarterToken(fy, fqOf(p.month)));
    fys.add(fy);
  });
  // Headed by financial year once a second year's sheet is registered. Twelve
  // months is a list; twenty-four is a wall, and the FY boundary is invisible
  // in it — April 2027 and March 2027 sit next to each other and belong to
  // different years. A single FY gets no heading: one heading over every row
  // says nothing and costs a line.
  //
  // The month labels keep their year ("April 2026") rather than shortening to
  // "April" under the heading, because Jan–Mar of FY26-27 are calendar 2027
  // and a bare month name under "FY26-27" would read as the wrong year.
  const headed = fys.size > 1;
  const monthly = sorted.map((p) => ({
    value: monthToken(p),
    label: tokenLabel(monthToken(p)),
    ...(headed ? { group: fyLabel(fyOf(p.year, p.month)) } : {}),
  }));
  const quarterly = [...quarters].sort((a, b) => {
    const [fa, qa] = a.split("-Q").map(Number);
    const [fb, qb] = b.split("-Q").map(Number);
    return fb - fa || qb - qa;
  }).map((t) => ({ value: t, label: quarterLabel(t) }));
  const yearly = [...fys].sort((a, b) => b - a).map((fy) => ({ value: String(fy), label: fyLabel(fy) }));
  return { monthly, quarterly, yearly };
}

/**
 * The option to select in `to` mode so the user keeps looking at the same
 * window, or the newest option when nothing carries over.
 *
 * Pure, and separate from usePeriod, because this is the bit that is easy to
 * get quietly wrong — an off-by-one here does not crash, it just shows a
 * different period than the one the user was reading.
 *
 * Everything is compared as month ranges so one rule covers every direction,
 * coarse to fine and back. `opts` is newest-first, so this lands on the newest
 * period overlapping the old one: August gives Q2, not Q1.
 */
export function carryPeriod(
  from: PeriodChoice, token: string, to: PeriodMode, opts: SelectOption[],
): SelectOption | null {
  if (!opts.length) return null;
  // "custom" and "all" have no token to carry, so they fall through to newest.
  const win = from === "custom" || from === "all" || !token
    ? null : periodRange(from, token);
  const kept = win && opts.find((o) => {
    const [f, t] = periodRange(to, o.value);
    return f <= win[1] && t >= win[0];
  });
  return kept ?? opts[0];
}

/**
 * The period state machine every tab was copy-pasting: mode, selected token,
 * custom range, and the option lists derived from whichever months hold data.
 * The MONTHS stay owned by the caller (via setMonths) because each tab has its
 * own rule for where they come from and when they may shrink.
 */
export function usePeriod(initialMode: PeriodChoice = "monthly") {
  const [mode, setMode] = useState<PeriodChoice>(initialMode);
  const [token, setToken] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [months, setMonths] = useState<Period[]>([]);

  const optionsByMode = useMemo(() => buildPeriodOptions(months), [months]);
  const options = mode === "custom" || mode === "all" ? [] : optionsByMode[mode];
  // Switching views KEEPS THE WINDOW the user is looking at, falling back to
  // the latest period only when there is nothing to carry over.
  //
  // This is what makes a long month list usable. Narrowing from the year is
  // the natural way to reach an old month — FY26-27 → Q3 → December — and it
  // only works if the coarse choice carries down; landing on the newest month
  // of the newest year every time turns two years of months into one flat
  // scroll. It also means the dropdown OPENS at the right place, because the
  // list scrolls to the selected item.
  const switchMode = (m: PeriodChoice) => {
    setMode(m);
    if (m === "custom" || m === "all") return;   // neither needs a token
    const next = carryPeriod(mode, token, m, optionsByMode[m]);
    if (next) setToken(next.value);              // null = no data yet
  };
  return { mode, token, setToken, range, setRange, months, setMonths, options, switchMode };
}

// The filter bar, its action buttons and the canonical filter vocabulary are
// app-wide (see CLAUDE.md § "Filters and selectors"), not OE-Network-specific.
// Re-exported here only so this module's tabs keep one import.
export {
  FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, SyncButton,
  FILTER_LABELS, toOpts, filterOpts,
} from "@/components/ui/FilterBar";

/** The signed-in user's OE row-level scope.
 *
 *  `scoped` users are field reps: every /oe-network response is already limited
 *  to them by the server, so the UI's job is only to stop showing controls that
 *  can no longer do anything — the salesperson picker (one option), the sheet
 *  registry (403) — and to say whose numbers are on screen. Never a substitute
 *  for the server check: this reads a cached user record and is advisory only.
 *
 *  Superadmin is never scoped, matching _scope() in routers/oe_network.py.
 */
export function useOEScope(): { scoped: boolean; salesperson: string | null } {
  const { user } = useAuth();
  const salesperson =
    !user || user.role === "superadmin" ? null : user.oe_salesperson ?? null;
  return { scoped: !!salesperson, salesperson };
}

/** Says whose data the panels below are showing.
 *
 *  Not decoration. A rep who sees 9 visits where the team did 140 has no way to
 *  tell a scope from a broken filter, and "the numbers are wrong" is the support
 *  call that follows. Grey, not amber: being scoped is normal, not a warning.
 */
export function ScopeNote({ salesperson, children }: {
  salesperson: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="no-print flex items-start gap-2 rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
      <UserRound size={13} className="text-gray-400 mt-0.5 shrink-0" />
      <p className="text-[11px] leading-relaxed text-gray-500">
        Showing <span className="font-semibold text-gray-700">your data only</span>
        {" — "}<span className="font-semibold text-gray-700">{salesperson}</span>.
        {children ? <> {children}</> : null}
      </p>
    </div>
  );
}

/** Fetches /filter-options for a scope once, aborting if the caller unmounts. */
export function useFilterOptions<T>(scope: string, headers: Record<string, string>): T | null {
  const [options, setOptions] = useState<T | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/filter-options?scope=${scope}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setOptions(await res.json());
      } catch { /* aborted, or network error — the options simply stay empty */ }
    })();
    return () => ctrl.abort();
  }, [scope, headers]);
  return options;
}

export function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Axis-tick version of a salesperson name: first real name word, skipping initials. */
export function firstName(n: string) {
  return n.split(/\s+/).find((t) => t.length >= 3) ?? n;
}

export function coverageColor(pct: number | null) {
  if (pct === null) return "text-gray-500";
  if (pct >= 80) return "text-green-600";
  if (pct >= 50) return "text-amber-600";
  return "text-red-500";
}

export function ModeBadge({ mode }: { mode: string | null }) {
  if (!mode) return <span className="text-gray-400">—</span>;
  const isVisit = mode === "Visit";
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
      style={isVisit
        ? { color: VISIT_COLOR, background: "#fff4ed" }
        : { color: CALL_COLOR, background: "#eff6ff" }}
    >
      {isVisit ? <Footprints size={10} /> : <Phone size={10} />}
      {mode}
    </span>
  );
}

/**
 * One colour identity per IDEA, for every StatCard in the module.
 *
 * Before this, each tab hard-coded its own hex and they disagreed: "dealerships
 * reached" was sky #0ea5e9 on three tabs and blue #3b82f6 on Dealers; green was
 * #22c55e on some cards and #16a34a on others; neutral grey came with two
 * different backgrounds. Spread these (`{...KPI.reach}`) instead of writing a
 * hex, and a concept can only ever have one colour.
 */
export const KPI = {
  /** Our own sales / what we achieved — the same orange as the funnel band. */
  ours:       { color: VISIT_COLOR, bg: "#fff4ed" },
  /** Field visits. */
  visits:     { color: VISIT_COLOR, bg: "#fff4ed" },
  /** Phone calls — the app-wide "call" blue. */
  calls:      { color: CALL_COLOR,  bg: "#eff6ff" },
  /** Contacts / coverage / anything counting activity. */
  activity:   { color: CALL_COLOR,  bg: "#eff6ff" },
  /** A ratio of winning: penetration, achievement, hit rate. */
  conversion: { color: "#16a34a",   bg: "#f0fdf4" },
  /** A goal someone set — target, plan. Never a person. */
  target:     { color: UNOWNED_COLOR, bg: "#f5f3ff" },
  /** Dealerships / outlets reached. */
  reach:      { color: "#0ea5e9",   bg: "#f0f9ff" },
  /** Context figures that are neither good nor bad. */
  neutral:    { color: "#6b7280",   bg: "#f3f4f6" },
  /** Needs attention but isn't yet a failure. */
  warning:    { color: "#d97706",   bg: "#fffbeb" },
  /** Missed, stale, overdue. */
  danger:     { color: "#dc2626",   bg: "#fef2f2" },
} as const;

export function StatCard({ label, value, sub, icon, color, bg }: {
  label: string; value: string | number; sub?: string;
  icon: React.ReactNode; color: string; bg: string;
}) {
  return (
    // p-4, not the p-5 panels use: a stat tile is a denser class of card, and
    // the two-tier spacing is deliberate. Panels p-5, tiles p-4.
    <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        {/* The LABEL wraps, it does not truncate. It is the name of the metric,
            and a clipped name is unreadable in a way a clipped explanation is
            not — "AVAILABLE PART NUMBER %" cut to "AVAILABLE PART N…" tells the
            reader nothing about which of two similar figures they are looking
            at. Two lines is the cap; grid rows stretch, so a wrapped label
            simply makes the whole row taller and the tiles stay aligned.
            The SUB line still truncates — it is supplementary, and the title
            keeps the full text reachable on both. */}
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 leading-tight line-clamp-2"
          title={label}>{label}</p>
        <p className="text-xl font-black text-gray-800 leading-tight mt-0.5">{value}</p>
        {sub && <p className="text-[10px] text-gray-500 truncate" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

/**
 * Bar widths on the bullet charts stop short of the full track so the value
 * printed at the bar's tip always has somewhere to go. Labels sit outside the
 * bar in the bar's own colour rather than reversed out in white inside it —
 * a white label only stays readable while it's over the fill, and the moment a
 * bar falls short of its target the tail of the number lands on the grey track
 * and disappears.
 *
 * The gutter is reserved in PIXELS, not percent: a label is a fixed width no
 * matter how wide the card is, so a percentage reserve would quietly stop being
 * enough on a laptop even though it looked fine on a monitor.
 */
export const LABEL_RESERVE = 54;
export const barWidth = (n: number, max: number) =>
  `calc(${Math.min(n / max, 1).toFixed(4)} * (100% - ${LABEL_RESERVE}px))`;

/** Achievement percentage, coloured. Null is grey, never red — an absent
 *  figure is not a bad one. */
export function achColor(pct: number | null) {
  if (pct == null) return "text-gray-500";
  if (pct >= ON_TRACK_PCT) return "text-green-600";
  if (pct >= 80) return "text-amber-600";
  return "text-red-500";
}

/** One row of a target-vs-achievement bullet chart. */
export interface BulletDatum {
  key: string;
  sub?: string | null;
  tgt: number;
  /** null means NOT PUBLISHED — no bar and no percentage, never a zero-length
   *  bar, which reads as a measured miss. */
  ach: number | null;
  pct: number | null;
  /** A line that belongs to no person (the MSIL/TATA accessory rows). Drawn
   *  below a dashed rule in its own colour so it can never be read as one. */
  unowned?: boolean;
}

/**
 * Target vs achievement, as bullet rows — the module's one idiom for "how far
 * along a goal is", shared by the salesperson Targets tab and the OEM Targets
 * tab so the two cannot drift apart. Grey track = target, fill = achieved
 * (green once past the tick), one shared scale down the whole chart.
 */
export function BulletChart({ rows, fmt, empty, legendExtra }: {
  rows: BulletDatum[];
  fmt: (n: number) => string;
  empty?: string;
  legendExtra?: React.ReactNode;
}) {
  // One scale across every row, including any unowned one, so its bar is
  // honestly comparable to those above it.
  const max = Math.max(1, ...rows.map((r) => Math.max(r.tgt, r.ach ?? 0)));
  const w = (n: number) => barWidth(n, max);

  if (!rows.length) {
    return (
      <p className="text-xs text-gray-500 py-6 text-center">
        {empty ?? "Nothing to show for these filters"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 pt-1">
      {rows.map((r) => {
        // Colour says "on track" (90%+); the notch is a separate question —
        // it only exists once the bar has actually run past the target.
        const onTrack = r.pct != null && r.pct >= ON_TRACK_PCT;
        const over = r.ach != null && r.ach > r.tgt && r.tgt > 0;
        const fill = r.unowned ? UNOWNED_COLOR : onTrack ? OVER_COLOR : VISIT_COLOR;
        return (
          <div key={r.key}
            className={`flex items-center gap-3${r.unowned ? " pt-3 mt-0.5 border-t border-dashed border-gray-200" : ""}`}>
            <div className="w-[118px] shrink-0 min-w-0">
              <p className={`text-xs font-semibold truncate ${r.unowned ? "italic text-violet-600" : "text-gray-700"}`}
                title={r.key}>{r.key}</p>
              {r.sub && <p className="text-[9px] text-gray-500 truncate" title={r.sub}>{r.sub}</p>}
            </div>

            <div className="relative h-5 flex-1 min-w-0">
              {/* The track IS the target — where it ends is the goal, so no
                  separate marker is needed while the bar falls short of it. */}
              {r.tgt > 0 && (
                <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.tgt), background: TGT_TRACK }} />
              )}
              {r.ach != null && (
                <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.ach), background: fill }} />
              )}
              {/* Overshot the target: the bar has swallowed the track, so notch
                  the goal back on top of it. */}
              {over && (
                <div className="absolute inset-y-0 w-[2px]" style={{ left: w(r.tgt), background: "rgba(255,255,255,0.9)" }} />
              )}
              <span className="absolute top-1/2 -translate-y-1/2 text-[9px] font-bold leading-none whitespace-nowrap"
                style={{ left: `calc(${w(r.ach ?? 0)} + 5px)`, color: r.ach == null ? "#9ca3af" : fill }}>
                {r.ach == null ? "—" : fmt(r.ach)}
              </span>
            </div>

            <div className="w-[78px] shrink-0 text-right">
              <p className={`text-sm font-black leading-none ${achColor(r.pct)}`}>
                {r.pct != null ? `${r.pct}%` : "—"}
              </p>
              {/* The target is half the comparison, so it is dark like the
                  planned figure on the Plan vs Actual bullets — not a caption. */}
              <p className="text-[10px] font-semibold text-gray-700 mt-0.5">of {fmt(r.tgt)}</p>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-4 flex-wrap pt-1">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: OVER_COLOR }} />
          On track — {ON_TRACK_PCT}% of target or better
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} />
          Behind — under {ON_TRACK_PCT}%
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          {/* Outlined for the same reason as the Planned swatch — a bare
              TGT_TRACK square is all but invisible on a white card. */}
          <span className="w-2.5 h-2.5 rounded-sm"
            style={{ background: TGT_TRACK, border: "1px solid #b6bcc6" }} /> Target
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-[2px] h-3 bg-gray-400 rounded" /> Target mark, once beaten
        </span>
        {legendExtra}
      </div>
    </div>
  );
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/** One sheet's outcome from /sync-latest. Three of the four statuses are not
 *  failures: "Done" pulled rows, "Already syncing" means another run holds the
 *  sheet, "Up to date" means it was pulled inside the cooldown window. */
export interface SyncOutcome {
  label: string;
  status: "Done" | "Already syncing" | "Up to date" | "Failed";
  rows_inserted: number;
  error?: string | null;
  last_synced_at?: string;
}

/** Newest last_synced_at across the sheets skipped by the cooldown. */
function newestStamp(rows: SyncOutcome[]): string | null {
  const stamps = rows.map((r) => r.last_synced_at).filter(Boolean) as string[];
  return stamps.length ? stamps.sort()[stamps.length - 1] : null;
}

/** "40 seconds ago" / "3 minutes ago". Coarse on purpose — the reader only
 *  needs to judge whether their own submission could have been in that run. */
function agoLabel(iso: string | null): string {
  if (!iso) return "a moment ago";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs} second${secs === 1 ? "" : "s"} ago`;
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins === 1 ? "" : "s"} ago`;
}

/**
 * The Sync button's behaviour, shared by every tab that owns a sheet.
 *
 * Extracted rather than copied because the interesting part is what it refuses
 * to call a failure. "Already syncing" (somebody else holds the sheet) and "Up
 * to date" (it was pulled inside the cooldown) are both normal, and a rep told
 * their sync FAILED presses the button again — which turns a rush into a
 * stampede, the exact thing the lock and the cooldown exist to prevent. A
 * second copy of this logic is a second chance to get that wrong.
 *
 * `sheets` is the tab's own sources and is required, so a new tab cannot fall
 * back to pulling every sheet the module has. `onDone` is called after a run
 * that changed anything, so the caller can re-query.
 */
export type SyncSheet = "log" | "plan" | "dealers" | "targets" | "oem_targets";

export function useSyncLatest(
  headers: Record<string, string>, onDone: () => void, sheets: SyncSheet[],
) {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);

  const syncAll = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${API_URL}/oe-network/sync-latest?sheets=${sheets.join(",")}`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Sync failed");
      const results: SyncOutcome[] = data.results;
      const busy = results.filter((r) => r.status === "Already syncing");
      const fresh = results.filter((r) => r.status === "Up to date");
      const failed = results.filter(
        (r) => r.status !== "Done" && r.status !== "Already syncing" && r.status !== "Up to date");
      const pulled = results.filter((r) => r.status === "Done");

      if (failed.length) {
        toast.error("Some sheets failed to sync", failed.map((f) => f.label).join(", "));
      } else if (pulled.length === 0) {
        // Say WHEN, never a bare "up to date" — a rep who filed a visit a
        // moment ago needs to know whether that run could have included it.
        toast.info(
          busy.length ? "Someone else is syncing right now" : "Already up to date",
          busy.length
            ? "Their run is pulling the same sheets. Hit Refresh shortly to pick it up."
            : `Last pulled ${agoLabel(newestStamp(fresh))}. If you have just submitted a visit, try again in a minute.`);
      } else {
        const rows = pulled.reduce((s, r) => s + (r.rows_inserted ?? 0), 0);
        const skipped = busy.length + fresh.length;
        toast.success("Data refreshed",
          `${rows.toLocaleString("en-IN")} rows loaded from ${pulled.length} sheet${pulled.length === 1 ? "" : "s"}`
          + (skipped ? ` · ${skipped} already current` : ""));
      }
      onDone();
    } catch (e) {
      toast.error("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return { syncing, syncAll };
}
