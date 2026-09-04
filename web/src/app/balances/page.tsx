"use client";

import { useState } from "react";
import { BalanceView } from "@/components/balance-view";
import { PersonSelect } from "@/components/person-select";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/status";
import { useBalance, usePeople } from "@/lib/queries";

export default function BalancesPage() {
  const peopleQuery = usePeople();
  const [personAId, setPersonAId] = useState<string | null>(null);
  const [personBId, setPersonBId] = useState<string | null>(null);
  const balanceQuery = useBalance(personAId, personBId);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[20px] font-medium text-ink">Balances</h1>
        <p className="mt-1 max-w-prose text-[14px] text-ink-muted">
          Who owes whom, computed from every shared expense — in either direction, since the payer
          isn&apos;t always you.
        </p>
      </div>

      {peopleQuery.isPending && <LoadingBlock label="Loading people…" />}
      {peopleQuery.isError && (
        <ErrorBlock error={peopleQuery.error} onRetry={() => void peopleQuery.refetch()} />
      )}

      {peopleQuery.isSuccess && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <PersonSelect
              id="person-a"
              label="Person A"
              people={peopleQuery.data}
              value={personAId}
              onChange={setPersonAId}
            />
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
            <LoadingBlock label="Computing balance…" />
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
