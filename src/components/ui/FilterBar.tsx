import { RefreshCw, Printer, X } from "lucide-react";

/**
 * THE filter bar for every module. See CLAUDE.md § "Filters and selectors" for
 * the rules this component exists to enforce.
 *
 * It exists because the app grew three different filter idioms — OE Network's
 * inline bar, Sales/Leads' collapsible panel, Finance's in-body company picker —
 * and even inside one module the tabs disagreed on the order of the dropdowns,
 * the label for the same field ("Rep" vs "Salesperson"), which action buttons
 * appeared, and whether the right-hand group was aligned by `ml-auto` on a
 * wrapper or on the button. Every one of those was a local choice made by hand.
 * Nothing here is new styling: it is the existing look, extracted once so it
 * cannot drift again.
 *
 * Layout is fixed:  [ filters … ]  [ Clear ] [ spinner ]        [ actions ]
 */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="no-print sticky top-0 z-30 -mx-6 px-6 py-2.5 bg-white/85 backdrop-blur-md border-b border-orange-50">
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

/**
 * The right-hand action group. ALWAYS wrap the buttons in this rather than
 * putting `ml-auto` on the first button — the two produce different spacing
 * when the bar wraps, which is why the action rows never lined up between tabs.
 */
export function FilterActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 ml-auto">{children}</div>;
}

/** Shown only when at least one filter is set. Same treatment in every module. */
export function ClearFilters({ onClear, show = true }: { onClear: () => void; show?: boolean }) {
  if (!show) return null;
  return (
    <button onClick={onClear}
      className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-red-500">
      <X size={12} /> Clear
    </button>
  );
}

/** In-bar "a request is in flight" indicator. Never a full-page spinner: the
 *  numbers already on screen stay readable while the new ones load. */
export function FilterSpinner({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />;
}

const GHOST_BTN =
  "flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-xl border border-gray-200 "
  + "hover:border-orange-200 disabled:opacity-50 transition-all";

/** Re-fetch the current view from our own API. Never pulls Google Sheets — that
 *  is Sync, and conflating the two is why users hit Sync to refresh a chart. */
export function RefreshButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`${GHOST_BTN} text-gray-500 hover:text-brand-orange`}
      title="Re-fetch this view (and its filters) from the server — no Google Sheets pull">
      <RefreshCw size={11} /> Refresh
    </button>
  );
}

export function PdfButton() {
  return (
    <button onClick={() => window.print()}
      className={`${GHOST_BTN} text-gray-600 hover:text-brand-orange`}
      title="Print this view or save it as a PDF">
      <Printer size={12} /> PDF
    </button>
  );
}

/** The only button that talks to Google Sheets. Solid orange because it is the
 *  one destructive-ish, slow action in the bar. */
export function SyncButton({ onClick, syncing, title }: {
  onClick: () => void; syncing: boolean; title?: string;
}) {
  return (
    <button onClick={onClick} disabled={syncing} title={title}
      className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all">
      {syncing
        ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
        : <><RefreshCw size={11} /> Sync</>}
    </button>
  );
}

/**
 * Canonical filter vocabulary. One label per concept, app-wide — import these
 * rather than typing the string, so "Rep"/"ASM"/"Owner" can never re-appear as
 * a third name for the person a record belongs to.
 *
 * `placeholder` is the singular field name shown when nothing is chosen;
 * `all` is the first option in the list, which clears the filter.
 */
export const FILTER_LABELS = {
  salesperson: { placeholder: "Salesperson", all: "All salespersons" },
  oem:         { placeholder: "OEM",         all: "All OEMs" },
  state:       { placeholder: "State",       all: "All states" },
  city:        { placeholder: "City",        all: "All cities" },
  region:      { placeholder: "Region",      all: "All regions" },
  product:     { placeholder: "Product",     all: "All products" },
  mode:        { placeholder: "Mode",        all: "Visits + Calls" },
  company:     { placeholder: "Company",     all: "All companies" },
  country:     { placeholder: "Country",     all: "All countries" },
  customerType:{ placeholder: "Customer type", all: "All customer types" },
  stage:       { placeholder: "Stage",       all: "All stages" },
  status:      { placeholder: "Status",      all: "All statuses" },
} as const;

/** The `<Select>` options for a filter: the "all" row first, then the values. */
export const toOpts = (arr: string[] | undefined, all: string) =>
  [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];

/** Shorthand for the common case — `filterOpts(options?.oems, "oem")`. */
export const filterOpts = (arr: string[] | undefined, key: keyof typeof FILTER_LABELS) =>
  toOpts(arr, FILTER_LABELS[key].all);
