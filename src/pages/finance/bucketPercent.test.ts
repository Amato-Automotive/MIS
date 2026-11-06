/**
 * A line's "% of Sales" for a quarter or year.
 *
 * The P&L cards once showed the quarter's profit beside its LAST month's margin:
 * Q2 Gross Margin read 17.8% (September) on ₹4.89Cr of ₹22.25Cr sales, which is
 * 22.0%. A flow's period % must come from the period's totals; a stock's is the
 * closing month's, which is what the Balance Sheet still uses.
 */
import { describe, it, expect } from "vitest";
import { bucketPercent, monthlyPercentBase, type FinPoint } from "./dashboardKit";

const m = (end: string, amount: number | null, percent: number | null): FinPoint =>
  ({ period_start_date: end, period_end_date: end, period_type: "monthly", amount, percent });

// Jul/Aug/Sep sales 100 / 300 / 600; gross 30 / 60 / 60 → 30%, 20%, 10%.
const sales = [m("2026-07-31", 100, 1), m("2026-08-31", 300, 1), m("2026-09-30", 600, 1)];
const gross = [m("2026-07-31", 30, 0.3), m("2026-08-31", 60, 0.2), m("2026-09-30", 60, 0.1)];

describe("bucketPercent", () => {
  it("works a quarter's flow % out from the quarter's totals, not its last month", () => {
    const base = monthlyPercentBase([sales, gross]);
    expect(bucketPercent(gross, "quarterly", "Q2 FY27", "flow", base)).toBeCloseTo(150 / 1000);
    expect(bucketPercent(sales, "quarterly", "Q2 FY27", "flow", base)).toBeCloseTo(1);
  });

  it("is not a plain average of the monthly percents", () => {
    const base = monthlyPercentBase([sales, gross]);
    expect(bucketPercent(gross, "quarterly", "Q2 FY27", "flow", base)).not.toBeCloseTo((0.3 + 0.2 + 0.1) / 3);
  });

  it("keeps the sheet's own % for a single month", () => {
    expect(bucketPercent(gross, "monthly", "Aug 2026", "flow")).toBe(0.2);
  });

  it("takes the closing month's % for a stock", () => {
    expect(bucketPercent(gross, "quarterly", "Q2 FY27", "stock")).toBe(0.1);
  });

  it("counts a month the line is zero in toward the base", () => {
    const pat = [m("2026-07-31", 10, 0.1), m("2026-08-31", 0, 0), m("2026-09-30", 60, 0.1)];
    const base = monthlyPercentBase([sales, pat]);
    expect(bucketPercent(pat, "quarterly", "Q2 FY27", "flow", base)).toBeCloseTo(70 / 1000);
  });

  it("returns null rather than guess when a month's base is unknown", () => {
    const pat = [m("2026-07-31", 10, 0.1), m("2026-08-31", 5, null)];
    expect(bucketPercent(pat, "quarterly", "Q2 FY27", "flow")).toBeNull();
  });
});
