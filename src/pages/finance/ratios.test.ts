/**
 * Quarter / year ratios.
 *
 * The sheet publishes ratios per month only. Bucketing them by "last month in
 * the bucket" showed September's month-on-month Sales Growth as Q2's growth, so
 * Monthly, Quarterly and Yearly read identically. Flow-based ratios are now
 * rebuilt from the bucket's own figures with the sheet's formula. Fixtures are
 * AMATO SRN's real figures (Apr–Sep 2026 monthly, FY 24-25 / 25-26 yearly).
 */
import { describe, it, expect } from "vitest";
import { ratioReading, type RatioItem, type RatioPoint } from "./dashboardKit";

const MONTH_ENDS = ["2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
const months = (values: number[]): RatioPoint[] =>
  values.map((amount, i) => ({ period_end_date: MONTH_ENDS[i], period_type: "monthly", amount }));
const annual = (end: string, amount: number): RatioPoint => ({ period_end_date: end, period_type: "annual", amount });

const SALES = months([114753515, 145782245, 129205363, 153658084, 174287219, 178309765]);
const PBITDA = months([14921215, 24878794, -3466390, 25879599, 7745169, 17443915]);
const APP_TOTAL = months([350378236.85, 342584616.4, 330074452.77, 372489751.93, 432093973.74, 408713499.09]);
const DEBTORS = months([166673281, 171431682, 147677695, 171133467, 228701117, 244478363]);
// The sheet's own monthly ROI (PBITDA × 12 ÷ Application of Funds).
const SHEET_ROI = months([0.5110322536, 0.8714504788, -0.1260221130, 0.8337281399, 0.2150967929, 0.5121606711]);

const roi = (extra: { pbitda?: RatioPoint[]; app?: RatioPoint[] } = {}): RatioItem => ({
  line_key: "ratios/profitability_ratio/return_on_investment", line_label: "Return on Investment", item_no: 1,
  series: SHEET_ROI,
  derive: {
    kind: "return",
    num: { label: "PBITDA", series: extra.pbitda ?? PBITDA },
    den: [{ sign: 1, label: "Application of Funds", series: extra.app ?? APP_TOTAL }],
  },
});
const growth = (series: RatioPoint[]): RatioItem => ({
  line_key: "ratios/growth_ratio/sales_growth", line_label: "Sales Growth", item_no: 1,
  series: [], derive: { kind: "growth", base: { label: "Sales", series } },
});

describe("return ratios", () => {
  it("shows the sheet's own number in the monthly view", () => {
    expect(ratioReading(roi(), "monthly", "Sep 2026")).toEqual({ value: 0.5121606711, basis: null });
  });

  it("reproduces the sheet exactly for a one-month bucket", () => {
    const julOnly = roi({ pbitda: PBITDA.slice(3, 4), app: APP_TOTAL.slice(3, 4) });
    expect(ratioReading(julOnly, "quarterly", "Q2 FY27").value).toBeCloseTo(0.8337281399, 9);
  });

  it("annualises the quarter's own PBITDA instead of reusing its last month", () => {
    const q2 = ratioReading(roi(), "quarterly", "Q2 FY27");
    expect(q2.value).toBeCloseTo(0.49980, 5);
    // en-GB abbreviates September as "Sep" or "Sept" depending on the ICU build.
    expect(q2.basis).toMatch(/^PBITDA ×12\/3 ÷ Application of Funds at 30 Sept? 2026$/);
    // Q1 is not June's −12.6%: the quarter as a whole was profitable.
    expect(ratioReading(roi(), "quarterly", "Q1 FY27").value).toBeCloseTo(0.44031, 5);
  });

  it("annualises a part-year by the months it covers", () => {
    const fy = ratioReading(roi(), "yearly", "FY 26-27");
    expect(fy.value).toBeCloseTo(0.42769, 5);
    expect(fy.basis).toContain("×12/6");
  });

  it("does not apply ×12 to a full year from the yearly file", () => {
    // The yearly file's own cell reads 4.11 (411%) — the monthly ×12 on annual PBITDA.
    const item = roi({ pbitda: [annual("2026-03-31", 115268025)], app: [annual("2026-03-31", 336286378)] });
    const fy = ratioReading(item, "yearly", "FY 25-26");
    expect(fy.value).toBeCloseTo(0.34277, 5);
    expect(fy.basis).toBe("PBITDA ÷ Application of Funds at 31 Mar 2026");
  });
});

describe("turnover days", () => {
  const recv: RatioItem = {
    line_key: "ratios/eficiency_ratio/recv_turnover_in_days", line_label: "Recv. Turnover in days", item_no: 1,
    series: [],
    derive: { kind: "days", terms: [{ sign: 1, stock: { label: "Sundry Debtors", series: DEBTORS }, flow: { label: "Sales", series: SALES } }] },
  };

  it("uses closing debtors over the quarter's sales, 30 days a month", () => {
    const q2 = ratioReading(recv, "quarterly", "Q2 FY27");
    expect(q2.value).toBeCloseTo(43.4624, 4);
    expect(q2.basis).toBe("Closing Sundry Debtors × 90 days ÷ Sales");
  });

  it("counts 360 days for a full year from the yearly file", () => {
    const yearly: RatioItem = { ...recv, derive: { kind: "days", terms: [{
      sign: 1,
      stock: { label: "Sundry Debtors", series: [annual("2026-03-31", 155701752)] },
      flow: { label: "Sales", series: [annual("2026-03-31", 1381303407)] },
    }] } };
    expect(ratioReading(yearly, "yearly", "FY 25-26").value).toBeCloseTo(40.5795, 4);
  });
});

describe("growth ratios", () => {
  it("compares the quarter with the previous quarter, not Sep with Aug", () => {
    const q2 = ratioReading(growth(SALES), "quarterly", "Q2 FY27");
    expect(q2.value).toBeCloseTo(0.299, 3);
    expect(q2.basis).toBe("Sales, Q2 FY27 vs Q1 FY27");
  });

  it("shows nothing for a year still in progress rather than a fake collapse", () => {
    const series = [...SALES, annual("2026-03-31", 1381303407)];
    expect(ratioReading(growth(series), "yearly", "FY 26-27"))
      .toEqual({ value: null, basis: "FY 26-27 in progress (6 of 12 months)" });
  });

  it("compares two full years", () => {
    const series = [annual("2025-03-31", 509486036), annual("2026-03-31", 1381303407)];
    expect(ratioReading(growth(series), "yearly", "FY 25-26").value).toBeCloseTo(1.711, 3);
  });

  it("skips over no gap: the previous bucket must be the one immediately before", () => {
    const series = [annual("2024-03-31", 400000000), annual("2026-03-31", 1381303407)];
    expect(ratioReading(growth(series), "yearly", "FY 25-26"))
      .toEqual({ value: null, basis: "No previous year to compare" });
    expect(ratioReading(growth(SALES), "quarterly", "Q1 FY27"))
      .toEqual({ value: null, basis: "No previous quarter to compare" });
  });

  it("gives no % change off a negative base", () => {
    const series = [annual("2025-03-31", -5000000), annual("2026-03-31", 115268025)];
    expect(ratioReading(growth(series), "yearly", "FY 25-26"))
      .toEqual({ value: null, basis: "FY 24-25 Sales was zero or negative" });
  });
});

describe("balance-only ratios", () => {
  const current: RatioItem = {
    line_key: "ratios/liquidity_ratio/current_ratio", line_label: "Current Ratio", item_no: 1,
    series: months([1.1, 1.0, 1.0, 1.12, 1.48, 1.11]),
  };

  it("keeps the period-end figure for a quarter", () => {
    expect(ratioReading(current, "quarterly", "Q2 FY27").value).toBe(1.11);
  });

  it("shows nothing for a period it has no figure for, not another period's", () => {
    expect(ratioReading(current, "monthly", "Oct 2026").value).toBeNull();
  });
});
