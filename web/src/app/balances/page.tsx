"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BalanceView } from "@/components/balance-view";
import { PageHeader } from "@/components/page-header";
import { PersonSelect } from "@/components/person-select";
import { SettlementRegister } from "@/components/settlements/settlement-register";
import {
  EmptyBlock,
  ErrorBlock,
  FieldSkeleton,
  FigureSkeleton,
  LoadingStatus,
} from "@/components/status";
import { useBalance, usePeople } from "@/lib/queries";

export default function BalancesPage() {
  return (
    <Suspense
      fallback={
        <LoadingStatus label="Loading…">
          <FieldSkeleton />
        </LoadingStatus>
      }
    >
      <BalancesContent />
    </Suspense>
  );
}

/**
 * Who owes whom, in either direction.
 *
 * `?with=<personId>` puts the user on one side and that person on the other — the shape the
 * command palette links to, and the question ("what is between me and them?") this screen is
 * asked most often. Both pickers stay editable, because the payer is not always the user and a
 * balance between two flatmates is a real thing this ledger can compute.
 */
function BalancesContent() {
  const searchParams = useSearchParams();
  const requestedWith = searchParams.get("with");
  const peopleQuery = usePeople();
  const [chosenA, setChosenA] = useState<string | null>(null);
  const [chosenB, setChosenB] = useState<string | null>(null);

  const userPersonId = peopleQuery.data?.find((person) => person.isUser)?.id ?? null;

  // `?with=` supplies the *default* pair rather than being copied into state: an explicit
  // choice always wins, and no effect has to race the people query to apply the link.
  const personAId = chosenA ?? (requestedWith === null ? null : userPersonId);
  const personBId = chosenB ?? requestedWith;
  const balanceQuery = useBalance(personAId, personBId);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Balances"
        description="Who owes whom, computed from every shared expense — in either direction, since the payer isn't always you."
        actions={
          personBId !== null && personBId !== userPersonId ? (
            <Link
              href={`/proof-packs?recipient=${personBId}`}
              className="text-meta text-accent underline underline-offset-2"
            >
              Preview a proof pack for this person
            </Link>
          ) : undefined
        }
      />

      {peopleQuery.isPending && (
        <LoadingStatus label="Loading people…">
          <div className="flex gap-4">
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
        </LoadingStatus>
      )}
      {peopleQuery.isError && (
        <ErrorBlock error={peopleQuery.error} onRetry={() => void peopleQuery.refetch()} />
      )}

      {peopleQuery.isSuccess && (
        <>
          <div className="flex flex-wrap items-end gap-4 rounded-sm border border-rule bg-panel p-4">
            <PersonSelect
              id="person-a"
              label="Person A"
              people={peopleQuery.data}
              value={personAId}
              onChange={setChosenA}
            />
            <span aria-hidden="true" className="pb-2 text-ink-faint">
              &harr;
            </span>
            <PersonSelect
              id="person-b"
              label="Person B"
              people={peopleQuery.data}
              value={personBId}
              onChange={setChosenB}
            />
          </div>

          {personAId !== null && personBId !== null && personAId === personBId && (
            <EmptyBlock>Choose two different people to see a balance.</EmptyBlock>
          )}

          {balanceQuery.isPending && personAId !== null && personBId !== null && (
            <LoadingStatus label="Computing balance…">
              <FigureSkeleton />
            </LoadingStatus>
          )}
          {balanceQuery.isError && (
            <ErrorBlock error={balanceQuery.error} onRetry={() => void balanceQuery.refetch()} />
          )}
          {balanceQuery.isSuccess && (
            <BalanceView balance={balanceQuery.data} people={peopleQuery.data} />
          )}

          {/* The whole register, or one person's, depending on whether a pair is chosen. It is
              the same recorded repayments either way — a filter, never a different figure. */}
          <SettlementRegister
            {...(personBId !== null && personBId !== userPersonId
              ? { counterpartyPersonId: personBId }
              : {})}
          />
        </>
      )}
    </div>
  );
}
