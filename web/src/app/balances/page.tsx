"use client";

import { useState } from "react";
import { BalanceView } from "@/components/balance-view";
import { PersonSelect } from "@/components/person-select";
import {
  EmptyBlock,
  ErrorBlock,
  FieldSkeleton,
  FigureSkeleton,
  LoadingStatus,
} from "@/components/status";
import { useBalance, usePeople } from "@/lib/queries";

export default function BalancesPage() {
  const peopleQuery = usePeople();
  const [personAId, setPersonAId] = useState<string | null>(null);
  const [personBId, setPersonBId] = useState<string | null>(null);
  const balanceQuery = useBalance(personAId, personBId);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-h1 font-medium text-ink">Balances</h1>
        <p className="mt-1 max-w-prose text-body text-ink-muted">
          Who owes whom, computed from every shared expense — in either direction, since the payer
          isn&apos;t always you.
        </p>
      </div>

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
              onChange={setPersonAId}
            />
            <span aria-hidden="true" className="pb-2 text-ink-faint">
              &harr;
            </span>
            <PersonSelect
              id="person-b"
              label="Person B"
              people={peopleQuery.data}
              value={personBId}
              onChange={setPersonBId}
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
        </>
      )}
    </div>
  );
}
