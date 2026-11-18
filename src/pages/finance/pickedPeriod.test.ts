/**
 * Charts end at the picked period. Finance adds next month's column before
 * filling it, so the data runs past what the picker is on; the chart must stop
 * at the picker, whatever granularity it is on.
 */
import { describe, it, expect } from "vitest";
import { keepUpTo, labelEnd, upToPicked } from "./pickedPeriod";

describe("labelEnd", () => {
  it("reads a month as its last day, leap years included", () => {
    expect(labelEnd("Sep 2026")).toBe("2026-09-30");
    expect(labelEnd("Oct 2026")).toBe("2026-10-31");
    expect(labelEnd("Feb 2028")).toBe("2028-02-29");
  });

  it("reads a quarter of the Indian financial year", () => {
    // FY27 runs April 2026 – March 2027.
    expect(labelEnd("Q1 FY27")).toBe("2026-06-30");
    expect(labelEnd("Q2 FY27")).toBe("2026-09-30");
    expect(labelEnd("Q3 FY27")).toBe("2026-12-31");
    expect(labelEnd("Q4 FY27")).toBe("2027-03-31");
  });

  it("reads a financial year as 31 March of its second year", () => {
    expect(labelEnd("FY 26-27")).toBe("2027-03-31");
    expect(labelEnd("FY 25-26")).toBe("2026-03-31");
  });

  it("returns null for anything else", () => {
    expect(labelEnd("Nonsense")).toBeNull();
    expect(labelEnd("Foo 2026")).toBeNull();
    expect(labelEnd("")).toBeNull();
  });
});

describe("keepUpTo", () => {
  it("stops a monthly chart at the picked month", () => {
    expect(keepUpTo("Sep 2026", "Sep 2026")).toBe(true);
    expect(keepUpTo("Aug 2026", "Sep 2026")).toBe(true);
    expect(keepUpTo("Oct 2026", "Sep 2026")).toBe(false);
    expect(keepUpTo("Nov 2026", "Sep 2026")).toBe(false);
  });

  it("orders across year ends, not by the text of the label", () => {
    expect(keepUpTo("Dec 2026", "Jan 2027")).toBe(true);
    expect(keepUpTo("Jan 2027", "Dec 2026")).toBe(false);
    expect(keepUpTo("Apr 2026", "Mar 2027")).toBe(true);
  });

  it("works for quarters and years", () => {
    expect(keepUpTo("Q1 FY27", "Q2 FY27")).toBe(true);
    expect(keepUpTo("Q3 FY27", "Q2 FY27")).toBe(false);
    expect(keepUpTo("Q4 FY26", "Q1 FY27")).toBe(true);
    expect(keepUpTo("FY 25-26", "FY 26-27")).toBe(true);
    expect(keepUpTo("FY 27-28", "FY 26-27")).toBe(false);
  });

  it("does not drop a period it cannot read, or when nothing is picked", () => {
    expect(keepUpTo("Mystery", "Sep 2026")).toBe(true);
    expect(keepUpTo("Nov 2026", "")).toBe(true);
    expect(keepUpTo("Nov 2026", undefined)).toBe(true);
  });
});

describe("upToPicked", () => {
  const rows = ["Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026"].map((label, i) => ({ label, v: i }));

  it("cuts the rows after the picked period, even when the chart has no row for it", () => {
    expect(upToPicked(rows, "Sep 2026").map((r) => r.label)).toEqual(["Aug 2026", "Sep 2026"]);
    // The pick is a month this chart has no row for: still cut by date.
    expect(upToPicked(rows.filter((r) => r.label !== "Sep 2026"), "Sep 2026").map((r) => r.label)).toEqual(["Aug 2026"]);
  });

  it("extends when a later period is picked, and leaves rows alone with no pick", () => {
    expect(upToPicked(rows, "Oct 2026")).toHaveLength(3);
    expect(upToPicked(rows, undefined)).toHaveLength(4);
  });
});
