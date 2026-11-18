// The numbers behind the All Companies line charts.
//
// A chart sits directly under its table and has to agree with it, so every
// "total" line here is built with the same rules as the table's Total row
// (totals.ts): roll-up companies are filtered out by the caller, a company with
// no figure for a period contributes nothing (it is not a zero), and figures
// that must tie are summed over the same companies. Each point also carries
// `n` of `of` — how many companies the figure covers — because a total that
// dips in the latest month is often just companies that have not reported yet,
// and the chart must be able to say so.
import { buildTimeline, mergedLabels, type TimelineInput } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { netPatMargin } from "../margin";
import { keepUpTo } from "../pickedPeriod";
import { sumColumn, sumTogether } from "./totals";

export type LabelMap = Map<string, number>;

export interface TrendPoint {
  value: number | null;
  /** Companies that had a figure for this period... */
  n: number;
  /** ...out of the companies the line is meant to cover. */
  of: number;
}

type MaybeSeries = TimelineInput[] | null | undefined;

/** One series as {period label → value}, on the view's granularity. Flow figures
 *  sum within a quarter or year, stock figures take the closing month. */
export function toMap(series: MaybeSeries, kind: "stock" | "flow", view: TrendView): LabelMap {
  return new Map(buildTimeline(series ?? [], kind, view).map((p) => [p.label, p.value]));
}

/** Every period label any of these series covers, in date order. */
export function labelsFor(seriesList: MaybeSeries[], kind: "stock" | "flow", view: TrendView): string[] {
  return mergedLabels(seriesList.map((s) => buildTimeline(s ?? [], kind, view)));
}

/** Σ across companies for each period. null — not 0 — where nobody reported. */
export function sumByLabel(labels: string[], maps: LabelMap[]): Map<string, TrendPoint> {
  return new Map(labels.map((l) => {
    const t = sumColumn(maps.map((m) => m.get(l)));
    return [l, { value: t.value, n: t.n, of: maps.length }] as const;
  }));
}

/**
 * Several figures that must agree (Sources and Application; accumulated tax,
 * tax deposited and tax pending), summed per period over ONLY the companies that
 * have all of them — so the lines tie exactly as the tied table columns do.
 * Returns one point map per figure.
 */
export function sumTogetherByLabel(labels: string[], companies: LabelMap[][]): Map<string, TrendPoint>[] {
  const width = companies.reduce((w, c) => Math.max(w, c.length), 0);
  const out: Map<string, TrendPoint>[] = Array.from({ length: width }, () => new Map());
  for (const l of labels) {
    const t = sumTogether(companies.map((c) => c.map((m) => m.get(l))));
    for (let i = 0; i < width; i++) out[i].set(l, { value: t.values[i] ?? null, n: t.n, of: companies.length });
  }
  return out;
}

/** Total PAT margin per period, in percent: total PAT over total Sales for the
 *  companies that report both — never an average of the companies' margins. */
export function marginByLabel(labels: string[], companies: { sales: LabelMap; pat: LabelMap }[]): Map<string, TrendPoint> {
  return new Map(labels.map((l) => {
    const t = sumTogether(companies.map((c) => [c.sales.get(l), c.pat.get(l)]));
    const m = netPatMargin(t.values[0] ?? null, t.values[1] ?? null);
    return [l, { value: m == null ? null : m * 100, n: t.n, of: companies.length }] as const;
  }));
}

/** A single company's own figures as chart points (n/of are 1 or 0 of 1). */
export function companyPoints(labels: string[], map: LabelMap): Map<string, TrendPoint> {
  return new Map(labels.map((l) => {
    const v = map.get(l);
    return [l, { value: v ?? null, n: v == null ? 0 : 1, of: 1 }] as const;
  }));
}

/** The label that ranks companies by default: the picked period when anyone has
 *  a figure for it, otherwise the newest period anyone does. */
export function rankLabel(labels: string[], preferred: string, lines: Map<string, TrendPoint>[]): string | null {
  const has = (l: string) => lines.some((p) => p.get(l)?.value != null);
  if (labels.includes(preferred) && has(preferred)) return preferred;
  return [...labels].reverse().find(has) ?? null;
}

/** The `count` companies with the largest figure (by size, so a big loss ranks
 *  as high as a big profit) at `label`. */
export function topKeys(candidates: { key: string; points: Map<string, TrendPoint> }[], label: string | null, count: number): string[] {
  if (!label) return [];
  return candidates
    .map((c) => ({ key: c.key, v: c.points.get(label)?.value }))
    .filter((c): c is { key: string; v: number } => c.v != null)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, count)
    .map((c) => c.key);
}

/**
 * The periods a chart draws: from the first up to and including the picked one.
 * Labels arrive in date order, so cutting by position is cutting by date. What
 * the sheet holds after the picked period (often a month finance has only
 * part-filled) is not drawn. A pick the series has no point for leaves the full
 * range rather than an empty chart. Compared by date (pickedPeriod.ts), so a pick
 * the chart has no point for still cuts it in the right place.
 */
export function labelsUpTo(labels: string[], picked: string | undefined): string[] {
  return labels.filter((l) => keepUpTo(l, picked));
}
