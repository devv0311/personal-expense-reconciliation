"use client";

import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ReviewCounts, ReviewQueue } from "@/components/review/review-queue";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { useReviewQueue } from "@/lib/queries";
import type { ReviewItemKind } from "@/lib/types";

/**
 * Everything waiting for a person, in the order the domain says to look at it.
 *
 * The counts query is separate from the list query on purpose: the counts are the whole ledger
 * before any filter or limit, so switching a filter must never make the badge numbers move.
 */
export default function ReviewPage() {
  const [kind, setKind] = useState<ReviewItemKind | null>(null);
  const counts = useReviewQueue({ limit: 1 });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Review"
        description="Resolve proposals, possible duplicates and unmatched evidence. Every decision stays yours to review."
      />

      {counts.isPending && (
        <LoadingStatus label="Counting what's waiting…">
          <TableSkeleton columns={4} rows={1} />
        </LoadingStatus>
      )}
      {counts.isError && <ErrorBlock error={counts.error} onRetry={() => void counts.refetch()} />}
      {counts.isSuccess && (
        <ReviewCounts counts={counts.data.counts} active={kind} onSelect={setKind} />
      )}

      <ReviewQueue key={kind ?? "all"} kind={kind} />
    </div>
  );
}
