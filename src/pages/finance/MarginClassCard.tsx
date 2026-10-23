import { Card } from "./dashboardKit";
import { formatKpi, formatINR } from "./format";
import { MARGIN_BANDS, classifyMargin, netPatMargin } from "./margin";

/** Turnover → Net PAT % → band, beside the key it was read from, for the
 *  period selected at the top (month, quarter or year). */
export function MarginClassCard({ sales, pat, bucket }: { sales: number | null; pat: number | null; bucket: string }) {
  const margin = netPatMargin(sales, pat);
  const band = classifyMargin(margin);

  const tiles: { label: string; value: string; title?: string }[] = [
    { label: `Turnover · ${bucket}`, value: sales != null ? formatKpi(sales) : "—", title: sales != null ? formatINR(sales) : undefined },
    { label: "Net PAT %", value: margin != null ? `${(margin * 100).toFixed(1)}%` : "—" },
    { label: "Net PAT", value: pat != null ? formatKpi(pat) : "—", title: pat != null ? formatINR(pat) : undefined },
  ];

  return (
    <Card title="Margin Classification"
      note={`Net PAT % = PAT ÷ Turnover (Sales) for ${bucket || "the selected period"}. Lower bands are thinner margins or losses — Black is a loss deeper than 4% of sales; Blue is a margin above 12%.`}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-3 content-start">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-[#EAE3D6] p-4" title={t.title}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{t.label}</div>
              <div className={`text-2xl font-bold mt-1 tracking-tight ${t.value === "—" ? "text-gray-400" : "text-gray-900"}`}>{t.value}</div>
            </div>
          ))}
          <div className="rounded-xl p-4 flex flex-col justify-center"
            style={band ? { background: band.bg, color: band.fg } : undefined}>
            <div className={`text-[10px] font-bold uppercase tracking-wider ${band ? "opacity-80" : "text-gray-500"}`}>Classification</div>
            <div className={`text-2xl font-bold mt-1 tracking-tight ${band ? "" : "text-gray-400"}`}>{band?.label ?? "—"}</div>
          </div>
          {margin == null && (
            <p className="col-span-2 text-[11px] text-gray-500">No turnover recorded for {bucket || "this period"}, so there is no margin to classify.</p>
          )}
        </div>

        <table className="w-full text-[12px] border-collapse self-start">
          <thead>
            <tr className="border-b-2 border-gray-200 text-gray-500">
              <th className="text-left py-2 pr-3 font-semibold">Margin range</th>
              <th className="text-left py-2 px-3 font-semibold">Classification</th>
              <th className="text-left py-2 pl-3 font-semibold">Applies to {bucket || "period"}?</th>
            </tr>
          </thead>
          <tbody>
            {MARGIN_BANDS.map((b) => {
              const current = band?.key === b.key;
              return (
                <tr key={b.key} className="border-b border-gray-100">
                  <td className={`py-1.5 pr-3 ${current ? "font-semibold text-gray-900" : "text-gray-600"}`}>{b.range}</td>
                  <td className="py-1.5 px-3">
                    <span className="inline-block min-w-[88px] text-center rounded-md px-2 py-0.5 font-semibold" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
                  </td>
                  <td className="py-1.5 pl-3">
                    {current && <span className="font-bold text-gray-900">● Current</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
