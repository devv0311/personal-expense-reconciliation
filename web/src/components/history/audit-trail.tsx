"use client";

import { formatDateTime } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import type { AuditTrailEvent } from "@/lib/types";

/**
 * The append-only log over one record, read back.
 *
 * Oldest first, in the log's own monotonic order rather than by timestamp: events written
 * back-to-back inside one audited unit of work tie on a millisecond clock, and a history whose
 * order is arbitrary is not a history.
 *
 * Every event carries who, when, from what, to what, and why. The old and new values are shown
 * as the log stored them — this component does not interpret them, because an interpretation of
 * an audit event is exactly the thing an audit trail exists to be checked against.
 */
export function AuditTrail({ events }: { events: readonly AuditTrailEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-body text-ink-muted">
        Nothing has been recorded against this yet. That is an answer, not a gap.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li
          key={`${event.entityType}-${event.entityId}-${event.sequence}`}
          className="border-b border-rule py-3 last:border-b-0"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="text-body text-ink">
              {sentenceCase(event.action)} · {sentenceCase(event.entityType)}
            </span>
            <span className="tabular font-mono text-meta text-ink-muted">
              {formatDateTime(event.occurredAt)}
            </span>
          </div>
          <p className="mt-0.5 text-meta text-ink-muted">
            by {event.actor}
            {event.source === null ? "" : ` · ${event.source}`}
          </p>
          {event.reason !== null && (
            <p className="mt-1 text-meta text-ink">&ldquo;{event.reason}&rdquo;</p>
          )}
          <ValueChange oldValue={event.oldValue} newValue={event.newValue} />
        </li>
      ))}
    </ol>
  );
}

/** What changed, as the log recorded it. Rendered verbatim, never re-interpreted. */
function ValueChange({ oldValue, newValue }: { oldValue: unknown; newValue: unknown }) {
  const before = describe(oldValue);
  const after = describe(newValue);
  if (before === null && after === null) return null;
  return (
    <dl className="mt-1.5 flex flex-col gap-1 text-micro">
      {before !== null && (
        <div className="flex gap-2">
          <dt className="text-ink-faint">Was</dt>
          <dd className="font-mono break-all text-ink-muted">{before}</dd>
        </div>
      )}
      {after !== null && (
        <div className="flex gap-2">
          <dt className="text-ink-faint">Became</dt>
          <dd className="font-mono break-all text-ink">{after}</dd>
        </div>
      )}
    </dl>
  );
}

function describe(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
