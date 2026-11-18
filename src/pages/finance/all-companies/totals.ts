// Totals for the All Companies tables.
//
// A total is only right if it adds what can be added, once, over a stated set of
// companies. The three rules every section here follows:
//
//   1. A company with NO figure for the period contributes nothing — it is not
//      a zero. "Reported" is counted (`n`) and shown, so a total over 9 of 12
//      companies says so instead of passing as all twelve.
//   2. Figures that must agree with each other are summed over the SAME
//      companies (sumTogether). Sources and Application of funds, or accumulated
//      tax less tax deposited = tax pending: summed over different companies the
//      identity would fail on the total row even though every company's own row
//      is right.
//   3. A ratio is never added or averaged. A total margin is total PAT over total
//      Sales, built from the totals — see totalMargin.
//
// Roll-up companies (AMATO TOTAL) are filtered out by the caller before these
// run: they are already the sum of other rows, less inter-company sales.
import { netPatMargin } from "../margin";

export interface TotalCell {
  value: number | null;
  /** How many companies had a figure. */
  n: number;
}

export type Cell = number | null | undefined;

const present = (v: Cell): v is number => v != null && Number.isFinite(v);

/** Σ of the figures that exist. null — not 0 — when none do. */
export function sumColumn(values: Cell[]): TotalCell {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (present(v)) {
      sum += v;
      n += 1;
    }
  }
  return { value: n > 0 ? sum : null, n };
}

/**
 * Column totals over only the rows in which EVERY column has a figure, so the
 * columns describe the same companies and their identities hold on the total row.
 */
export function sumTogether(rows: Cell[][]): { values: (number | null)[]; n: number } {
  const complete = rows.filter((r) => r.length > 0 && r.every(present));
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const values = Array.from({ length: width }, (_, c) =>
    complete.length > 0 ? complete.reduce((s, r) => s + (r[c] as number), 0) : null);
  return { values, n: complete.length };
}

/** Total PAT margin: total PAT over total Sales for the companies that report
 *  both — never the average of the companies' own margins. */
export function totalMargin(rows: { sales: Cell; pat: Cell }[]): number | null {
  const t = sumTogether(rows.map((r) => [r.sales, r.pat]));
  return netPatMargin(t.values[0], t.values[1]);
}
