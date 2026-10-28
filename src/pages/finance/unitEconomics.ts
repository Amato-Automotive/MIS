// Unit Economics for one product and one period.
//
// The sheet publishes per-unit rates month by month (price, product cost,
// operating cost per unit, profit per unit). Rates are not summable, so a
// quarter or year is worked out from the period's totals — the same arithmetic
// the sheet's own monthly rows follow:
//   selling price  = revenue ÷ units sold
//   product cost   = total cost of products ÷ units produced
//   operating cost = the monthly per-unit rates, weighted by units sold
//   cost per unit  = product cost + variable + fixed
//   profit / unit  = selling price − cost per unit;  margin = profit ÷ price
// A month uses the sheet's figures exactly as typed.
import { bucketValue, pointBucketLabel, type FinSubSection, type TimelineInput } from "./dashboardKit";
import type { TrendView } from "./aggregate";

export interface ProductEconomics {
  sold: number | null;
  produced: number | null;
  revenue: number | null;
  totalCost: number | null;
  price: number | null;
  productCost: number | null;
  variableCost: number | null;
  fixedCost: number | null;
  costPerUnit: number | null;
  profitPerUnit: number | null;
  /** profit ÷ price, as a fraction */
  margin: number | null;
}

// Metric slugs as the sheet's labels slugify ("Profit per unit %" → profit_per_unit).
const M = {
  sold: "unit_sold", produced: "unit_produced", revenue: "revenue", totalCost: "total_cost_of_products",
  price: "average_selling_price", productCost: "average_product_cost", variableCost: "operation_cost_variable",
  fixedCost: "operation_cost_fixed", costPerUnit: "cost_per_unit", profitPerUnit: "profit_per_unit_value",
  margin: "profit_per_unit",
} as const;

export function seriesOf(sub: FinSubSection, slug: string): TimelineInput[] {
  const it = sub.line_items.find((li) => li.line_key.slice(li.line_key.lastIndexOf("/") + 1) === slug);
  return it?.series ?? [];
}

const div = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : a / b);

/** A per-unit rate over a period, weighted by each month's units sold. */
function weightedRate(rate: TimelineInput[], weight: TimelineInput[], view: TrendView, bucket: string): number | null {
  const w = new Map(weight.filter((p) => p.amount != null).map((p) => [p.period_end_date, p.amount!]));
  let num = 0;
  let den = 0;
  for (const p of rate) {
    if (p.amount == null || p.period_type !== "monthly" || pointBucketLabel(p, view) !== bucket) continue;
    const units = w.get(p.period_end_date);
    if (units == null) continue;
    num += p.amount * units;
    den += units;
  }
  return den > 0 ? num / den : null;
}

export function productEconomics(sub: FinSubSection, view: TrendView, bucket: string): ProductEconomics {
  const flow = (slug: string) => bucketValue(seriesOf(sub, slug), "flow", view, bucket);
  const sold = flow(M.sold);
  const produced = flow(M.produced);
  const revenue = flow(M.revenue);
  const totalCost = flow(M.totalCost);

  if (view === "monthly") {
    const asIs = (slug: string) => bucketValue(seriesOf(sub, slug), "stock", view, bucket);
    return {
      sold, produced, revenue, totalCost,
      price: asIs(M.price), productCost: asIs(M.productCost), variableCost: asIs(M.variableCost),
      fixedCost: asIs(M.fixedCost), costPerUnit: asIs(M.costPerUnit), profitPerUnit: asIs(M.profitPerUnit),
      margin: asIs(M.margin),
    };
  }

  const soldSeries = seriesOf(sub, M.sold);
  const price = div(revenue, sold);
  const productCost = div(totalCost, produced);
  const variableCost = weightedRate(seriesOf(sub, M.variableCost), soldSeries, view, bucket);
  const fixedCost = weightedRate(seriesOf(sub, M.fixedCost), soldSeries, view, bucket);
  const costPerUnit = productCost != null && variableCost != null && fixedCost != null
    ? productCost + variableCost + fixedCost : null;
  const profitPerUnit = price != null && costPerUnit != null ? price - costPerUnit : null;
  return {
    sold, produced, revenue, totalCost, price, productCost, variableCost, fixedCost, costPerUnit, profitPerUnit,
    margin: div(profitPerUnit, price),
  };
}

/** "seat_covers" → "Seat Covers" — the product's name as the sheet wrote it
 *  after "Metrics of", which the sub-section key carries. */
export function productName(key: string | null): string {
  return (key ?? "").split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
