// "Draw the chart up to the period picked, and no further."
//
// Every Finance view has a period picker (monthly / quarterly / yearly + a
// month, quarter or year). The sheet, though, is usually ahead of what has been
// reported — finance adds next month's column before filling it, or fills part of
// it. A chart that runs to the end of the data then shows a month the picker is
// not on, and often a half-empty one that drags every line down.
//
// So each chart ends at the picked period. Picking a later period extends it.
//
// Periods are told apart by date, not by position in a list, because a chart's
// own x-axis may not contain the picked label at all (a series that stops
// earlier). The labels the charts use are exactly the three buildTimeline makes:
//   "Sep 2026"   a month           -> its last day
//   "Q2 FY27"    a quarter of FY27 -> its last day (FY27 = Apr 2026 – Mar 2027)
//   "FY 26-27"   a financial year  -> 31 March 2027
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const iso = (y: number, monthIndex: number) => {
  // Day 0 of the next month is the last day of this one (UTC, so no time-zone drift).
  const d = new Date(Date.UTC(y, monthIndex + 1, 0));
  return d.toISOString().slice(0, 10);
};

/** The last day a period label covers, as YYYY-MM-DD — or null if it is not one of the three label forms. */
export function labelEnd(label: string): string | null {
  const month = /^([A-Z][a-z]{2}) (\d{4})$/.exec(label);
  if (month) {
    const m = MONTHS.indexOf(month[1]);
    return m >= 0 ? iso(Number(month[2]), m) : null;
  }
  const quarter = /^Q([1-4]) FY(\d{2})$/.exec(label);
  if (quarter) {
    const fyStart = 2000 + Number(quarter[2]) - 1;           // FY27 starts April 2026
    const q = Number(quarter[1]);
    return q === 4 ? iso(fyStart + 1, 2) : iso(fyStart, 2 + q * 3);   // Q1 Jun, Q2 Sep, Q3 Dec, Q4 Mar
  }
  const year = /^FY (\d{2})-(\d{2})$/.exec(label);
  if (year) return iso(2000 + Number(year[2]), 2);          // 31 March of the second year
  return null;
}

/** Is this period on or before the picked one? A label it cannot read, or no pick, keeps the period. */
export function keepUpTo(label: string, picked: string | undefined | null): boolean {
  if (!picked) return true;
  const cutoff = labelEnd(picked);
  const end = labelEnd(label);
  return cutoff == null || end == null || end <= cutoff;
}

/** Chart rows (one per period, each with a `label`) cut at the picked period. */
export function upToPicked<T extends { label?: unknown }>(rows: T[], picked: string | undefined | null): T[] {
  return picked ? rows.filter((r) => typeof r.label !== "string" || keepUpTo(r.label, picked)) : rows;
}
