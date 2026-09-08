"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { parseRupeeInput, toRupeeInput } from "@/lib/money";
import { usePeople, useRecordSettlement } from "@/lib/queries";
import type { PaymentWorkspaceItem } from "@/lib/types";

/**
 * Records that a movement discharged a debt.
 *
 * A settlement **discharges** an obligation; it never creates one (`invariants.md` #9). That is
 * why it is recorded against a payment and has no allocation of its own: modelling a repayment
 * as an expense with beneficiaries would double-count the very debt it is paying down.
 *
 * The amount is stated explicitly rather than defaulting to the whole payment — a partial
 * repayment is ordinary, and a boundary that assumed "all of it" would record a discharge
 * nobody asked for.
 */
export function SettlementForm({ payment }: { payment: PaymentWorkspaceItem }) {
  const [open, setOpen] = useState(false);
  const [counterpartyPersonId, setCounterpartyPersonId] = useState("");
  const [amount, setAmount] = useState(toRupeeInput(payment.amount));

  const people = usePeople();
  const record = useRecordSettlement();

  const parsed = parseRupeeInput(amount);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setAmount(toRupeeInput(payment.amount));
          record.reset();
          setOpen(true);
        }}
      >
        Record a settlement
      </Button>

      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Record a settlement"
        consequence={
          <>
            This records that this movement repaid part of a balance between you and the person you
            name. It is <strong>not</strong> new spending and creates no obligation: it reduces what
            is already owed, in whichever direction that runs.
          </>
        }
        confirmLabel="Record it"
        confirmDisabled={counterpartyPersonId === "" || !parsed.ok}
        reasonLabel="What it settles"
        pending={record.isPending}
        error={record.error}
        onConfirm={(reason) => {
          if (!parsed.ok) return;
          record.mutate(
            {
              paymentId: payment.id,
              counterpartyPersonId,
              amount: parsed.paise,
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settlement-person">Between you and</Label>
            <Select
              id="settlement-person"
              value={counterpartyPersonId}
              onChange={(event) => setCounterpartyPersonId(event.target.value)}
            >
              <option value="">Choose a person…</option>
              {(people.data ?? [])
                .filter((person) => !person.isUser)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settlement-amount">How much of it settles</Label>
            <Input
              id="settlement-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-40 font-mono"
            />
            <p className="text-micro text-ink-faint">
              The movement was <Money paise={payment.amount} />. A smaller figure records a partial
              repayment.
            </p>
          </div>
        </div>
      </DecisionDialog>
    </>
  );
}
