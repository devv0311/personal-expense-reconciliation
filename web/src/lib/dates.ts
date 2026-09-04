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
