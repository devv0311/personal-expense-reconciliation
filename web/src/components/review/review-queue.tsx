"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReasonRow } from "@/components/annotations";
import { UnknownValue } from "@/components/facts";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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
  const [limit, setLimit] = useState(50);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const filter = useMemo(
    () => (kind === null ? { limit } : { kinds: [kind] as const, limit }),
    [kind, limit],
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

  useLayoutEffect(() => {
    if (inspectorOpen) focusInspector();
    else returnTo.current?.focus();
  }, [inspectorOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k" && event.key !== "Enter" && event.key !== "Escape") return;
      if (items.length === 0) return;

      if (event.key === "Escape") {
        setInspectorOpen(false);
        setSelectedId(null);
        return;
      }
      if (event.key === "Enter") {
        // Native links, buttons and disclosures own Enter; triage must not steal it.
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("a,button,summary") && !target.closest("[data-item-id]")) return;
        if (selectedId !== null) {
          event.preventDefault();
          returnTo.current = document.activeElement as HTMLElement;
          setInspectorOpen(true);
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
        setInspectorOpen(false);
        setSelectedId(next.id);
        const row = listRef.current?.querySelector<HTMLElement>(
          `[data-item-id="${cssEscape(next.id)}"]`,
        );
        returnTo.current = row ?? null;
        row?.focus();
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
        {kind === null
          ? "Nothing is waiting for a decision. This describes the review queue, not whether your accounts reconcile."
          : "No items of this kind are waiting. Choose Everything to see the rest of your queue."}
      </EmptyBlock>
    );
  }

  // Derived, never cleared by an effect: an id whose item a decision has just removed from the
  // queue simply resolves to `null`, and the inspector goes back to its prompt.
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className={cn("min-w-0", inspectorOpen && selected !== null && "hidden lg:block")}>
        <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-3">
          <h2 className="text-emphasis font-medium">Waiting for a decision</h2>
          <span role="status" className="text-meta text-ink-muted">
            {items.length} of {queue.data.total}
          </span>
        </div>
        <ul ref={listRef} className="flex flex-col" aria-label="Items waiting for a decision">
          {items.map((item) => (
            <li key={item.id} className="border-b border-rule">
              <button
                type="button"
                data-item-id={item.id}
                aria-current={item.id === selectedId ? "true" : undefined}
                onClick={(event) => {
                  returnTo.current = event.currentTarget;
                  setSelectedId(item.id);
                  setInspectorOpen(true);
                  focusInspector();
                }}
                className={cn(
                  "w-full border-l-2 px-4 py-4 text-left transition-colors",
                  item.id === selectedId
                    ? "border-accent bg-accent-bg"
                    : "border-transparent hover:bg-accent-bg/50",
                )}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-meta text-ink-muted">{reviewKindLabel(item.kind)}</span>
                  <span className="shrink-0 text-meta">
                    {item.kind === "unmatched_evidence" &&
                    item.receiptTotal === null &&
                    item.observation?.observedAmount == null ? (
                      <UnknownValue>Not evidenced</UnknownValue>
                    ) : (
                      <Money paise={item.amount} className="text-meta" />
                    )}
                  </span>
                </span>
                <span className="mt-1 block text-body font-medium text-ink">{itemTitle(item)}</span>
                <span className="mt-0.5 block text-micro text-ink-faint">
                  {formatDate(item.occurredAt)}
                </span>
                <ReasonRow reasons={item.reasons} label={reviewReasonLabel} />
              </button>
            </li>
          ))}
        </ul>
        {queue.data.truncated && (
          <Button
            variant="outline"
            disabled={queue.isFetching}
            className="mt-4 w-full"
            onClick={() => setLimit((current) => current + 50)}
          >
            {queue.isFetching ? "Loading more…" : "Show more items"}
          </Button>
        )}
        <p className="mt-4 hidden text-micro text-ink-faint lg:block">
          <kbd className="font-mono">j / k</kbd> to move · <kbd className="font-mono">Enter</kbd> to
          inspect
        </p>
      </div>

      <div
        id="review-inspector"
        tabIndex={-1}
        aria-label="Review inspector"
        className={cn(
          "min-w-0 border-t border-rule bg-panel p-5",
          (!inspectorOpen || selected === null) && "hidden lg:block",
        )}
      >
        {selected !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-4"
            onClick={() => {
              setInspectorOpen(false);
              setSelectedId(null);
              returnTo.current?.focus();
            }}
          >
            <span className="lg:hidden">Back to queue</span>
            <span className="hidden lg:inline">Close inspector</span>
          </Button>
        )}
        {selected === null ? (
          <div className="flex min-h-64 flex-col justify-center px-3 py-8">
            <h2 className="text-emphasis font-medium text-ink">A closer look, before you decide</h2>
            <p className="mt-2 max-w-prose text-body leading-relaxed text-ink-muted">
              Choose an item to see everything the ledger knows about it. Review the source, the
              interpretation and the proposed decision together.
            </p>
            <p className="mt-4 border-l-2 border-accent pl-3 text-meta text-ink-muted">
              Nothing changes until you confirm a decision.
            </p>
          </div>
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
            <ReviewItemInspector key={selected.id} item={selected} />
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
    <>
      <div className="flex flex-col gap-1.5 sm:hidden">
        <Label htmlFor="review-kind">Filter review items</Label>
        <Select
          id="review-kind"
          value={active ?? "all"}
          onChange={(event) =>
            onSelect(event.target.value === "all" ? null : (event.target.value as ReviewItemKind))
          }
        >
          <option value="all">Everything ({total})</option>
          {REVIEW_ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {reviewKindLabel(kind)} ({counts[kind] ?? 0})
            </option>
          ))}
        </Select>
      </div>
      <div
        className="hidden flex-wrap gap-2 border-b border-rule pb-4 sm:flex"
        role="group"
        aria-label="Filter by kind"
      >
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
    </>
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
        "min-h-11 rounded-sm border px-3 py-2 text-meta transition-colors",
        active
          ? "border-accent bg-accent-bg font-medium text-accent"
          : "border-transparent text-ink-muted hover:border-rule hover:bg-panel hover:text-ink",
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
