import { describe, expect, it } from "vitest";
import { reconAsAt, type ReconTie } from "./dashboardKit";

// RPAS, Nov 2026: September balances; October is half-filled (Sources 30.46Cr, Application 0).
const tie: ReconTie = {
  label: "Balance Sheet balances",
  left: { name: "Sources of Funds", value: 304_600_000 },
  right: { name: "Application of Funds", value: 0 },
  delta: 304_600_000, matches: false, period: "2026-10-31",
  history: [
    { period: "2026-03-31", left: 700, right: 700, delta: 0, matches: true },
    { period: "2026-09-30", left: 819_300_000, right: 819_300_000, delta: 0, matches: true },
    { period: "2026-10-31", left: 304_600_000, right: 0, delta: 304_600_000, matches: false },
  ],
};

describe("reconAsAt", () => {
  it("reads the check as at the picked month, not the latest one", () => {
    const [t] = reconAsAt([tie], "Sep 2026");
    expect(t.period).toBe("2026-09-30");
    expect(t.matches).toBe(true);
    expect(t.right.value).toBe(819_300_000);
  });
  it("a quarter reads as at its last day", () => {
    expect(reconAsAt([tie], "Q2 FY27")[0].period).toBe("2026-09-30");
  });
  it("a later pick moves on to the later check", () => {
    expect(reconAsAt([tie], "Oct 2026")[0].matches).toBe(false);
  });
  it("leaves a tie out when nothing was checked that early", () => {
    expect(reconAsAt([tie], "Jan 2020")).toEqual([]);
  });
  it("keeps ties that carry no history, and everything when nothing is picked", () => {
    const { history: _h, ...plain } = tie;
    expect(reconAsAt([plain], "Sep 2026")).toEqual([plain]);
    expect(reconAsAt([tie], undefined)).toEqual([tie]);
  });
});
