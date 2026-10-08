// Types, ranking metadata and formatting helpers for the Dealers tab — the
// dealer-centric half of the OE Network module. Every other tab is keyed on the
// rep; this one is keyed on the dealership, which is how the OE team's own file
// is keyed and how leadership asks its questions.
// KPI (the StatCard colour roles) lives in ../shared and is used module-wide;
// re-exported here so the dealer components keep one import.
export { KPI, categoryLabel } from "../shared";
import { CATEGORY_LABELS } from "../shared";

/**
 * The dealer file's funnel, in the OE team's own vocabulary:
 *
 *   oem_total  "Total MSIL SC Sales" — every seat cover that dealer sold,
 *              ours or not
 *   ysasc      "Available YS Part Number" (the file's own column is YSASC,
 *              YS Available Seat Covers) — of those, the ones on a vehicle we
 *              hold a part number for. NULL when the source file predates the
 *              three-series format and simply didn't say.
 *   ys_sale    "YS SC Sale" — what we actually sold them
 *
 * and the three ratios read off it. `penetration` ("YS Share" on screen) is
 * the headline and its denominator is ysasc, so it is null whenever ysasc is.
 *
 * oem_total is nullable for a bigger reason than a missing cell: not every OEM
 * publishes one. TATA's tab gives a target and an achievement and never says
 * how much the dealer sold, so for TATA the whole funnel is unavailable rather
 * than zero — hence `Capabilities.funnel`, which decides whether a panel built
 * on these figures is drawn at all. Never render a null here as 0.
 */
export interface Funnel {
  oem_total: number | null; ysasc: number | null; ys_sale: number;
  /** ys_sale ÷ ysasc — what we converted of what we could have won. */
  penetration: number | null;
  /** ys_sale ÷ oem_total — our slice of the dealer's whole seat-cover business. */
  share: number | null;
  /** ysasc ÷ oem_total — how much of it we make a part for at all. */
  addressable_pct: number | null;
}
export interface PerfDealer extends Funnel {
  id: string; oem: string; name: string; city: string; state: string;
  salesperson: string | null; codes: string | null;
  /** The DEALERSHIP this outlet belongs to. On the OEMs whose file is keyed per
   *  dealer code, several rows share one: they are separate outlets with
   *  separate targets, but one physical dealership that was visited once. Every
   *  contact figure on those rows is the group's, so anything totalling
   *  activity must count each group_key once. */
  group_key: string;
  contacts: number; visits: number; calls: number; last_contact: string | null;
  target: number | null; achievement: number | null;
  /** What we sold inside the quarters this period touches — the progress figure
   *  for an OEM that publishes a quarter target but no achievement column. */
  sold: number | null;
  has_sales: boolean;
}

/** What the OEMs currently in scope actually publish, so the tab can draw the
 *  panels their data supports instead of a screenful of blanks.
 *
 *  `funnel` is an AND across the scope: with a funnel OEM and a non-funnel one
 *  both in view there is no honest network penetration to show, because half
 *  the denominator does not exist. */
/** The funnel for the products that publish a total, when not all of them do.
 *
 *  TATA seat covers carry one and TATA mats do not, so `kpis` — which covers
 *  everything in view — correctly has no funnel at all. Drawing nothing was
 *  worse than it sounds: the totals arrived and the tab looked identical,
 *  because its most useful figure was reachable only by setting a product
 *  filter nobody knew to set. This block is aggregated over `products` alone
 *  and must always be labelled with them; it is NOT the whole selection. */
export interface FunnelScope extends Funnel { products: string[] }

export interface Capabilities {
  funnel: boolean;
  /** Whether every OEM in view is one we hold a part number for across their
   *  whole range. On MSIL the addressable pool is a real constraint the file
   *  measures; on TATA we carry everything, so Available YS Part Number IS the
   *  dealer's total and Available Part Number % is a truthful 100 — which looks
   *  exactly like a bug unless the page says why. */
  full_coverage: boolean;
  products: string[];
  oems: number;
}

/** What our own units are called, in the OEM's own words.
 *
 *  MSIL's file calls them YS — YSC, YSASC, "TOTAL YS". TATA's calls them AMATO
 *  ("JULY'26 ACH SC AMATO"). The name belongs to the source and is not ours to
 *  standardise: a rep reading this tab has the sheet open next to it.
 *
 *  This used to be inferred from `funnel` — a target-only OEM was TATA, so it
 *  got "Amato" and everyone else got "YS". That proxy died the day TATA started
 *  publishing a seat-cover total: TATA filtered to seat covers now HAS a funnel
 *  and would have been captioned in MSIL's vocabulary. Keyed on the OEM itself. */
const OURS_NAME: Record<string, string> = { MSIL: "YS", TATA: "Amato" };

/** Neutral wording when several OEMs are in view — naming one of them would be
 *  a claim about the other's rows.
 *
 *  `products` names the product word. It is not decoration: TATA's unfiltered
 *  figure is seat covers AND mats, and calling that "Amato SC Sale" put a
 *  seat-cover label on a number containing mats — while the seat-cover-only
 *  panel directly beneath it carried the SAME label over a different figure.
 *  One label, two numbers, one screen. With more than one product in view the
 *  product word is dropped rather than guessed. */
export const oursLabels = (oems: string[], products?: string[]) => {
  const n = oems.length === 1 ? (OURS_NAME[oems[0]] ?? "YS") : null;
  // "SC" stays the literal source word — it is what MSIL's file and every
  // existing caption say — while other single products take their display name.
  const p = products && products.length === 1
    ? (products[0] === "SC" ? "SC" : CATEGORY_LABELS[products[0]] ?? products[0])
    : null;
  const sale = [n ?? "Our", p, "Sale"].filter(Boolean).join(" ");
  return {
    sale,
    avail: n ? `Available ${n} Part Number` : "Available Part Number",
    share: n ? `${n} Share` : "Our Share",
  };
};

/** "Total MSIL SC Sales" is MSIL's own name for the column. It stopped being a
 *  safe constant the day TATA started publishing a total of its own: printed
 *  over TATA's numbers it names the wrong OEM, which is worse than vague.
 *  One OEM in view gets its name; a mixed view gets none. */
export const totalLabel = (oems: string[]): string =>
  `Total ${oems.length === 1 ? oems[0] : "OEM"} SC Sales`;
export interface DealerSpRow extends Funnel {
  salesperson: string; assigned: number; contacted: number; coverage: number | null;
  visits: number; calls: number; target: number; achievement: number; sold: number;
}
/** One product's line of a quarter: what was targeted, what the file reported,
 *  and what we actually sold in that quarter's months. */
export interface QuarterProduct {
  product: string; target: number | null;
  achievement: number | null; sold: number | null;
}
/** A month with no sales rows still appears for its contacts, so every figure
 *  is nullable here even though it isn't on the dealer rows. */
export type DealerMonth = Partial<Funnel> & {
  month: string; visits: number; calls: number;
};
export type DealerQuarter = Partial<Funnel> & {
  quarter: string; fy_year: number; label: string; period_start: string; period_end: string;
  target: number | null; achievement: number | null; sold: number;
  /** Last month `sold` counts: the quarter's end, or the period's end when
   *  that falls inside the quarter — quarter to date. */
  sold_through?: string;
  /** Always present, with one entry for an OEM that sets a single target — so
   *  the panel never has to know which kind of file it is looking at. */
  by_product: QuarterProduct[];
};
export interface ContactBucket extends Funnel {
  bucket: string; dealer_months: number;
}
export interface DealerPerf {
  period: { month_from: string | null; month_to: string | null; date_from: string | null; date_to: string | null };
  capabilities: Capabilities;
  /** See FunnelScope. Null when `kpis` already carries the funnel. */
  funnel_scope: FunnelScope | null;
  /** The window `kpis.sold` is summed over: from the start of the first quarter
   *  the period touches to the period's own end — quarter to date. Targets are
   *  agreed per quarter and never pro-rated, so a month view compares
   *  Jul–Aug's sales with the whole JAS target. Null when no quarter overlaps
   *  the period, where `sold` genuinely is the selected months. */
  sold_scope: { month_from: string; month_to: string } | null;
  kpis: Funnel & {
    /** Dealerships (groups), which is what coverage is a share of. `outlets` is
     *  the number of rows in `dealers` — larger wherever one dealership is
     *  listed under several codes. */
    dealers: number; outlets: number; contacted: number; coverage: number | null;
    /** Whole-OEM penetration for the period — the yardstick "vs Average" is
     *  measured against. Unaffected by the rep/state filters, unlike
     *  `penetration` above, which is this view's own figure. */
    benchmark: number | null;
    benchmark_share: number | null;
    visits: number; calls: number;
    target: number; achievement: number | null; sold: number;
  };
  dealers: PerfDealer[];
  by_salesperson: DealerSpRow[];
  by_month: DealerMonth[];
  by_quarter: DealerQuarter[];
  contact_effect: { months: number; buckets: ContactBucket[] };
}
export interface DealerNote { category: string; label: string; text: string; themes: string[] }
export interface PerfContact {
  id: string; visit_date: string | null; salesperson: string; contact_mode: string;
  channel: string | null; contact_person: string | null; designation: string | null;
  car_sales: number | null; seat_cover_sales: number | null; mats_sales: number | null;
  notes: DealerNote[];
}
/** Funnel plus the activity counts and how many months it was summed over. */
export type DealerTotals = Funnel & { visits: number; calls: number; months: number };

export interface DealerDetail {
  /** What this dealer's OEM publishes, judged across ALL its months. The drawer
   *  renders the tile set the source can fill, the same way the tab does — a
   *  TATA dealer has no Total MSIL SC Sales, Available YS Part Number or YS
   *  Share in any month, so those
   *  tiles are absent rather than dashed. */
  capabilities: { funnel: boolean; full_coverage?: boolean };
  dealer: PerfDealer & { source: string; dealer_code: string | null };
  /** Every product on record for this dealer, unfiltered by the tab's product
   *  filter — the drawer says what they buy from us, all of it. */
  by_product: { product: string; ys_sale: number; oem_total: number | null; ysasc: number | null }[];
  /** Scoped to the period the tab is filtered to, so the drawer's headline
   *  figures reconcile with the row that was clicked. */
  totals: DealerTotals;
  /** Every month on record — context, shown underneath. */
  lifetime: DealerTotals;
  period: {
    month_from: string | null; month_to: string | null;
    date_from: string | null; date_to: string | null;
    /** The tab is on "all time", so both scopes are the same figures. */
    all_time: boolean;
  };
  by_month: DealerMonth[];
  targets: {
    quarter: string; fy_year: number; label: string;
    /** Inclusive quarter bounds, so the drawer can keep the quarters that
     *  overlap the selected period — never pro-rated, same rule as the tab. */
    period_start: string; period_end: string;
    product: string;
    target: number | null; achievement: number | null; sold: number | null;
    /** `sold` stopped at the period the tab is filtered to (quarter to date). */
    sold_to_period: number | null;
  }[];
  last_field_note: PerfContact | null;
  history: PerfContact[];
}

/** A whole unit count for display.
 *
 *  Rounds, because one figure behind this tab is NOT whole in the source: the
 *  dealer file's quarterly target is an OEM total split across dealers by
 *  share, so a dealer's own target is 32.76036 seat covers. The API sends it at
 *  full precision on purpose — totals are summed unrounded and rounded once, so
 *  the headline matches the sheet's own total row — and the rounding belongs
 *  here, at the last possible moment. Rounding earlier moved the MSIL JAS'26
 *  total 27 units off the sheet. Every other figure these format is already a
 *  whole count, so this is a no-op for them. */
export const n0 = (n: number | null | undefined) => Math.round(n ?? 0).toLocaleString("en-IN");
/** For a figure the source may genuinely not publish. `n0` reads a null as 0,
 *  which is right for our own sales and wrong for anything else — an em dash
 *  says "not supplied", a 0 says "sold none", and they are not the same claim. */
export const nOr = (n: number | null | undefined) =>
  (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
/** Achievement as a share of target. Null when there is no target to divide by:
 *  a dealer with no target has not missed one. */
export const hitPct = (ach: number | null | undefined, tgt: number | null | undefined) =>
  tgt ? Math.round(((ach ?? 0) / tgt) * 100) : null;

/** Rankings a dealer list can be read by. `gap` is the one that matters most:
 *  how far this dealer sits from what the network average would predict — it
 *  puts a big dealer at 2% penetration below a small one at 0%.
 *
 *  ── The sign convention, which is the whole point ──
 *  On every signed metric here, and everywhere else in this module,
 *  **`+` means we are doing well and is green; `−` means we are behind and is
 *  red.** No exceptions, because a reader who learns the convention on one
 *  screen applies it to the next, and this module used to hold both readings at
 *  once: the Targets tab had a Gap where + meant ahead while this tab had an
 *  Opp. where + meant behind. Nothing looked broken — the number was simply
 *  inverted between two tabs of the same module.
 *
 *  That is also why these are named "vs Average" and "vs Target" rather than
 *  "Opportunity" and "Behind target". A name that states a DIRECTION pins the
 *  sign to it: "Opportunity +500" can only mean 500 units of upside, so once +
 *  means ahead the old name fights the number. "vs X" is neutral and lets the
 *  sign carry the meaning.
 *
 *  Each ranking still says what BOTH of its ends mean, because for a signed
 *  metric the bottom is not "the worst" in the way a reader assumes — it is the
 *  list to WORK, which is the more useful end and the one the table opens on.
 *
 *  `floor` marks the rankings whose bottom end is meaningless without a volume
 *  cut-off: sorted by a ratio, the worst dealers are simply the smallest ones.
 *  The signed metrics need no floor — they already scale with volume, so a
 *  small dealer cannot produce a big figure in either direction. */
export type RankMetric =
  | "ys_sale" | "penetration" | "gap" | "oem_total" | "ysasc" | "tgt_gap";

/** Which rankings a scope can actually answer. The funnel ones divide by
 *  figures a non-funnel OEM never publishes, so offering them there would put a
 *  column of dashes behind a picker that looks like it should work. */
/** `fullCoverage` drops the addressable ranking: for an OEM whose whole range
 *  we carry it is the total ranking again under a second name, and a picker
 *  with two entries that produce an identical order reads as a bug. */
export const RANK_METRICS = (funnel: boolean, fullCoverage = false): RankMetric[] =>
  funnel
    ? (fullCoverage
        ? ["gap", "ys_sale", "penetration", "oem_total"]
        : ["gap", "ys_sale", "penetration", "oem_total", "ysasc"])
    : ["tgt_gap", "ys_sale"];
export const RANK_META: Record<RankMetric, {
  label: string; what: string; top: string; bottom: string; floor: boolean;
  /** Runs positive AND negative, with + meaning ahead. Drives the colour of the
   *  figure and which end of the list the table opens on — for these the useful
   *  default is the BOTTOM, because that is where the work is. */
  signed?: boolean;
}> = {
  gap: {
    label: "vs Average",
    what: "units above or below what the OEM average would predict for this dealer — "
      + "what we actually sell them, minus their {avail} × the average {share}. "
      + "Measured on the addressable figure, so a dealer is never charged for cars "
      + "we make no part for",
    top: "the dealers furthest AHEAD of the average — where we're already "
      + "outperforming. Not a problem list: these are the ones to protect, and "
      + "to copy.",
    bottom: "the dealers furthest BEHIND the average. This is the list to work: "
      + "the units are there and we aren't getting them. Their figure is negative "
      + "because they fall short of the benchmark.",
    floor: false,
    signed: true,
  },
  ys_sale: {
    label: "YS SC Sale",
    what: "the number of our units the dealer bought in this period",
    top: "our biggest dealers by volume",
    bottom: "the dealers buying least from us",
    floor: true,
  },
  penetration: {
    label: "YS Share",
    what: "{sale} ÷ {avail} — of the covers this dealer sold that we make a part for, "
      + "the share that was ours. This is a selling number: everything it divides by "
      + "was genuinely winnable",
    top: "where we convert the most of what we could have won",
    bottom: "where we convert the least — the covers were addressable and went elsewhere",
    floor: true,
  },
  oem_total: {
    label: "Total MSIL SC Sales",
    what: "every seat cover the dealer sold, ours or anyone's — how big they are",
    top: "the biggest dealerships in the network",
    bottom: "the smallest dealerships",
    floor: false,
  },
  tgt_gap: {
    // Named against the "vs X" rule above, deliberately: the OE team asked for
    // "Remaining Target" and that is what the column says. The SIGN is
    // unchanged — + is still ahead — so the name no longer carries the
    // direction and every place this metric is described has to state it
    // instead. That is why `what` below leads with the sign rather than
    // mentioning it in passing.
    label: "Remaining Target",
    what: "what we have actually sold this dealer inside the quarter so far, minus the "
      + "quarter target they were set — so + is AHEAD of target and − is still to go. "
      + "The target is the whole quarter's and is never "
      + "pro-rated, so part-way through a quarter a negative figure is expected — read "
      + "it against how much of the quarter has gone",
    top: "the dealers already PAST their target, furthest first. Not a problem list.",
    bottom: "the dealers furthest behind their own target in units. The biggest "
      + "shortfalls, which is where the quarter is won or lost.",
    floor: false,
    signed: true,
  },
  // Ranked on the COUNT, not the share. The percentage answers "how much of
  // this dealer does our range reach", which is a product question; the count
  // answers "how many winnable units are sitting at this dealer", which is the
  // one a rep planning a week can act on. It also needs no volume floor — an
  // absolute count already scales with size, so the bottom of the list cannot
  // fill up with tiny dealerships the way a ratio's does.
  ysasc: {
    label: "Available YS Part Number",
    what: "the covers this dealer sold that we hold a part number for — the winnable "
      + "business at this dealer in units, before any of it is won",
    top: "where the most winnable units sit, whether or not we are winning them",
    bottom: "where there is least to win — a small dealer, or one selling covers we "
      + "make no part for",
    floor: false,
  },
};

/** Our units for the scope being read.
 *
 *  The two are the SAME NUMBER whenever the period is whole quarters, which is
 *  why the TATA tables used to carry both — "Achieved" and "Amato SC Sale" sat
 *  side by side showing identical figures. They diverge on a partial period:
 *  `ys_sale` is the filtered months, `sold` is every month of the quarters
 *  those months touch, which is the only one the quarter target can be judged
 *  against. So a target-only OEM reports `sold` and a funnel OEM reports
 *  `ys_sale`, and the tile, the column and the ranking all read this.
 *
 *  Ranking by one while displaying the other is how a "top 20" ends up in an
 *  order the column it claims to be sorted on cannot explain. */
export const oursOf = (d: Pick<PerfDealer, "ys_sale" | "sold">, funnel: boolean): number =>
  (funnel ? d.ys_sale : d.sold ?? d.ys_sale);

/** The ranking's on-screen name for the scope it is being read in. Our own
 *  units go by a different name per OEM — MSIL's file calls them YS SC Sale,
 *  TATA's are Amato — so one static label would be wrong on one of the two
 *  tabs. Everything else is named the same in both scopes. */
export const rankLabel = (
  m: RankMetric, funnel: boolean, oems: string[] = [], products?: string[],
): string => {
  const L = oursLabels(oems, products);
  // `funnel` still decides WHICH figure this column holds (oursOf above); it no
  // longer decides what to call it. See OURS_NAME.
  if (m === "oem_total") return totalLabel(oems);
  if (m === "ys_sale") return L.sale;
  if (m === "ysasc") return L.avail;
  if (m === "penetration") return L.share;
  return RANK_META[m].label;
};

/** RANK_META's prose with the OEM's own vocabulary filled in.
 *
 *  The strings carry {sale}/{avail}/{share} tokens rather than MSIL's words,
 *  because the same ranking is read on a TATA tab where our units are Amato.
 *  Hardcoding them meant an Explain that described a different company's
 *  figures under this one's numbers — the sort of wrong that still reads as a
 *  sentence. */
export const rankMeta = (m: RankMetric, oems: string[] = [], products?: string[]) => {
  const L = oursLabels(oems, products);
  const fill = (t: string) =>
    t.replace(/\{sale\}/g, L.sale).replace(/\{avail\}/g, L.avail)
     .replace(/\{share\}/g, L.share);
  const meta = RANK_META[m];
  return { ...meta, what: fill(meta.what), top: fill(meta.top), bottom: fill(meta.bottom) };
};

export const rankValue = (
  d: PerfDealer, m: RankMetric, avgPene: number, funnel = true,
): number => {
  // Both signed metrics are written ACTUAL minus EXPECTED, never the other way
  // round, so + always reads "we sold more than expected". Reversing either one
  // makes two tabs of one module disagree about what a plus sign means, which
  // is the exact confusion this ordering exists to prevent.
  //
  // Only meaningful against the addressable base; a dealer with no YSASC has no
  // predictable figure and sorts as zero rather than as a fabricated one.
  if (m === "gap") return d.ys_sale - (d.ysasc ?? 0) * (avgPene / 100);
  // Same shape for the OEMs with no funnel: measured against a number somebody
  // actually agreed to, rather than against a modelled average.
  if (m === "tgt_gap") return (d.sold ?? d.ys_sale) - (d.target ?? 0);
  if (m === "penetration") return d.penetration ?? 0;
  if (m === "ysasc") return d.ysasc ?? 0;
  return m === "ys_sale" ? oursOf(d, funnel) : d.oem_total ?? 0;
};
