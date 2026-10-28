// Budget across companies — who is ahead of plan and who is behind, for the
// picked period. Each company is read exactly as its own Budget tab reads it
// (flowReading over the sheet's budget lines and their P&L actuals).
import { useMemo } from "react";
import { bucketLabelsOf } from "../dashboardKit";
import type { TrendView } from "../aggregate";
import { flowReading, slugOf } from "../budgetMath";
import { AchievementBar, tone } from "../BudgetView";
import { CompanyTd, PeriodEmpty, TableCard, Th, fmtMoney, rowBg, type ConsolidatedCompany } from "./shared";

// Revenue, then the two profit lines leadership tracks against plan.
const COLUMNS = [
  { slugs: ["revanue_income", "revenue_income"], label: "Revenue" },
  { slugs: ["pbitda"], label: "PBITDA" },
  { slugs: ["pat"], label: "PAT" },
];

export default function BudgetSection({ companies, view, bucket, onJump }:
  { companies: ConsolidatedCompany[]; view: TrendView; bucket: string; onJump: (label: string) => void }) {
  const budgeted = companies.filter((c) => c.budget && c.budget.lines.length > 0);
  const without = companies.filter((c) => !budgeted.includes(c)).map((c) => c.label);

  const rows = useMemo(() => budgeted.map((c) => ({
    id: c.id,
    label: c.label,
    cells: COLUMNS.map((col) => {
      const it = c.budget!.lines.find((li) => col.slugs.includes(slugOf(li.line_key)));
      return it ? flowReading(it.series, c.budget!.actuals[it.line_key]?.series, it.line_key, view, bucket) : null;
    }),
  })), [budgeted, view, bucket]);

  const latest = useMemo(() => {
    const labels = bucketLabelsOf(budgeted.flatMap((c) => c.budget!.lines.flatMap((li) => li.series)), "flow", view);
    return labels[labels.length - 1] ?? null;
  }, [budgeted, view]);

  if (budgeted.length === 0) {
    return <PeriodEmpty what="company budgets" bucket={bucket} latest={null} onJump={onJump} />;
  }
  if (rows.every((r) => r.cells.every((c) => c?.budget == null))) {
    return <PeriodEmpty what="budget figures" bucket={bucket} latest={latest} onJump={onJump} />;
  }

  return (
    <TableCard footer={
      <>Budget is from each company's Budget block; actual is what its P&L reports for {bucket} (Revenue = Sales Accounts).
        Achievement = actual ÷ budget — the tick marks 100%, green is ahead of plan. Same reading as each company's Budget tab.
        {without.length > 0 && <> No budget in the sheet yet: {without.join(", ")}.</>}</>
    }>
      <thead>
        <tr className="bg-[#FAF7F1]">
          <th />
          {COLUMNS.map((col) => (
            <th key={col.label} colSpan={2} className="px-4 pt-3 text-[10px] font-bold uppercase tracking-wider text-gray-600 text-center border-b border-[#EAE3D6]">{col.label}</th>
          ))}
        </tr>
        <tr className="border-b border-[#EAE3D6] bg-[#FAF7F1]">
          <Th align="left">Company</Th>
          {COLUMNS.map((col) => [
            <Th key={`${col.label}-v`}>Actual / Budget</Th>,
            <Th key={`${col.label}-a`} align="left">Achievement</Th>,
          ])}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id} className={rowBg(i)}>
            <CompanyTd label={r.label} />
            {r.cells.map((cell, ci) => [
              <td key={`${ci}-v`} className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                <div className="text-[13px] font-semibold" style={{ color: cell ? tone(cell) : undefined }}>{fmtMoney(cell?.actual ?? null)}</div>
                <div className="text-[11px] text-gray-500">of {fmtMoney(cell?.budget ?? null)}</div>
              </td>,
              <td key={`${ci}-a`} className="px-4 py-3">
                {cell ? <AchievementBar r={cell} /> : <span className="text-[11px] text-gray-400">—</span>}
              </td>,
            ])}
          </tr>
        ))}
      </tbody>
    </TableCard>
  );
}
