"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ReasonRow } from "@/components/annotations";
import { Money } from "@/components/money";
import { ReviewItemInspector } from "@/components/review/inspectors";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { isTypingTarget, useShortcutSection } from "@/components/app-shell/shortcuts";
import { formatDate } from "@/lib/dates";
import { reviewKindDescription, reviewKindLabel, reviewReasonLabel } from "@/lib/labels";
import { useReviewQueue } from "@/lib/queries";
import { REVIEW_ITEM_KINDS, type ReviewItemKind, type ReviewQueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY_ITEMS: readonly ReviewQueueItem[] = [];

/**
 * The triage inbox: what is waiting, in the order the domain says to look at it.
 *
 * The order is `domain.prioritiseReviewQueue`'s and is never re-sorted here — a surface that
 * re-ranked the queue would be disagreeing with the states it is describing (ADR-0029).
 *
 * Keyboard triage is `j`/`k` to move and `Enter` to open. Deliberately **no** single-key
 * accept: every decision in this product is a button pressed after reading a dialog that says
 * what it does (ADR-0049). Moving the selection is safe; approving from a list is not.
 */
export function ReviewQueue({ kind }: { kind: ReviewItemKind | null }) {
  const filter = useMemo(
    () => (kind === null ? { limit: 50 } : { kinds: [kind] as const, limit: 50 }),
    [kind],
  );
  const queue = useReviewQueue(filter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useShortcutSection({
    title: "Review queue",
    shortcuts: [
      { keys: "j", description: "Select the next item" },
      { keys: "k", description: "Select the previous item" },
      { keys: "Enter", description: "Open the selected item's inspector" },
      { keys: "Esc", description: "Clear the selection" },
    ],
  });

  // Memoised so the keyboard listener below is not rebound on every render, and derived so an
  // empty list is one identity rather than a new `[]` each time.
  const items = useMemo(() => queue.data?.items ?? EMPTY_ITEMS, [queue.data]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k" && event.key !== "Enter" && event.key !== "Escape") return;
      if (items.length === 0) return;

      if (event.key === "Escape") {
        setSelectedId(null);
        return;
      }
      if (event.key === "Enter") {
        // Enter only *opens*; there is nothing to open when nothing is selected.
        if (selectedId !== null) {
          event.preventDefault();
          focusInspector();
        }
        return;
      }

      event.preventDefault();
      const currentIndex = items.findIndex((item) => item.id === selectedId);
      const nextIndex =
        key === "j" ? Math.min(currentIndex + 1, items.length - 1) : Math.max(currentIndex - 1, 0);
      const next = items[currentIndex === -1 ? 0 : nextIndex];
      if (next !== undefined) {
        setSelectedId(next.id);
        listRef.current
          ?.querySelector<HTMLElement>(`[data-item-id="${cssEscape(next.id)}"]`)
          ?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items, selectedId]);

  if (queue.isPending) {
    return (
      <LoadingStatus label="Loading the review queue…">
        <TableSkeleton columns={3} rows={5} />
      </LoadingStatus>
    );
  }
  if (queue.isError) {
    return <ErrorBlock error={queue.error} onRetry={() => void queue.refetch()} />;
  }
  if (items.length === 0) {
    return (
      <EmptyBlock>
        Nothing is waiting for a decision
        {kind === null ? "" : ` of this kind`}. That is the queue being empty, not a filter hiding
        something — the counts above are the whole ledger.
      </EmptyBlock>
    );
  }

  // Derived, never cleared by an effect: an id whose item a decision has just removed from the
  // queue simply resolves to `null`, and the inspector goes back to its prompt.
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
      <ul ref={listRef} className="flex flex-col" aria-label="Items waiting for a decision">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-item-id={item.id}
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => {
                setSelectedId(item.id);
                focusInspector();
              }}
              className={cn(
                "w-full border-b border-rule px-2 py-3 text-left transition-colors last:border-b-0",
                item.id === selectedId ? "bg-accent-bg" : "hover:bg-accent-bg/50",
              )}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-meta text-ink-muted">{reviewKindLabel(item.kind)}</span>
                <Money paise={item.amount} className="text-meta" />
              </span>
              <span className="mt-0.5 block text-body text-ink">{itemTitle(item)}</span>
              <span className="mt-0.5 block text-micro text-ink-faint">
                {formatDate(item.occurredAt)}
              </span>
              <ReasonRow reasons={item.reasons} label={reviewReasonLabel} />
            </button>
          </li>
        ))}
      </ul>

      <div id="review-inspector" tabIndex={-1} className="min-w-0">
        {selected === null ? (
          <EmptyBlock>
            Choose an item to see everything the ledger knows about it. Nothing is decided until you
            press a button in a dialog that says what it does.
          </EmptyBlock>
        ) : (
          <>
            <div className="mb-4 border-b border-rule pb-3">
              <h2 className="text-emphasis font-medium text-ink">
                {reviewKindLabel(selected.kind)}
              </h2>
              <p className="mt-1 text-meta text-ink-muted">
                {reviewKindDescription(selected.kind)}
              </p>
            </div>
            <ReviewItemInspector item={selected} />
          </>
        )}
      </div>
    </div>
  );
}

/** The counts per kind, before any limit — the queue's own badge numbers. */
export function ReviewCounts({
  counts,
  active,
  onSelect,
}: {
  counts: Readonly<Record<ReviewItemKind, number>>;
  active: ReviewItemKind | null;
  onSelect: (kind: ReviewItemKind | null) => void;
}) {
  const total = REVIEW_ITEM_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2" role="group" aria-label="Filter by kind">
      <FilterButton
        label="Everything"
        count={total}
        active={active === null}
        onClick={() => onSelect(null)}
      />
      {REVIEW_ITEM_KINDS.map((kind) => (
        <FilterButton
          key={kind}
          label={reviewKindLabel(kind)}
          count={counts[kind] ?? 0}
          active={active === kind}
          onClick={() => onSelect(kind)}
        />
      ))}
    </div>
  );
}

function FilterButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "border-b-2 pb-1 text-body transition-colors",
        active
          ? "border-accent font-medium text-ink"
          : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {label}{" "}
      <span className={cn("font-mono text-meta", count > 0 ? "text-attention" : "text-ink-faint")}>
        {count}
      </span>
    </button>
  );
}

function itemTitle(item: ReviewQueueItem): string {
  switch (item.kind) {
    case "classification_decision":
      return item.payment.description;
    case "possible_duplicate":
      return item.payment.description;
    case "rejected_classification":
      return item.payment.description;
    case "unmatched_evidence":
      return item.observation?.observedMerchantText ?? "A document attached to nothing";
  }
}

function focusInspector(): void {
  document.getElementById("review-inspector")?.focus();
}

/** `CSS.escape` is not implemented in jsdom; a UUID needs no escaping, so this is enough. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
