"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { PersonSelect } from "@/components/person-select";
import { ProofPackPreview } from "@/components/proof-packs/proof-pack-preview";
import {
  EmptyBlock,
  ErrorBlock,
  FieldSkeleton,
  FigureSkeleton,
  LoadingStatus,
} from "@/components/status";
import { usePeople, useProofPack } from "@/lib/queries";

/**
 * Pick a recipient, read exactly what would be sent, then copy it — deliberately, in that order.
 *
 * Generating a pack is a read: it sends nothing, records no settlement and writes no row. The
 * copy step is this phase's own addition, and it is gated behind an explicit review of the
 * recipient, the content and the cited evidence (ADR-0047's preview, plus the roadmap's
 * "recipient-facing review of exactly what is about to be sent").
 */
export default function ProofPacksPage() {
  return (
    <Suspense
      fallback={
        <LoadingStatus label="Loading…">
          <FieldSkeleton />
        </LoadingStatus>
      }
    >
      <ProofPacksContent />
    </Suspense>
  );
}

function ProofPacksContent() {
  const searchParams = useSearchParams();
  const requested = searchParams.get("recipient");
  const people = usePeople();
  const [chosen, setChosen] = useState<string | null>(null);

  // `?recipient=` from the command palette is the *default*, not a value copied into state: an
  // explicit choice on this screen always wins over the link that opened it.
  const recipientId = chosen ?? requested;
  const pack = useProofPack(recipientId);

  const recipients = (people.data ?? []).filter((person) => !person.isUser);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Proof packs"
        description="Prepare a private summary for one person: expenses, refunds, settlements and what remains. Review the exact content before copying; nothing is sent automatically."
      />

      {people.isPending && (
        <LoadingStatus label="Loading people…">
          <FieldSkeleton />
        </LoadingStatus>
      )}
      {people.isError && <ErrorBlock error={people.error} onRetry={() => void people.refetch()} />}

      {people.isSuccess && (
        <>
          <div className="flex flex-wrap items-end gap-4 rounded-sm border border-rule bg-panel p-4">
            <PersonSelect
              id="pack-recipient"
              label="Recipient"
              people={recipients}
              value={recipientId}
              onChange={setChosen}
            />
          </div>

          {recipientId === null && (
            <EmptyBlock>
              Choose who this pack is for. A pack only ever names you and that one person — no other
              person&apos;s details are included.
            </EmptyBlock>
          )}

          {pack.isPending && recipientId !== null && (
            <LoadingStatus label="Deriving this pack…">
              <FigureSkeleton />
            </LoadingStatus>
          )}
          {pack.isError && <ErrorBlock error={pack.error} onRetry={() => void pack.refetch()} />}
          {pack.isSuccess && <ProofPackPreview key={recipientId} preview={pack.data} />}
        </>
      )}
    </div>
  );
}
