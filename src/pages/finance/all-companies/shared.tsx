// Shared pieces for the All Companies view — the payload types, money cells and
// the period empty state every section uses.
import type { ReactNode } from "react";
import { EmptyState, fmtAsAt, type FinLineItem, type RatioCat, type TimelineInput } from "../dashboardKit";
import { formatCompact, formatINR } from "../format";

export type Series = (TimelineInput & { percent?: number | null })[];

export type WcKey = "cash" | "inventory" | "debtors" | "current_assets" | "creditors" | "current_liabilities" | "nwc";

export interface SalesChannel { key: string; label: string; item_no: number; series: Series }

/** An admin-set tag on each company; null until someone categorises it. */
export type CompanyGroup = "amato" | "other";

export const COMPANY_GROUP_LABELS: Record<CompanyGroup, string> = {
  amato: "Amato Group",
  other: "Other",
};

export const COMPANY_GROUP_OPTIONS = (Object.keys(COMPANY_GROUP_LABELS) as CompanyGroup[])
  .map((g) => ({ value: g, label: COMPANY_GROUP_LABELS[g] }));

export interface ConsolidatedCompany {
  id: string;
  label: string;
  company_group: CompanyGroup | null;
  /** The sheet tab's name ("AMATO SRN") — short enough for a column header. */
  short_label: string;
  pl: { sales: Series; gross: Series; pbitda: Series; pat: Series };
  bs: { sources: Series; application: Series };
  wc: Record<WcKey, Series>;
  sales_channels: SalesChannel[];
  sales_total: Series;
  ratios: RatioCat[];
  /** The P&L part of the company's Budget block, or null when its sheet has none. */
  budget: { lines: FinLineItem[]; actuals: Record<string, { basis: string; series: Series }> } | null;
}

// formatCompact deliberately returns an unsigned magnitude, so a loss-making
// company would otherwise read as a profit here. Sign it explicitly.
export function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return `${n < 0 ? "−" : ""}${formatCompact(n)}`;
}

export function fmtExact(n: number | null): string | undefined {
  return n == null ? undefined : formatINR(n);
}

export function Th({ children, align = "right", className = "" }:
  { children: ReactNode; align?: "left" | "right" | "center"; className?: string }) {
  return (
    <th className={`px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-gray-500 text-${align} whitespace-nowrap ${className}`}>
      {children}
    </th>
  );
}

/** A right-aligned money cell. Tabular figures in consistent units compare fine
 *  down a column on their own — the exact rupee value sits in the hover title. */
export function MoneyTd({ value, sub }: { value: number | null; sub?: string | null }) {
  return (
    <td className="px-4 py-3 text-right align-middle">
      <div className={`text-[13px] font-semibold tabular-nums ${value == null ? "text-gray-400" : "text-gray-800"}`} title={fmtExact(value)}>
        {fmtMoney(value)}
      </div>
      {sub && <div className="text-[11px] text-gray-500 tabular-nums">{sub}</div>}
    </td>
  );
}

// Display names can be full legal names ("Amato Automotive Pvt Ltd. -Consolidated
// of Amato Group"). The name may wrap — so it sits on one line where the table
// has room and folds only in a wide one (Working Capital) instead of pushing
// the figures off the edge.
export function CompanyTd({ label, className = "" }: { label: string; className?: string }) {
  return <td className={`px-4 py-3 text-[13px] font-semibold text-gray-800 leading-snug min-w-[11rem] ${className}`}>{label}</td>;
}

/** "12.3%" of a total — "0.0%" rather than "−0.0%" for a few rupees below zero. */
export function pctOf(v: number | null, total: number | null): string | null {
  if (v == null || total == null || total <= 0) return null;
  const pct = (v / total) * 100;
  return `${Math.abs(pct) < 0.05 ? "0.0" : pct.toFixed(1)}%`;
}

/** The one date every row shares, or null when companies report to different
 *  months — then each row needs its own "as at". */
export function commonDate(dates: (string | null)[]): string | null {
  const set = new Set(dates.filter(Boolean));
  return set.size === 1 ? [...set][0]! : null;
}

export const rowBg = (i: number) => (i % 2 === 0 ? "bg-white" : "bg-[#FAF7F1]/40");

/** Table shell shared by every section, so they all scroll and frame alike. */
export function TableCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="bg-white border border-[#EAE3D6] rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">{children}</table>
      </div>
      {footer && <div className="px-4 py-3 border-t border-[#EAE3D6] text-[11px] text-gray-500">{footer}</div>}
    </div>
  );
}

/**
 * "Nothing in this window" vs "nothing at all" — and when it is the window, a
 * one-click way back to the latest period that does have figures.
 */
export function PeriodEmpty({ what, bucket, latest, onJump }:
  { what: string; bucket: string; latest: string | null; onJump: (label: string) => void }) {
  if (!latest) return <EmptyState>No {what} yet.</EmptyState>;
  return (
    <EmptyState>
      No {what} for {bucket || "this period"}.{" "}
      <button onClick={() => onJump(latest)} className="font-semibold text-brand-orange hover:underline">
        Show {latest}
      </button>
    </EmptyState>
  );
}

export const asAtText = (iso: string | null) => fmtAsAt(iso) || "—";

// Company names on a chart axis are text people read, so they sit on the
// gray-600 floor rather than the paler stone used for numeric ticks.
export const CHART_NAME_COLOR = "#4B5563";

/** The hover card every chart on this page uses. */
export function TipBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-white border border-[#EAE3D6] rounded-xl shadow-lg px-3 py-2 text-[12px] min-w-[220px]">
      <div className="font-bold text-gray-800 mb-1">{title}</div>
      {children}
    </div>
  );
}

/**
 * One row of a bar list: the company's name and its figure on one line, the bar
 * on the next. Built from divs rather than a chart axis so a long name gets the
 * full width of the card instead of a fixed-width axis that wraps it into a
 * stack. Hovering shows `hover` beneath the row.
 */
export function BarRow({ name, value, hover, children }:
  { name: string; value: ReactNode; hover?: ReactNode; children: ReactNode }) {
  return (
    <div className="group relative">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-[12px] font-semibold text-gray-700 truncate" title={name}>{name}</span>
        <span className="text-[12px] font-bold text-gray-800 tabular-nums shrink-0">{value}</span>
      </div>
      {children}
      {hover && (
        <div className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden group-hover:block">{hover}</div>
      )}
    </div>
  );
}
