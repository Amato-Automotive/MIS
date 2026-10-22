/**
 * Period ordering for the Finance multi-series charts.
 *
 * Each line item builds its own sorted timeline, and the charts merge them. A
 * period only some items carry — e.g. a yearly sheet added after the monthly
 * ones — used to land at the far right in first-seen order, so the x-axis read
 * FY 23-24, FY 25-26, FY 26-27, FY 24-25.
 */
import { describe, it, expect } from "vitest";
import { buildTimeline, mergedLabels, type FinPoint } from "./dashboardKit";

const annual = (end: string, amount: number): FinPoint =>
  ({ period_start_date: end, period_end_date: end, period_type: "annual", amount, percent: null });
const monthly = (end: string, amount: number): FinPoint =>
  ({ period_start_date: end, period_end_date: end, period_type: "monthly", amount, percent: null });

describe("mergedLabels", () => {
  it("puts a year only one item carries in its chronological place", () => {
    const a = buildTimeline([annual("2024-03-31", 1), monthly("2026-03-31", 1), monthly("2026-09-30", 1)], "stock", "yearly");
    const b = buildTimeline([annual("2025-03-31", 1)], "stock", "yearly");
    expect(mergedLabels([a, b])).toEqual(["FY 23-24", "FY 24-25", "FY 25-26", "FY 26-27"]);
  });

  it("orders months across calendar years, not by label text", () => {
    const a = buildTimeline([monthly("2026-01-31", 1)], "flow", "monthly");
    const b = buildTimeline([monthly("2025-12-31", 1)], "flow", "monthly");
    const labels = mergedLabels([a, b]);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe(b[0].label);
  });
});
