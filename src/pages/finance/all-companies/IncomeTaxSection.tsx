// Income tax across companies — the Income Tax Budget block at the foot of each
// company's tab. Read as each company's own Budget tab reads it: running
// positions, so a period shows its closing month and is never summed.
import { useMemo } from "react";
import { bucketLabelsOf, bucketValue } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { slugOf } from "../budgetMath";
import { CompanyTd, MoneyTd, PeriodEmpty, TOTAL_ROW, TableCard, Th, TotalLabelTd, TotalMoneyTd, rowBg, type ConsolidatedCompany } from "./shared";
import { sumTogether } from "./totals";

// Keyed on the slug of the sheet's own label (spelling "Accumlated" included).
export const INCOME_TAX_COLUMNS = [
  { slug: "accumlated_pbt", label: "Accumulated PBT" },
  { slug: "accumlated_income_tax", label: "Accumulated Income Tax" },
  { slug: "tds_tcs_advance_tax_deposited", label: "TDS/TCS & Advance Tax Deposited" },
  { slug: "pending_tax_liability", label: "Pending Tax Liability" },
];

export default function IncomeTaxSection({ companies, view, bucket, onJump }:
  { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; onJump: (label: string) => void }) {
  const withTax = companies.filter((c) => (c.budget?.tax.length ?? 0) > 0);
  const without = companies.filter((c) => !withTax.includes(c)).map((c) => c.label);

  const rows = useMemo(() => withTax.map((c) => ({
    id: c.id,
    label: c.label,
    rollup: c.is_rollup,
    values: INCOME_TAX_COLUMNS.map((col) => {
      const it = c.budget!.tax.find((li) => slugOf(li.line_key) === col.slug);
      return it ? bucketValue(it.series, "stock", view, bucket) : null;
    }),
  })), [withTax, view, bucket]);

  // The four figures are tied (accumulated tax - tax deposited = tax pending), so
  // they are summed over the same companies - the total then ties as well.
  const totalled = rows.filter((r) => !r.rollup);
  const total = sumTogether(totalled.map((r) => r.values));

  const latest = useMemo(() => {
    const labels = bucketLabelsOf(withTax.flatMap((c) => c.budget!.tax.flatMap((li) => li.series)), "stock", view);
    return labels[labels.length - 1] ?? null;
  }, [withTax, view]);

  if (withTax.length === 0) return <PeriodEmpty what="income tax figures" bucket={bucket} latest={null} onJump={onJump} />;
  if (rows.every((r) => r.values.every((v) => v == null))) {
    return <PeriodEmpty what="income tax figures" bucket={bucket} latest={latest} onJump={onJump} />;
  }

  return (
    <TableCard footer={
      <>A running position, so each company shows its last month in {bucket}, not a sum. Pending tax liability is the tax
        accumulated so far less TDS/TCS and advance tax already deposited. Same reading as each company's Budget tab. The Total adds the four figures over the companies that report all of them.
        {without.length > 0 && <> No income tax block in the sheet yet: {without.join(", ")}.</>}</>
    }>
      <thead>
        <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
          <Th align="left">Company</Th>
          {INCOME_TAX_COLUMNS.map((col) => <Th key={col.slug}>{col.label}</Th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id} className={rowBg(i)}>
            <CompanyTd label={r.label} rollup={r.rollup} />
            {r.values.map((v, ci) => <MoneyTd key={INCOME_TAX_COLUMNS[ci].slug} value={v} />)}
          </tr>
        ))}
      </tbody>
      {totalled.length > 0 && (
        <tfoot>
          <tr className={TOTAL_ROW}>
            <TotalLabelTd count={totalled.length} excluded={rows.length - totalled.length} />
            {INCOME_TAX_COLUMNS.map((col, ci) => (
              <TotalMoneyTd key={col.slug} value={total.values[ci] ?? null} n={total.n} of={totalled.length} />
            ))}
          </tr>
        </tfoot>
      )}
    </TableCard>
  );
}
