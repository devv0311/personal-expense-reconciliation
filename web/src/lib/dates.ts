/** Small date helpers for the period picker — never touches money, so nothing here is financial. */

/** `Date` → `"YYYY-MM-DD"`, for an `<input type="date">` value, in UTC (no local-timezone drift). */
export function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `"YYYY-MM-DD"` → an ISO-8601 timestamp at UTC midnight, what the API's period fields expect. */
export function fromDateInputValue(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

/** The current month's period as `[start, end)`, both as date-input values. */
export function currentMonthPeriod(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: toDateInputValue(start), end: toDateInputValue(end) };
}

/** The named windows the outcome screens offer. Calendar choices, never financial ones. */
export const SPENDING_WINDOWS = [
  "this_month",
  "last_month",
  "last_3_months",
  "last_12_months",
] as const;
export type SpendingWindow = (typeof SPENDING_WINDOWS)[number];

/** How many calendar months each window spans, so a trend can cover exactly the same ones. */
export const spendingWindowMonths: Record<SpendingWindow, number> = {
  this_month: 1,
  last_month: 1,
  last_3_months: 3,
  last_12_months: 12,
};

export const spendingWindowLabel: Record<SpendingWindow, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  last_12_months: "Last 12 months",
};

/**
 * One named window as `[start, end)` date-input values.
 *
 * Choosing which months to ask the API about is a calendar decision, not a financial one — the
 * API makes the same one when no period is given (`currentMonthPeriod` there), and every figure
 * inside the window is still the ledger's. `end` is exclusive everywhere in this system, so a
 * window ends on the first day after it.
 */
export function spendingWindowPeriod(
  window: SpendingWindow,
  now: Date = new Date(),
): { start: string; end: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startOfThisMonth = Date.UTC(year, month, 1);
  switch (window) {
    case "last_month":
      return {
        start: toDateInputValue(new Date(Date.UTC(year, month - 1, 1))),
        end: toDateInputValue(new Date(startOfThisMonth)),
      };
    case "last_3_months":
      return {
        start: toDateInputValue(new Date(Date.UTC(year, month - 2, 1))),
        end: toDateInputValue(new Date(Date.UTC(year, month + 1, 1))),
      };
    case "last_12_months":
      return {
        start: toDateInputValue(new Date(Date.UTC(year, month - 11, 1))),
        end: toDateInputValue(new Date(Date.UTC(year, month + 1, 1))),
      };
    case "this_month":
      return currentMonthPeriod(now);
  }
}

export function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  // periodEnd is exclusive, so the human-readable range shows the last included day.
  const lastIncluded = new Date(new Date(endIso).getTime() - 1);
  const fmt = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${fmt.format(start)} – ${fmt.format(lastIncluded)}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A date on its own, in the ledger's `en-IN` UTC convention — `5 Aug 2026`. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** `Date` → the `datetime-local`-free ISO instant the API's timestamp fields expect. */
export function nowIso(): string {
  return new Date().toISOString();
}
