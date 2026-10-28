// Budget vs Actual for one period. Finance's Budget block carries budget
// figures only; each line's actual comes from the sheet's own P&L / Cash Flow /
// Units rows (built server-side, see _BUDGET_ACTUALS in routers/finance.py).
import { bucketValue, pointBucketLabel, type TimelineInput } from "./dashboardKit";
import type { TrendView } from "./aggregate";

// Lines where spending less than budget is the good outcome.
const COST_SLUGS = new Set(["cost_of_goods_sold", "operating_cost", "outflow_payables"]);

export const slugOf = (lineKey: string) => lineKey.slice(lineKey.lastIndexOf("/") + 1);
export const isCostLine = (lineKey: string) => COST_SLUGS.has(slugOf(lineKey));

export interface VarianceReading {
  budget: number | null;
  actual: number | null;
  /** actual − budget */
  variance: number | null;
  /** variance ÷ |budget| */
  variancePct: number | null;
  /** actual ÷ budget — only on a positive budget */
  achievement: number | null;
  /** Did the line beat budget? For costs, under budget is favourable. */
  favourable: boolean | null;
}

export function compare(budget: number | null, actual: number | null, cost: boolean): VarianceReading {
  if (budget == null || actual == null) {
    return { budget, actual, variance: null, variancePct: null, achievement: null, favourable: null };
  }
  const variance = actual - budget;
  return {
    budget, actual, variance,
    variancePct: budget !== 0 ? variance / Math.abs(budget) : null,
    achievement: budget > 0 ? actual / budget : null,
    favourable: cost ? variance <= 0 : variance >= 0,
  };
}

/** A flow line (revenue, costs, units, inflow…) for one period: the sum. */
export function flowReading(budget: TimelineInput[], actual: TimelineInput[] | undefined, lineKey: string,
  view: TrendView, bucket: string): VarianceReading {
  return compare(
    bucketValue(budget, "flow", view, bucket),
    actual ? bucketValue(actual, "flow", view, bucket) : null,
    isCostLine(lineKey),
  );
}

/** Opening cash for a period is its FIRST month's opening — not a sum, and not
 *  the last month's (which is what the stock rule would give). */
export function openingValue(series: TimelineInput[], view: TrendView, bucket: string): number | null {
  const inBucket = series
    .filter((p) => p.amount != null && pointBucketLabel(p, view) === bucket)
    .sort((a, b) => a.period_end_date.localeCompare(b.period_end_date));
  if (inBucket.length === 0) return null;
  const monthly = inBucket.filter((p) => p.period_type === "monthly");
  return (monthly.length ? monthly : inBucket)[0].amount;
}

/** How each cash-flow budget line folds into a period: opening from the first
 *  month, closing from the last, the flows in between summed. */
export function cashLineValue(series: TimelineInput[], lineKey: string, view: TrendView, bucket: string): number | null {
  const slug = slugOf(lineKey);
  if (slug.startsWith("opening")) return openingValue(series, view, bucket);
  if (slug.startsWith("closing")) return bucketValue(series, "stock", view, bucket);
  return bucketValue(series, "flow", view, bucket);
}
