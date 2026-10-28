/**
 * Budget vs Actual and Unit Economics for a period. Fixtures are AMATO SRN's
 * live figures (Apr–Sep 2026). Both get a quarter or year wrong in a way that
 * looks plausible — summing a per-unit price, or treating opening cash as a
 * flow — which is why they are pinned here.
 */
import { describe, it, expect } from "vitest";
import type { FinSubSection, TimelineInput } from "./dashboardKit";
import { cashLineValue, compare, flowReading } from "./budgetMath";
import { productEconomics, productName } from "./unitEconomics";

const ENDS = ["2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
const months = (values: (number | null)[]): (TimelineInput & { period_start_date: string; percent: null })[] =>
  values.map((amount, i) => ({ period_start_date: ENDS[i], period_end_date: ENDS[i], period_type: "monthly", amount, percent: null }));

function product(key: string, metrics: Record<string, (number | null)[]>): FinSubSection {
  return {
    key, label: null, total: null,
    line_items: Object.entries(metrics).map(([slug, values], i) => ({
      line_key: `unit_economics/${key}/${slug}`, line_label: slug, item_no: i, entity_type: "line_item",
      parent_key: null, series: months(values),
    })),
  };
}

const SOLD = [13655, 20235, 14665, 17478, 21241, 18245];
const PRODUCED = [109318, 113936, 136433, 180254, 151384, 210421];
const seatCovers = product("seat_covers", {
  unit_sold: SOLD,
  revenue: SOLD.map((u) => u * 3000),
  average_selling_price: SOLD.map(() => 3000),
  unit_produced: PRODUCED,
  total_cost_of_products: PRODUCED.map((u) => u * 2000),
  average_product_cost: PRODUCED.map(() => 2000),
  operation_cost_variable: SOLD.map(() => 50),
  operation_cost_fixed: SOLD.map(() => 2),
  cost_per_unit: SOLD.map(() => 2052),
  profit_per_unit_value: SOLD.map(() => 948),
  profit_per_unit: SOLD.map(() => 0.316),
});

describe("unit economics", () => {
  it("uses the sheet's own figures for a month", () => {
    const m = productEconomics(seatCovers, "monthly", "Jul 2026");
    expect(m).toMatchObject({ sold: 17478, price: 3000, costPerUnit: 2052, profitPerUnit: 948, margin: 0.316 });
  });

  it("works a quarter out from its totals, not by adding up prices", () => {
    const q = productEconomics(seatCovers, "quarterly", "Q2 FY27");
    expect(q.sold).toBe(17478 + 21241 + 18245);
    expect(q.price).toBeCloseTo(3000, 6);          // not 9,000
    expect(q.productCost).toBeCloseTo(2000, 6);
    expect(q.costPerUnit).toBeCloseTo(2052, 6);
    expect(q.profitPerUnit).toBeCloseTo(948, 6);
    expect(q.margin).toBeCloseTo(0.316, 3);
  });

  it("averages product cost over everything produced in the period", () => {
    // Accessories, Q1: a flat ₹8L cost spread over very different volumes.
    const acc = product("accessories", {
      unit_sold: [4602, 8808, 6948],
      revenue: [1380600, 2642400, 2084400],
      unit_produced: [1372, 5057, 1833],
      total_cost_of_products: [800000, 800000, 800000],
      operation_cost_variable: [50, 50, 50],
      operation_cost_fixed: [2, 2, 2],
    });
    const q = productEconomics(acc, "quarterly", "Q1 FY27");
    expect(q.productCost).toBeCloseTo(2400000 / 8262, 6);
    expect(q.profitPerUnit).toBeCloseTo(300 - (2400000 / 8262 + 52), 6);
  });

  it("names a product from its key", () => {
    expect(productName("seat_covers")).toBe("Seat Covers");
  });
});

describe("budget vs actual", () => {
  it("calls a cost under budget favourable, and revenue under budget adverse", () => {
    expect(compare(100, 90, true).favourable).toBe(true);
    expect(compare(100, 90, false).favourable).toBe(false);
    expect(compare(100, 90, false)).toMatchObject({ variance: -10, variancePct: -0.1, achievement: 0.9 });
  });

  it("gives no achievement % on a zero or negative budget", () => {
    expect(compare(0, 50, false).achievement).toBeNull();
    expect(compare(-10, 5, false).achievement).toBeNull();
  });

  it("sums a flow line over the quarter", () => {
    const r = flowReading(months([10, 20, 30, 40, 50, 60]), months([12, 18, 30, 44, 50, 70]),
      "budget/pnl/revanue_income", "quarterly", "Q2 FY27");
    expect(r).toMatchObject({ budget: 150, actual: 164, variance: 14 });
  });

  it("takes opening cash from the first month and closing cash from the last", () => {
    const opening = months([null, 149384, 97377, 283300, 4822780, 4621618]);
    const closing = months([null, 97377, 283300, 4822780, 4621618, -39348371]);
    expect(cashLineValue(opening, "budget/cash_flow/opening_cash_bank", "quarterly", "Q2 FY27")).toBe(283300);
    expect(cashLineValue(closing, "budget/cash_flow/closing_cash_bank", "quarterly", "Q2 FY27")).toBe(-39348371);
    expect(cashLineValue(months([1, 2, 3, 4, 5, 6]), "budget/cash_flow/inflow_collection", "quarterly", "Q2 FY27")).toBe(15);
  });
});
