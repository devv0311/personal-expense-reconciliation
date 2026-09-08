"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseRupeeInput, sumPaise } from "@/lib/money";
import { useCorrectExpenseItems, useRecordExpenseItems } from "@/lib/queries";
import type { ExpenseItemDraft } from "@/lib/api";
import type { ExpenseItemRecord, ExpenseLedgerRow } from "@/lib/types";

interface DraftRow {
  readonly key: string;
  readonly description: string;
  readonly amount: string;
  readonly quantity: string;
}

/**
 * Recording an expense's item breakdown, and correcting one that was read wrong.
 *
 * They are one control with two consequences, because the difference is not cosmetic:
 *
 * - **Recording** a breakdown for the first time is additive — it says what the basket was.
 * - **Correcting** one supersedes the old rows (never deletes them), requires a reason, and is
 *   refused outright once a refund has been attributed to any item (ADR-0045): a refund
 *   already sits on a specific item, and moving that item under it would silently move money.
 *
 * Both keep the gross total fixed. `Expense.amount` is immutable once approved
 * (`invariants.md` #6) — a correction to what the purchase *cost* is an adjustment, not this —
 * so the entry check below compares against the gross and the service refuses a mismatch.
 */
export function ItemEditor({
  expense,
  items,
}: {
  expense: ExpenseLedgerRow;
  items: readonly ExpenseItemRecord[];
}) {
  const correcting = items.length > 0;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly DraftRow[]>([]);

  const record = useRecordExpenseItems(expense.id);
  const correct = useCorrectExpenseItems(expense.id);
  const mutation = correcting ? correct : record;

  const openEditor = () => {
    setRows(
      correcting
        ? items.map((item, index) => ({
            key: `${item.id}-${index}`,
            description: item.description,
            amount: rupees(item.amount),
            quantity: item.quantity,
          }))
        : [{ key: "row-0", description: "", amount: "", quantity: "1" }],
    );
    mutation.reset();
    setOpen(true);
  };

  const drafts = toDrafts(rows);
  const enteredTotal = sumPaise(drafts.map((draft) => draft.amount));
  const matchesGross = drafts.length === rows.length && enteredTotal === expense.grossAmount;

  return (
    <>
      <Button variant="outline" size="sm" onClick={openEditor}>
        {correcting ? "Correct the breakdown" : "Record the items"}
      </Button>

      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={correcting ? "Correct this item breakdown" : "Record the item breakdown"}
        consequence={
          correcting ? (
            <>
              This supersedes the current rows with these — the old ones are kept, not deleted. The
              gross total cannot move. If a refund has already been attributed to one of these
              items, the correction is refused rather than quietly moving that money.
            </>
          ) : (
            <>
              This records what the basket was. It creates no obligation on its own: who owed what
              still comes from the allocation.
            </>
          )
        }
        confirmLabel={correcting ? "Replace them" : "Record them"}
        confirmDisabled={!matchesGross}
        reasonLabel={correcting ? "Why the first breakdown was wrong" : "Note for the audit trail"}
        reasonRequired={correcting}
        pending={mutation.isPending}
        error={mutation.error}
        onConfirm={(reason) => {
          if (correcting) {
            if (reason === undefined) return;
            correct.mutate({ items: drafts, reason }, { onSuccess: () => setOpen(false) });
            return;
          }
          record.mutate(
            { items: drafts, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div key={row.key} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor={`item-desc-${row.key}`}>Item {index + 1}</Label>
                <Input
                  id={`item-desc-${row.key}`}
                  value={row.description}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry) =>
                        entry.key === row.key
                          ? { ...entry, description: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`item-amount-${row.key}`}>Amount</Label>
                <Input
                  id={`item-amount-${row.key}`}
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry) =>
                        entry.key === row.key ? { ...entry, amount: event.target.value } : entry,
                      ),
                    )
                  }
                  className="w-32 font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`item-qty-${row.key}`}>Qty</Label>
                <Input
                  id={`item-qty-${row.key}`}
                  inputMode="numeric"
                  value={row.quantity}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry) =>
                        entry.key === row.key ? { ...entry, quantity: event.target.value } : entry,
                      ),
                    )
                  }
                  className="w-20 font-mono"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRows((current) => current.filter((entry) => entry.key !== row.key))
                }
              >
                Remove
                <span className="sr-only"> item {index + 1}</span>
              </Button>
            </div>
          ))}

          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  {
                    key: `row-${current.length}-${Date.now()}`,
                    description: "",
                    amount: "",
                    quantity: "1",
                  },
                ])
              }
            >
              Add an item
            </Button>
          </div>

          <p className="text-meta text-ink-muted">
            Entered so far: <Money paise={enteredTotal} /> of <Money paise={expense.grossAmount} />{" "}
            gross — an entry check on this form, not a ledger figure.
            {!matchesGross && " The ledger refuses a breakdown that does not sum to the gross."}
          </p>
        </div>
      </DecisionDialog>
    </>
  );
}

/** `"123450"` → `"1234.50"`, for a pre-filled field. Pure string handling, no arithmetic. */
function rupees(paise: string): string {
  const value = BigInt(paise);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** Only complete rows become drafts, so an unfinished row blocks the button rather than being sent. */
function toDrafts(rows: readonly DraftRow[]): readonly ExpenseItemDraft[] {
  const drafts: ExpenseItemDraft[] = [];
  for (const row of rows) {
    const parsed = parseRupeeInput(row.amount);
    if (!parsed.ok || row.description.trim() === "") continue;
    drafts.push({
      description: row.description.trim(),
      amount: parsed.paise,
      ...(row.quantity.trim() === "" ? {} : { quantity: row.quantity.trim() }),
    });
  }
  return drafts;
}
