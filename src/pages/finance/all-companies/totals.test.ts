/**
 * The Total rows under the All Companies tables. A total that adds the wrong
 * things reads as a plausible number, so the arithmetic is pinned here.
 */
import { describe, it, expect } from "vitest";
import { sumColumn, sumTogether, totalMargin } from "./totals";

describe("sumColumn", () => {
  it("adds the figures that exist and counts them", () => {
    expect(sumColumn([100, 250, 50])).toEqual({ value: 400, n: 3 });
  });

  it("does not treat a missing figure as zero", () => {
    expect(sumColumn([100, null, undefined, 50])).toEqual({ value: 150, n: 2 });
  });

  it("is null, not 0, when no company reported", () => {
    expect(sumColumn([null, undefined])).toEqual({ value: null, n: 0 });
    expect(sumColumn([])).toEqual({ value: null, n: 0 });
  });

  it("keeps a genuine zero and a loss", () => {
    expect(sumColumn([0, -40, 100])).toEqual({ value: 60, n: 3 });
  });
});

describe("sumTogether", () => {
  // Company B reports Sources but not Application. Summing each column on its own
  // would give 300 vs 150 — a balance sheet that appears to be out by 150 although
  // every company's own row balances.
  const rows = [[100, 100], [200, null], [50, 50]];

  it("sums only the companies that have every column", () => {
    expect(sumTogether(rows)).toEqual({ values: [150, 150], n: 2 });
  });

  it("keeps identities exact on the total row", () => {
    // accumulated tax − deposited = pending, per company → also in total.
    const tax = [[100, 30, 70], [40, 10, 30], [500, null, null]];
    const t = sumTogether(tax);
    expect(t.values).toEqual([140, 40, 100]);
    expect(t.values[0]! - t.values[1]!).toBe(t.values[2]);
  });

  it("is null when no company is complete", () => {
    expect(sumTogether([[1, null], [null, 2]])).toEqual({ values: [null, null], n: 0 });
  });
});

describe("totalMargin", () => {
  it("is total PAT over total Sales, not the average of margins", () => {
    // 10% on 100 and 2% on 900 → 28 of 1,000 = 2.8%, not (10% + 2%) / 2 = 6%.
    expect(totalMargin([{ sales: 100, pat: 10 }, { sales: 900, pat: 18 }])).toBeCloseTo(0.028, 10);
  });

  it("ignores a company that reports sales but no PAT, on both sides", () => {
    expect(totalMargin([{ sales: 100, pat: 10 }, { sales: 900, pat: null }])).toBeCloseTo(0.1, 10);
  });

  it("has no margin without turnover", () => {
    expect(totalMargin([{ sales: 0, pat: -5 }])).toBeNull();
    expect(totalMargin([])).toBeNull();
  });
});
