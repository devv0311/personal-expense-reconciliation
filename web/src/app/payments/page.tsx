"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ManualPaymentForm } from "@/components/payments/manual-payment-form";
import { PaymentRows } from "@/components/payments/payment-rows";
import { PipelineActions } from "@/components/payments/pipeline-actions";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { fromDateInputValue } from "@/lib/dates";
import {
  cashFlowCategoryLabel,
  cashFlowStateLabel,
  counterpartyTypeLabel,
  paymentStateLabel,
} from "@/lib/labels";
import { useAccounts, usePayments } from "@/lib/queries";
import {
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_STATES,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_STATES,
  type CashFlowCategory,
  type CashFlowState,
  type PaymentCounterpartyType,
  type PaymentDirection,
  type PaymentState,
} from "@/lib/types";

const PAGE_SIZE = 50;

/**
 * Every cash movement the ledger holds — the screen the audit found missing, and the one the
 * rest of the pipeline starts from.
 *
 * Two things make it more than a table. **`Only unexplained`** is the exhaustive list of money
 * nothing accounts for, which the review queue never was: the queue holds items somebody has to
 * decide, and a movement nobody has looked at yet is not in it. And the **total is the ledger's
 * own**, not the page's: when a filter narrows the page after the count was taken, the screen
 * says "at least", because asserting a total it cannot stand behind is the failure audit row 32
 * recorded.
 */
export default function PaymentsPage() {
  return (
    <Suspense
      fallback={
        <LoadingStatus label="Loading the payment workspace…">
          <TableSkeleton columns={5} />
        </LoadingStatus>
      }
    >
      <PaymentsWorkspace />
    </Suspense>
  );
}

function PaymentsWorkspace() {
  const searchParams = useSearchParams();
  // A link from elsewhere supplies *defaults* — an import batch to look inside, an account and
  // period a waterfall term is asking about. An explicit choice on this screen always wins, so
  // no effect has to race the first render to apply one.
  const requestedBatchId = searchParams.get("importBatchId");
  const requestedAccountId = searchParams.get("accountId");
  const requestedUnexplained = searchParams.get("onlyUnexplained") === "true";

  const [chosenAccountId, setChosenAccountId] = useState<string | null>(null);
  const [direction, setDirection] = useState<PaymentDirection | "">("");
  const [cashFlowState, setCashFlowState] = useState<CashFlowState | "">("");
  const [cashFlowCategory, setCashFlowCategory] = useState<CashFlowCategory | "">("");
  const [state, setState] = useState<PaymentState | "">("");
  const [counterpartyType, setCounterpartyType] = useState<PaymentCounterpartyType | "">("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [chosenUnexplained, setChosenUnexplained] = useState<boolean | null>(null);
  const [offset, setOffset] = useState(0);

  const accountId = chosenAccountId ?? requestedAccountId ?? "";
  const onlyUnexplained = chosenUnexplained ?? requestedUnexplained;

  const accounts = useAccounts();
  const filter = {
    ...(accountId === "" ? {} : { accountId }),
    ...(requestedBatchId === null ? {} : { importBatchId: requestedBatchId }),
    ...(direction === "" ? {} : { direction }),
    ...(cashFlowState === "" ? {} : { cashFlowState }),
    ...(cashFlowCategory === "" ? {} : { cashFlowCategory }),
    ...(state === "" ? {} : { state }),
    ...(counterpartyType === "" ? {} : { counterpartyType }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
    ...(from === "" ? {} : { from: fromDateInputValue(from) }),
    ...(to === "" ? {} : { to: fromDateInputValue(to) }),
    ...(onlyUnexplained ? { onlyUnexplained: true } : {}),
    limit: PAGE_SIZE,
    offset,
  };
  const payments = usePayments(filter);

  /** Every control resets the page: staying on page 4 of a different filter shows nothing. */
  const onFilterChange = <T,>(set: (value: T) => void) => {
    return (value: T) => {
      set(value);
      setOffset(0);
    };
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Payments"
        description="Every movement of money in or out of your accounts, imported or typed in. What is unexplained here is what will refuse to reconcile later."
        actions={
          <>
            <ManualPaymentForm />
            <Link href="/payments/import" className={buttonVariants({ variant: "outline" })}>
              Import a statement
            </Link>
          </>
        }
      />

      <PipelineActions eligibleLabel="everything still waiting" />

      {requestedBatchId !== null && (
        <Alert variant="attention">
          <AlertTitle>Showing one import batch</AlertTitle>
          <AlertDescription>
            <p>
              Only the movements loaded in that batch are listed, so the totals below describe it
              and not the ledger.{" "}
              <Link href="/payments" className="underline underline-offset-2">
                Show every movement
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payments-search">Search</Label>
            <Input
              id="payments-search"
              value={search}
              placeholder="Narration or reference"
              onChange={(event) => onFilterChange(setSearch)(event.target.value)}
              className="w-56"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payments-account">Account</Label>
            <Select
              id="payments-account"
              value={accountId}
              onChange={(event) => onFilterChange(setChosenAccountId)(event.target.value)}
              className="min-w-[160px]"
            >
              <option value="">Every account</option>
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payments-direction">Direction</Label>
            <Select
              id="payments-direction"
              value={direction}
              onChange={(event) =>
                onFilterChange(setDirection)(event.target.value as PaymentDirection | "")
              }
              className="min-w-[140px]"
            >
              <option value="">In and out</option>
              <option value="debit">Money out</option>
              <option value="credit">Money in</option>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payments-cash-flow-state">Cash-flow stage</Label>
            <Select
              id="payments-cash-flow-state"
              value={cashFlowState}
              onChange={(event) =>
                onFilterChange(setCashFlowState)(event.target.value as CashFlowState | "")
              }
              className="min-w-[170px]"
            >
              <option value="">Any stage</option>
              {CASH_FLOW_STATES.map((option) => (
                <option key={option} value={option}>
                  {cashFlowStateLabel(option)}
                </option>
              ))}
            </Select>
          </div>

          <label className="flex items-center gap-2 pb-2 text-body text-ink">
            <input
              type="checkbox"
              checked={onlyUnexplained}
              onChange={(event) => onFilterChange(setChosenUnexplained)(event.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
            />
            Only unexplained
          </label>
        </div>

        <details className="text-body">
          <summary className="cursor-pointer text-meta text-ink-muted">More filters</summary>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payments-state">Interpretation state</Label>
              <Select
                id="payments-state"
                value={state}
                onChange={(event) =>
                  onFilterChange(setState)(event.target.value as PaymentState | "")
                }
                className="min-w-[160px]"
              >
                <option value="">Any state</option>
                {PAYMENT_STATES.map((option) => (
                  <option key={option} value={option}>
                    {paymentStateLabel(option)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payments-category">Cash-flow role</Label>
              <Select
                id="payments-category"
                value={cashFlowCategory}
                onChange={(event) =>
                  onFilterChange(setCashFlowCategory)(event.target.value as CashFlowCategory | "")
                }
                className="min-w-[170px]"
              >
                <option value="">Any role</option>
                {CASH_FLOW_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {cashFlowCategoryLabel(option)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payments-counterparty">Counterparty</Label>
              <Select
                id="payments-counterparty"
                value={counterpartyType}
                onChange={(event) =>
                  onFilterChange(setCounterpartyType)(
                    event.target.value as PaymentCounterpartyType | "",
                  )
                }
                className="min-w-[160px]"
              >
                <option value="">Anyone</option>
                {PAYMENT_COUNTERPARTY_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {counterpartyTypeLabel(option)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payments-from">From</Label>
              <Input
                id="payments-from"
                type="date"
                value={from}
                onChange={(event) => onFilterChange(setFrom)(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payments-to">To</Label>
              <Input
                id="payments-to"
                type="date"
                value={to}
                onChange={(event) => onFilterChange(setTo)(event.target.value)}
              />
            </div>
          </div>
        </details>
      </div>

      {payments.isPending && (
        <LoadingStatus label="Loading movements…">
          <TableSkeleton columns={5} />
        </LoadingStatus>
      )}
      {payments.isError && (
        <ErrorBlock error={payments.error} onRetry={() => void payments.refetch()} />
      )}
      {payments.isSuccess && payments.data.payments.length === 0 && (
        <EmptyBlock>
          {onlyUnexplained
            ? "Nothing matching these filters is unexplained. That is a statement about this filter, not about the whole ledger."
            : "No movements match these filters."}
        </EmptyBlock>
      )}
      {payments.isSuccess && payments.data.payments.length > 0 && (
        <div className="flex flex-col gap-4">
          <PaymentRows payments={payments.data.payments} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
            <p className="text-meta text-ink-muted">
              Showing {offset + 1}–{offset + payments.data.payments.length} of{" "}
              {payments.data.filteredTotalIsExact ? "" : "at least "}
              <span className="tabular font-mono">{payments.data.total}</span> matching movements
              {payments.data.filteredTotalIsExact
                ? ""
                : " — the unexplained filter narrows the page after the count, so this is a floor, not a total"}
              .
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
                disabled={payments.data.payments.length < PAGE_SIZE}
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
