"use client";

import { useMemo, useState } from "react";
import { NoteList } from "@/components/annotations";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, toDateInputValue, fromDateInputValue } from "@/lib/dates";
import { adjustmentKindLabel } from "@/lib/labels";
import { comparePaise, formatPaise, isZeroPaise, parseRupeeInput, sumPaise } from "@/lib/money";
import { usePayments, useRecordAdjustment } from "@/lib/queries";
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type ExpenseAdjustmentKind,
  type RefundAllocationState,
} from "@/lib/types";

/**
 * The item an allocation line is for, or "Whole expense".
 *
 * Lives here rather than in `expense-detail.tsx` so the dependency runs one way: the detail
 * screen composes this file, not the other way round.
 */
export function itemLabel(state: RefundAllocationState, expenseItemId: string | null): string {
  if (expenseItemId === null) return "Whole expense";
  return state.items.find((item) => item.expenseItemId === expenseItemId)?.description ?? "An item";
}

/**
 * Recording money coming back, item by item (ADR-0018 (item refunds), 19.1–19.6).
 *
 * The one rule that shapes this form: **the authoritative net cost of an item is the one the
 * server sends back after the refund is recorded, never one this component works out while you
 * type.** What the form does compute is the sum of the amounts *you have typed into it*, so it
 * can tell you the set is short or over before the request goes out — an entry check, labelled
 * as one, over form fields rather than over ledger state. The service validates the same rule
 * again and refuses a set that does not sum exactly (19.2), so agreeing here is a convenience
 * and disagreeing is caught either way.
 *
 * The per-item columns beside the inputs — gross, already refunded, current net — are all
 * `getRefundAllocationState`'s own figures, quoted.
 */
export function RecordRefundForm({
  expenseId,
  state,
}: {
  expenseId: string;
  state: RefundAllocationState;
}) {
  const [kind, setKind] = useState<ExpenseAdjustmentKind>("merchant_refund");
  const [amountText, setAmountText] = useState("");
  const [occurredAt, setOccurredAt] = useState(toDateInputValue(new Date()));
  const [attributed, setAttributed] = useState(true);
  const [itemAmounts, setItemAmounts] = useState<Record<string, string>>({});
  const [adjustmentPaymentId, setAdjustmentPaymentId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const mutation = useRecordAdjustment(expenseId);
  // Only credits can carry a refund back in, so only credits are offered. Narrowing to the
  // unexplained ones is what makes this control also close the cash side: the money arriving
  // stops reading as an unexplained credit the moment it is named here (audit row 27).
  const credits = usePayments({ direction: "credit", onlyUnexplained: true, limit: 50 });

  const amount = parseRupeeInput(amountText);
  const hasItems = state.items.length > 0;
  const attributing = attributed && hasItems;

  const attributions = useMemo(() => {
    if (!attributing) return [];
    const entries: { expenseItemId: string; amount: string }[] = [];
    for (const item of state.items) {
      const raw = itemAmounts[item.expenseItemId];
      if (raw === undefined || raw.trim().length === 0) continue;
      const parsed = parseRupeeInput(raw);
      if (!parsed.ok || isZeroPaise(parsed.paise)) continue;
      entries.push({ expenseItemId: item.expenseItemId, amount: parsed.paise });
    }
    return entries;
  }, [attributing, itemAmounts, state.items]);

  const enteredTotal = sumPaise(attributions.map((entry) => entry.amount));
  const attributionsBalance = amount.ok && comparePaise(enteredTotal, amount.paise) === 0;
  const canSubmit = amount.ok && (!attributing || (attributions.length > 0 && attributionsBalance));

  const invalidItemFields = state.items
    .filter((item) => {
      const raw = itemAmounts[item.expenseItemId];
      if (raw === undefined || raw.trim().length === 0) return false;
      return !parseRupeeInput(raw).ok;
    })
    .map((item) => item.expenseItemId);

  return (
    <Section
      title="Record money coming back"
      headingId="record-refund"
      description="Recording a refund is one act; folding it into the allocation is another. This is the first."
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) setConfirming(true);
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-kind">Kind</Label>
            <Select
              id="refund-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as ExpenseAdjustmentKind)}
              className="min-w-[220px]"
            >
              {EXPENSE_ADJUSTMENT_KINDS.map((option) => (
                <option key={option} value={option}>
                  {adjustmentKindLabel(option)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-amount">Amount (₹)</Label>
            <Input
              id="refund-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              aria-invalid={amountText.length > 0 && !amount.ok}
              aria-describedby={
                amountText.length > 0 && !amount.ok ? "refund-amount-error" : undefined
              }
              className="w-40 font-mono"
              required
            />
            {amountText.length > 0 && !amount.ok && (
              <p id="refund-amount-error" className="text-meta text-debit">
                {amount.message}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-date">Occurred</Label>
            <Input
              id="refund-date"
              type="date"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
              required
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="refund-credit">The credit it arrived on</Label>
          <Select
            id="refund-credit"
            value={adjustmentPaymentId}
            onChange={(event) => setAdjustmentPaymentId(event.target.value)}
            className="max-w-lg"
          >
            <option value="">Not recorded yet</option>
            {(credits.data?.payments ?? []).map((payment) => (
              <option key={payment.id} value={payment.id}>
                {formatDate(payment.occurredAt)} · {payment.rawDescription}
              </option>
            ))}
          </Select>
          <p className="text-micro text-ink-faint">
            Naming it is what connects the expense going down to the money coming in. Leave it unset
            only if the credit has not landed: until it is named, the expense drops while that
            credit stays unexplained on the account.
          </p>
        </div>

        {hasItems && (
          <div className="flex items-center gap-2">
            <input
              id="refund-attributed"
              type="checkbox"
              checked={attributed}
              onChange={(event) => setAttributed(event.target.checked)}
              className="size-4 accent-accent"
            />
            <Label htmlFor="refund-attributed" className="text-body text-ink">
              Say which items this refund gave money back for
            </Label>
          </div>
        )}

        {attributing ? (
          <>
            <Table className="hidden sm:table" style={{ minWidth: "560px" }}>
              <TableCaption>Refund attributed to each item</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Item</TableHead>
                  <TableHead scope="col" className="text-right">
                    Paid
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Already back
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Net now
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    This refund (₹)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.items.map((item) => (
                  <TableRow key={item.expenseItemId}>
                    <TableCell>
                      <label htmlFor={`item-${item.expenseItemId}`}>{item.description}</label>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={item.grossAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={item.refundedAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={item.netAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <ItemAmountInput
                        id={`item-${item.expenseItemId}`}
                        invalid={invalidItemFields.includes(item.expenseItemId)}
                        value={itemAmounts[item.expenseItemId] ?? ""}
                        onChange={(value) =>
                          setItemAmounts((current) => ({
                            ...current,
                            [item.expenseItemId]: value,
                          }))
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* The same splitter below `sm`, as separate markup rather than a scrolled table:
                a five-column table of amounts on a phone clips the figures it exists to show,
                and a clipped figure is a misleading one. The two never coexist in the
                accessibility tree, so the `-m` suffixed field ids are unique but only ever one
                of each pair is exposed. */}
            <ul className="flex flex-col sm:hidden">
              {state.items.map((item) => (
                <li key={item.expenseItemId} className="border-b border-rule py-3 last:border-b-0">
                  <label htmlFor={`item-m-${item.expenseItemId}`} className="text-body text-ink">
                    {item.description}
                  </label>
                  <dl className="mt-1.5 flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-meta text-ink-muted">Paid</dt>
                      <dd>
                        <Money paise={item.grossAmount} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-meta text-ink-muted">Already back</dt>
                      <dd>
                        <Money paise={item.refundedAmount} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-meta text-ink-muted">Net now</dt>
                      <dd>
                        <Money paise={item.netAmount} />
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <span className="text-meta text-ink-muted">This refund (₹)</span>
                    <ItemAmountInput
                      id={`item-m-${item.expenseItemId}`}
                      invalid={invalidItemFields.includes(item.expenseItemId)}
                      value={itemAmounts[item.expenseItemId] ?? ""}
                      onChange={(value) =>
                        setItemAmounts((current) => ({
                          ...current,
                          [item.expenseItemId]: value,
                        }))
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>

            <p
              className={`text-meta ${attributionsBalance ? "text-ink-muted" : "text-attention"}`}
              role="status"
            >
              You have entered{" "}
              <span className="tabular font-mono">{formatEntered(enteredTotal)}</span> across{" "}
              {attributions.length} {attributions.length === 1 ? "item" : "items"}
              {amount.ok ? (
                <>
                  {" "}
                  of the <span className="tabular font-mono">
                    {formatEntered(amount.paise)}
                  </span>{" "}
                  refund.
                  {!attributionsBalance &&
                    " The attributions have to add up exactly — a partial set is refused, not padded."}
                </>
              ) : (
                "."
              )}
            </p>
          </>
        ) : (
          <p className="text-meta text-ink-muted">
            {hasItems
              ? "This will be recorded as a whole-expense refund, spread across the current shares. That is a different fact from naming the items — not a shorter way of stating the same one."
              : "This expense has no recorded items, so the refund is against the whole expense."}
          </p>
        )}

        <div>
          <Button type="submit" disabled={!canSubmit}>
            Record this refund
          </Button>
        </div>
      </form>

      <DecisionDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          mutation.reset();
        }}
        title="Record this refund"
        consequence={
          <>
            This records the refund as a fact against the expense. The expense&apos;s original gross
            amount is not touched — it never is — and the current allocation is <strong>not</strong>{" "}
            changed by this step: obligations stay as they are until you separately approve a
            distribution, and until then this expense shows as having a pending adjustment.
          </>
        }
        confirmLabel="Record"
        pending={mutation.isPending}
        error={mutation.error}
        onConfirm={(reason) => {
          if (!amount.ok) return;
          mutation.mutate(
            {
              kind,
              amount: amount.paise,
              occurredAt: fromDateInputValue(occurredAt),
              ...(reason === undefined ? {} : { reason }),
              ...(adjustmentPaymentId === "" ? {} : { adjustmentPaymentId }),
              ...(attributing ? { itemAttributions: attributions } : {}),
            },
            {
              onSuccess: () => {
                setConfirming(false);
                setAmountText("");
                setItemAmounts({});
                setAdjustmentPaymentId("");
              },
            },
          );
        }}
      />
    </Section>
  );
}

/** The per-item amount field, shared by the table and the stacked list so the two agree. */
function ItemAmountInput({
  id,
  value,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      inputMode="decimal"
      placeholder="0.00"
      aria-invalid={invalid}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-28 text-right font-mono"
    />
  );
}

/**
 * Folding every recorded-but-undistributed adjustment into a new `Allocation` version.
 *
 * The lines shown are `projectedLines` — the server's own answer to "what would a distribution
 * write?" — not a preview this component derived. When the ledger cannot say who owned a
 * refunded item, `projectedLines` is `null` and `reviewRequired` explains why; distribution is
 * then refused rather than falling back to a whole-basket guess (ADR-0045).
 */
export function DistributionPanel({
  expenseId,
  state,
  nameFor,
  distribute,
}: {
  expenseId: string;
  state: RefundAllocationState;
  nameFor: (line: { beneficiaryType: string; beneficiaryId: string }) => string;
  distribute: DistributeMutation;
}) {
  const [confirming, setConfirming] = useState(false);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState(false);

  // Positional, because that is what the API's `customWeights` is: one weight per line of the
  // **current** allocation, in its order. They describe the unattributed whole-expense
  // reduction only — where an item refund lands is decided by its attribution, and weights
  // sent for an item-attributed reduction are refused rather than quietly ignored (ADR-0018).
  const currentLines = state.currentAllocation?.lines ?? [];
  const customWeights = currentLines.map((_line, index) => (weights[String(index)] ?? "1").trim());
  const weightsValid = customWeights.every((weight) => /^\d+$/.test(weight));

  return (
    <Section
      title="What a distribution would write"
      headingId="distribution"
      description="The lines the domain engine would produce, rebuilt from the recorded facts — shown before anyone approves them."
    >
      {state.reviewRequired !== null ? (
        <NoteList
          items={[
            {
              title: "This refund cannot be allocated yet",
              detail: (
                <>
                  {state.reviewRequired.message}
                  <span className="mt-1 block font-mono text-micro">
                    {state.reviewRequired.code}
                  </span>
                </>
              ),
            },
          ]}
        />
      ) : state.projectedLines === null ? (
        <EmptyBlock>
          Nothing is waiting to be distributed, and the lines a distribution would write cannot be
          computed from what is recorded.
        </EmptyBlock>
      ) : (
        <>
          <ResponsiveTable
            caption="Allocation lines a distribution would write"
            minWidth="480px"
            rows={state.projectedLines}
            rowKey={(line, index) =>
              `${line.beneficiaryId}-${line.expenseItemId ?? "whole"}-${index}`
            }
            columns={[
              { key: "beneficiary", header: "Beneficiary", render: (line) => nameFor(line) },
              {
                key: "for",
                header: "For",
                render: (line) => (
                  <span className="text-ink-muted">{itemLabel(state, line.expenseItemId)}</span>
                ),
              },
              {
                key: "amount",
                header: "Amount",
                align: "right",
                render: (line) => <Money paise={line.amount} />,
              },
            ]}
          />
          <p className="mt-3 text-meta text-ink-muted">
            A fully refunded share stays as a zero-amount line rather than disappearing — the
            history of who benefited survives the refund.
          </p>
          {/* The button appears only while something is actually waiting. Distributing twice
              over the same facts is refused by the service (ADR-0045), and offering an action
              that is going to fail is worse than not offering it. */}
          {state.pendingDistribution ? (
            <div className="mt-4 flex flex-col gap-3">
              {currentLines.length > 0 && state.basis !== "item_attributed" && (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-body text-ink">
                    <input
                      type="checkbox"
                      checked={custom}
                      onChange={(event) => setCustom(event.target.checked)}
                      className="size-4 accent-accent"
                    />
                    Spread it unevenly instead
                  </label>
                  {custom && (
                    <>
                      <p className="text-meta text-ink-muted">
                        A weight per current share, in the order above. The default spreads the
                        reduction in proportion to what each person already owes; a weight of 0
                        gives that person none of it. The ledger does the division.
                      </p>
                      <div className="flex flex-wrap gap-3">
                        {currentLines.map((line, index) => (
                          <div
                            key={`${line.beneficiaryId}-${index}`}
                            className="flex flex-col gap-1.5"
                          >
                            <Label htmlFor={`weight-${index}`}>{nameFor(line)}</Label>
                            <Input
                              id={`weight-${index}`}
                              inputMode="numeric"
                              value={weights[String(index)] ?? "1"}
                              onChange={(event) =>
                                setWeights((current) => ({
                                  ...current,
                                  [String(index)]: event.target.value,
                                }))
                              }
                              className="w-20 font-mono"
                            />
                          </div>
                        ))}
                      </div>
                      {!weightsValid && (
                        <p className="text-meta text-attention">
                          Each weight is a whole number, zero included.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
              <div>
                <Button disabled={custom && !weightsValid} onClick={() => setConfirming(true)}>
                  Approve this distribution
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-meta text-credit">
              These are the lines the current allocation already has: every recorded adjustment has
              reached it, so there is nothing to distribute.
            </p>
          )}
        </>
      )}

      <DecisionDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          distribute.reset();
        }}
        title="Approve this distribution"
        consequence={
          <>
            This writes a new allocation version with the lines above, superseding the current one,
            and the obligations between people change accordingly. Already-recorded settlements are
            untouched — if a refund leaves someone overpaid, that shows up as a balance running the
            other way rather than as a settlement being rewritten.
          </>
        }
        confirmLabel="Approve"
        pending={distribute.isPending}
        error={distribute.error}
        onConfirm={(reason) => {
          distribute.mutate(
            {
              ...(reason === undefined ? {} : { reason }),
              ...(custom && weightsValid ? { customWeights } : {}),
            },
            {
              onSuccess: () => setConfirming(false),
            },
          );
        }}
      >
        <p className="text-meta text-ink-muted">
          Expense <span className="font-mono">{expenseId.slice(0, 8)}</span>
        </p>
      </DecisionDialog>
    </Section>
  );
}

/**
 * Just enough of a mutation for this panel, rather than TanStack Query's full result type.
 *
 * The panel is a presentational component with an approval step; keeping the contract this
 * narrow is what lets a test drive it without a `QueryClient` and a live API behind it.
 */
export interface DistributeMutation {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly reset: () => void;
  readonly mutate: (
    input: { readonly reason?: string; readonly customWeights?: readonly string[] },
    options?: { readonly onSuccess?: () => void },
  ) => void;
}

/** The entry echo, in the same formatting every figure in the product uses. */
function formatEntered(paise: string): string {
  return formatPaise(paise).text;
}
