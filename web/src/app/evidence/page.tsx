"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { EvidenceIntake } from "@/components/evidence/evidence-intake";
import { PageHeader } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDate } from "@/lib/dates";
import { evidenceTypeLabel } from "@/lib/labels";
import { useEvidenceLibrary } from "@/lib/queries";
import { EVIDENCE_TYPES, type EvidenceType } from "@/lib/types";

const PAGE_SIZE = 25;

/**
 * Every stored document and note.
 *
 * The `unlinked` filter is the useful one: a document attached to nothing is evidence the
 * ledger is not yet using, and before this screen existed the only way to see one was to wait
 * for it to surface in the review queue. A queue is a work list; this is the whole library.
 *
 * Everything here stays behind the local boundary — raw notification text included, because
 * this surface never leaves the machine. What a proof pack exports is redacted separately, on
 * its own screen (`security-model.md`).
 */
export default function EvidencePage() {
  return (
    <Suspense
      fallback={
        <LoadingStatus label="Loading the evidence library…">
          <TableSkeleton columns={4} />
        </LoadingStatus>
      }
    >
      <EvidenceLibrary />
    </Suspense>
  );
}

function EvidenceLibrary() {
  const searchParams = useSearchParams();
  // `?linkage=unlinked` is what the palette's "attached to nothing" command links to. It
  // supplies the default; an explicit choice on the filter always wins.
  const requestedLinkage = searchParams.get("linkage");

  const [type, setType] = useState<EvidenceType | "">("");
  const [chosenLinkage, setChosenLinkage] = useState<"linked" | "unlinked" | "" | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const linkage = (chosenLinkage ?? requestedLinkage ?? "") as "linked" | "unlinked" | "";
  const library = useEvidenceLibrary({
    ...(type === "" ? {} : { type }),
    ...(linkage === "" ? {} : { linkage }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Evidence"
        description="Every document, notification and note this ledger holds. A record here is the immutable source; what the system believes it means lives beside it, never over it."
        actions={<EvidenceIntake />}
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-search">Search</Label>
          <Input
            id="evidence-search"
            value={search}
            placeholder="Text in a note or notification"
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-type-filter">Kind</Label>
          <Select
            id="evidence-type-filter"
            value={type}
            onChange={(event) => {
              setType(event.target.value as EvidenceType | "");
              setOffset(0);
            }}
            className="min-w-[180px]"
          >
            <option value="">Every kind</option>
            {EVIDENCE_TYPES.map((option) => (
              <option key={option} value={option}>
                {evidenceTypeLabel(option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-linkage">Attached to</Label>
          <Select
            id="evidence-linkage"
            value={linkage}
            onChange={(event) => {
              setChosenLinkage(event.target.value as "linked" | "unlinked" | "");
              setOffset(0);
            }}
            className="min-w-[180px]"
          >
            <option value="">Anything or nothing</option>
            <option value="unlinked">Nothing yet</option>
            <option value="linked">Something</option>
          </Select>
        </div>
      </div>

      {library.isPending && (
        <LoadingStatus label="Loading the evidence library…">
          <TableSkeleton columns={4} />
        </LoadingStatus>
      )}
      {library.isError && (
        <ErrorBlock error={library.error} onRetry={() => void library.refetch()} />
      )}
      {library.isSuccess && library.data.evidence.length === 0 && (
        <EmptyBlock>
          {linkage === "unlinked"
            ? "Every stored document is attached to something. That is a statement about what is stored, not about what is missing."
            : "Nothing has been stored yet."}
        </EmptyBlock>
      )}
      {library.isSuccess && library.data.evidence.length > 0 && (
        <div className="flex flex-col gap-4">
          <ResponsiveTable
            caption="Stored evidence"
            minWidth="640px"
            rows={library.data.evidence}
            rowKey={(row) => row.id}
            columns={[
              {
                key: "what",
                header: "Document",
                render: (row) => (
                  <>
                    <Link
                      href={`/evidence/${row.id}`}
                      className="text-accent underline underline-offset-2"
                    >
                      {evidenceTypeLabel(row.type)}
                      {row.noteKind === null ? "" : ` · ${noteKindLabel(row.noteKind)}`}
                    </Link>
                    {row.rawText !== null && (
                      <div className="mt-0.5 line-clamp-2 text-meta text-ink-muted">
                        {row.rawText}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: "captured",
                header: "Captured",
                render: (row) => (
                  <span className="text-meta text-ink-muted">{formatDate(row.capturedAt)}</span>
                ),
              },
              {
                key: "read",
                header: "Read",
                secondary: true,
                render: (row) => (
                  <span className="text-meta text-ink-muted">
                    {row.hasReceipt
                      ? "Receipt extracted"
                      : row.hasObservation
                        ? "Observation recorded"
                        : "Nothing read off it"}
                  </span>
                ),
              },
              {
                key: "attached",
                header: "Attached to",
                render: (row) =>
                  row.linkedPaymentId !== null ? (
                    <Link
                      href={`/payments/${row.linkedPaymentId}`}
                      className="text-accent underline underline-offset-2"
                    >
                      A movement
                    </Link>
                  ) : row.linkedExpenseId !== null ? (
                    <Link
                      href={`/expenses/${row.linkedExpenseId}`}
                      className="text-accent underline underline-offset-2"
                    >
                      An expense
                    </Link>
                  ) : (
                    <span className="text-attention">Nothing yet</span>
                  ),
              },
            ]}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
            <p className="text-meta text-ink-muted">
              Showing {offset + 1}–{offset + library.data.evidence.length} of{" "}
              <span className="tabular font-mono">{library.data.total}</span> records.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + library.data.evidence.length >= library.data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function noteKindLabel(kind: string): string {
  return kind === "settlement_claim" ? "Somebody's claim a debt was settled" : "Explanation";
}
