/**
 * The numbers behind the All Companies line charts. Each total line must equal
 * the table's Total row for the same period, so the arithmetic is pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  companyPoints, labelsUpTo, marginByLabel, rankLabel, sumByLabel, sumTogetherByLabel, toMap, topKeys, labelsFor,
  type LabelMap, type TrendPoint,
} from "./trends";

const m = (...pairs: [string, number][]): LabelMap => new Map(pairs);
const L = ["Jul 2026", "Aug 2026", "Sep 2026"];

describe("sumByLabel", () => {
  const a = m(["Jul 2026", 100], ["Aug 2026", 110], ["Sep 2026", 120]);
  const b = m(["Jul 2026", 50], ["Aug 2026", 60]);               // has not reported September

  it("adds the companies that reported each period", () => {
    const t = sumByLabel(L, [a, b]);
    expect(t.get("Jul 2026")).toEqual({ value: 150, n: 2, of: 2 });
    expect(t.get("Aug 2026")).toEqual({ value: 170, n: 2, of: 2 });
  });

  it("does not turn a company that has not reported into a zero, and says so", () => {
    // September: only A reported. 120 is a part-group figure — n/of says 1 of 2.
    expect(sumByLabel(L, [a, b]).get("Sep 2026")).toEqual({ value: 120, n: 1, of: 2 });
  });

  it("is null when nobody reported", () => {
    expect(sumByLabel(["Oct 2026"], [a, b]).get("Oct 2026")).toEqual({ value: null, n: 0, of: 2 });
  });
});

describe("sumTogetherByLabel", () => {
  it("keeps tied lines tied: only companies with every figure are added", () => {
    // Company B has Sources for Aug but no Application, so it is left out of BOTH
    // lines — the two lines then still sit on each other, as a balanced sheet does.
    const A = [m(["Aug 2026", 100]), m(["Aug 2026", 100])];
    const B = [m(["Aug 2026", 999]), m()];
    const [sources, application] = sumTogetherByLabel(["Aug 2026"], [A, B]);
    expect(sources.get("Aug 2026")).toEqual({ value: 100, n: 1, of: 2 });
    expect(application.get("Aug 2026")).toEqual({ value: 100, n: 1, of: 2 });
  });
});

describe("marginByLabel", () => {
  it("is total PAT over total Sales, in percent — not the mean of margins", () => {
    const cos = [
      { sales: m(["Sep 2026", 100]), pat: m(["Sep 2026", 10]) },    // 10%
      { sales: m(["Sep 2026", 900]), pat: m(["Sep 2026", 18]) },    // 2%
    ];
    expect(marginByLabel(["Sep 2026"], cos).get("Sep 2026")!.value).toBeCloseTo(2.8, 10);
  });

  it("has no margin for a period with no sales", () => {
    const cos = [{ sales: m(), pat: m() }];
    expect(marginByLabel(["Sep 2026"], cos).get("Sep 2026")!.value).toBeNull();
  });
});

describe("toMap / labelsFor", () => {
  const monthly = (end: string, amount: number) => ({ period_end_date: end, period_type: "monthly" as const, amount });

  it("sums a flow across a quarter but takes a stock's closing month", () => {
    const s = [monthly("2026-04-30", 10), monthly("2026-05-31", 20), monthly("2026-06-30", 30)];
    expect(toMap(s, "flow", "quarterly").get("Q1 FY27")).toBe(60);
    expect(toMap(s, "stock", "quarterly").get("Q1 FY27")).toBe(30);
  });

  it("orders periods by date across series, not by label text", () => {
    const a = [monthly("2026-09-30", 1)];
    const b = [monthly("2026-08-31", 1), monthly("2026-10-31", 1)];
    expect(labelsFor([a, b], "flow", "monthly")).toEqual(["Aug 2026", "Sep 2026", "Oct 2026"]);
  });

  it("copes with a missing series", () => {
    expect(toMap(undefined, "flow", "monthly").size).toBe(0);
    expect(labelsFor([undefined, null], "flow", "monthly")).toEqual([]);
  });
});

describe("default company selection", () => {
  const pt = (v: number | null): TrendPoint => ({ value: v, n: v == null ? 0 : 1, of: 1 });
  const cands = [
    { key: "a", points: new Map([["Sep 2026", pt(10)]]) },
    { key: "b", points: new Map([["Sep 2026", pt(-90)]]) },       // a big loss ranks high
    { key: "c", points: new Map([["Sep 2026", pt(50)]]) },
    { key: "d", points: new Map([["Sep 2026", pt(null)]]) },
  ];

  it("ranks by size so a large loss is as visible as a large profit", () => {
    expect(topKeys(cands, "Sep 2026", 2)).toEqual(["b", "c"]);
  });

  it("ignores companies with no figure", () => {
    expect(topKeys(cands, "Sep 2026", 10)).toEqual(["b", "c", "a"]);
  });

  it("ranks on the picked period, else the newest one anybody reported", () => {
    const lines = cands.map((c) => c.points);
    expect(rankLabel(["Aug 2026", "Sep 2026", "Oct 2026"], "Sep 2026", lines)).toBe("Sep 2026");
    expect(rankLabel(["Aug 2026", "Sep 2026", "Oct 2026"], "Oct 2026", lines)).toBe("Sep 2026");
  });

  it("a company's own points mark a missing period as absent, not zero", () => {
    const p = companyPoints(["Jul 2026", "Aug 2026"], m(["Jul 2026", 5]));
    expect(p.get("Aug 2026")).toEqual({ value: null, n: 0, of: 1 });
  });
});

describe("labelsUpTo", () => {
  const all = ["Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026"];

  it("stops at the picked period, so a part-filled later month is not drawn", () => {
    expect(labelsUpTo(all, "Sep 2026")).toEqual(["Aug 2026", "Sep 2026"]);
  });

  it("includes the picked period itself and extends when a later one is picked", () => {
    expect(labelsUpTo(all, "Oct 2026")).toEqual(["Aug 2026", "Sep 2026", "Oct 2026"]);
    expect(labelsUpTo(all, "Nov 2026")).toEqual(all);
  });

  it("keeps the full range when the pick has no point in the chart", () => {
    expect(labelsUpTo(all, "Jan 2027")).toEqual(all);
    expect(labelsUpTo(all, undefined)).toEqual(all);
  });
});
