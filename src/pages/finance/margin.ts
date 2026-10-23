// Net PAT margin bands — management's own classification key (the finance
// team's sheet), so the colours are theirs, not the app palette. Each band
// includes its lower bound: exactly 4% is Orange, exactly 0% is Red.
export interface MarginBand {
  key: string;
  label: string;
  range: string;
  min: number;      // inclusive, as a fraction (0.04 = 4%)
  bg: string;
  fg: string;
}

export const MARGIN_BANDS: MarginBand[] = [
  { key: "black",   label: "Black",    range: "Below −4%",  min: -Infinity, bg: "#000000", fg: "#FFFFFF" },
  { key: "darkred", label: "Dark Red", range: "−4% to 0%",  min: -0.04,     bg: "#8B0000", fg: "#FFFFFF" },
  { key: "red",     label: "Red",      range: "0% to 4%",   min: 0,         bg: "#E00000", fg: "#FFFFFF" },
  { key: "orange",  label: "Orange",   range: "4% to 8%",   min: 0.04,      bg: "#FFA500", fg: "#1F2937" },
  { key: "green",   label: "Green",    range: "8% to 12%",  min: 0.08,      bg: "#00A049", fg: "#FFFFFF" },
  { key: "blue",    label: "Blue",     range: "Above 12%",  min: 0.12,      bg: "#0070C0", fg: "#FFFFFF" },
];

/** PAT ÷ Sales for one period, or null when there is no turnover to divide by. */
export function netPatMargin(sales: number | null, pat: number | null): number | null {
  if (sales == null || pat == null || sales <= 0) return null;
  return pat / sales;
}

export function classifyMargin(margin: number | null): MarginBand | null {
  if (margin == null || !Number.isFinite(margin)) return null;
  // Compare on the rounded percent the user reads, so a 3.996% shown as "4.0%"
  // doesn't sit in the band below the one its label implies.
  const shown = Math.round(margin * 1000) / 1000;
  let band = MARGIN_BANDS[0];
  for (const b of MARGIN_BANDS) if (shown >= b.min) band = b;
  return band;
}
