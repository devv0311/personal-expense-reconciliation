"use client";

import { NoteList } from "@/components/annotations";
import { ExpenseStateTag } from "@/components/expense-state-tag";
import { AllocationEditor } from "@/components/expenses/allocation-editor";
import { FundingLinks } from "@/components/expenses/funding-links";
import { ItemEditor } from "@/components/expenses/item-editor";
import { SplitwiseSyncPanel } from "@/components/expenses/splitwise-sync";
import {
  DistributionPanel,
  RecordRefundForm,
  itemLabel,
} from "@/components/expenses/refund-workflow";
import { Fact, Facts } from "@/components/facts";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { formatDate } from "@/lib/dates";
import { allocationMethodLabel, refundBasisLabel, sentenceCase } from "@/lib/labels";
import { isZeroPaise } from "@/lib/money";
import {
  useDistributeAdjustment,
  useExpense,
  useExpenseItems,
  usePeople,
  useRefundAllocation,
} from "@/lib/queries";
import type { PersonSummary, RefundAllocationState } from "@/lib/types";

/**
 * One expense, and the second pillar's whole workflow over it: items, who benefited, what came
 * back, and what a distribution would do about it.
 *
 * Every figure on this screen — gross, net, each item's refunded and net cost, each allocation
 * line, each projected line — comes from `GET /api/expenses/:id` and
 * `GET /api/expenses/:id/refund-allocation`. Nothing is netted, divided or summed here.
 *
 * The hero figure is the **net** amount, with the immutable gross beside it in small type: the
 * question this screen exists to answer is "what did this actually cost, after what came back",
 * and the gross is the historical fact that never changes.
 */
export function ExpenseDetail({ expenseId }: { expenseId: string }) {
  const expense = useExpense(expenseId);
  const refund = useRefundAllocation(expenseId);
  const people = usePeople();
  const items = useExpenseItems(expenseId);
  const distribute = useDistributeAdjustment(expenseId);

  if (expense.isPending || refund.isPending) {
    return (
      <LoadingStatus label="Loading this expense…">
        <TableSkeleton columns={3} rows={5} />
      </LoadingStatus>
    );
  }
  if (expense.isError) {
    return <ErrorBlock error={expense.error} onRetry={() => void expense.refetch()} />;
  }
  if (refund.isError) {
    return <ErrorBlock error={refund.error} onRetry={() => void refund.refetch()} />;
  }

  const row = expense.data;
  const state = refund.data;
  const hasAdjustment = row.netAmount !== row.grossAmount;
  const nameFor = beneficiaryNamer(people.data ?? []);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={row.description ?? "Untitled expense"}
        description={
          <>
            {formatDate(row.occurredAt)} · {sentenceCase(row.relationshipType)} · paid by{" "}
            {personName(people.data ?? [], row.paidByPersonId)}
          </>
        }
      />

      <div className="border-t-2 border-double border-rule-strong pt-4">
        <p className="text-meta text-ink-muted">Net cost</p>
        <Money paise={row.netAmount} size="figure" className="mt-1 block" />
        {hasAdjustment && (
          <p className="mt-1 text-micro text-ink-faint">
            of <Money paise={row.grossAmount} className="text-micro" /> originally paid — the gross
            never changes
          </p>
        )}
        <p className="mt-3">
          <ExpenseStateTag state={row.state} />
        </p>
      </div>

      <ExpenseWarnings state={state} />

      <Section
        title="What came back"
        headingId="expense-adjustments"
        description="Refunds and reimbursements recorded against this expense, split by whether they name the items they were for."
      >
        <Facts>
          <Fact label="Basis">{refundBasisLabel(state.basis)}</Fact>
          <Fact label="Attributed to items" mono>
            <Money paise={state.attributedReduction} />
          </Fact>
          <Fact label="Against the whole expense" mono>
            <Money paise={state.unattributedReduction} />
          </Fact>
          <Fact
            label="Not yet in the allocation"
            mono
            hint="What a distribution would still have to absorb"
          >
            <Money
              paise={state.pendingReduction}
              tone={isZeroPaise(state.pendingReduction) ? "neutral" : "debit"}
            />
          </Fact>
        </Facts>
      </Section>

      <Section
        title="Items"
        headingId="expense-items"
        description="Each item's own paid cost, what has come back against it, and what it nets to."
        actions={<ItemEditor expense={row} items={items.data ?? []} />}
      >
        {state.items.length === 0 ? (
          <EmptyBlock>
            No breakdown has been recorded. Without one, a refund can only be recorded against the
            whole expense — never against the item it was actually for.
          </EmptyBlock>
        ) : (
          <ResponsiveTable
            caption="Item breakdown with refunds applied"
            minWidth="520px"
            rows={state.items}
            rowKey={(item) => item.expenseItemId}
            columns={[
              { key: "item", header: "Item", render: (item) => item.description },
              {
                key: "quantity",
                header: "Quantity",
                align: "right",
                secondary: true,
                render: (item) => (
                  <span className="tabular font-mono text-meta text-ink-muted">
                    {item.quantity}
                  </span>
                ),
              },
              {
                key: "paid",
                header: "Paid",
                align: "right",
                render: (item) => <Money paise={item.grossAmount} />,
              },
              {
                key: "refunded",
                header: "Refunded",
                align: "right",
                render: (item) => <Money paise={item.refundedAmount} />,
              },
              {
                key: "net",
                header: "Net",
                align: "right",
                render: (item) => <Money paise={item.netAmount} />,
              },
            ]}
          />
        )}
      </Section>

      <FundingLinks expense={row} />

      <Section
        title="Who benefited"
        headingId="expense-allocation"
        actions={
          <AllocationEditor expense={row} hasCurrentAllocation={state.currentAllocation !== null} />
        }
        description={
          state.currentAllocation === null
            ? "No allocation has been approved for this expense yet."
            : `The current allocation version — ${allocationMethodLabel(state.currentAllocation.method).toLowerCase()}.`
        }
      >
        {state.currentAllocation === null ? (
          <EmptyBlock>
            Nobody has been named a beneficiary yet, so this expense creates no obligations.
          </EmptyBlock>
        ) : (
          <ResponsiveTable
            caption="Current allocation lines"
            minWidth="420px"
            rows={state.currentAllocation.lines}
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
                key: "share",
                header: "Share",
                align: "right",
                render: (line) => <Money paise={line.amount} />,
              },
            ]}
          />
        )}
      </Section>

      <DistributionPanel
        expenseId={expenseId}
        state={state}
        nameFor={nameFor}
        distribute={distribute}
      />

      <SplitwiseSyncPanel expense={row} />

      <RecordRefundForm expenseId={expenseId} state={state} />
    </div>
  );
}

/**
 * Everything about this expense that is not settled, stated rather than smoothed.
 *
 * `obligationsReflectAdjustments === false` is the one ADR-0018 asks for in as many words: a
 * pending adjustment is visible, and stale allocation-based obligations are not presented as
 * current or verified.
 */
function ExpenseWarnings({ state }: { state: RefundAllocationState }) {
  const items: { title: string; detail: string }[] = [];

  if (!state.obligationsReflectAdjustments) {
    items.push({
      title: "The obligations below are out of date",
      detail:
        "A refund has been recorded but not yet folded into the allocation, so what each " +
        "person owes has not moved yet. These shares are not current or verified.",
    });
  }
  if (state.pendingDistribution && state.obligationsReflectAdjustments) {
    items.push({
      title: "A distribution is still pending",
      detail: "There is a recorded adjustment that has not reached the current allocation.",
    });
  }
  if (state.basis === "mixed") {
    items.push({
      title: "Mixed adjustment basis",
      detail:
        "Some money came back against named items and some against the whole expense. Both " +
        "are honoured — the item-attributed part lands on its own items, and the rest is " +
        "spread afterwards.",
    });
  }
  if (state.reviewRequired !== null) {
    items.push({
      title: "A refund needs a decision before it can be allocated",
      detail: state.reviewRequired.message,
    });
  }

  return <NoteList items={items} />;
}

function personName(people: readonly PersonSummary[], personId: string): string {
  const match = people.find((person) => person.id === personId);
  if (match === undefined) return "someone not in the roster";
  return match.isUser ? `${match.displayName} (you)` : match.displayName;
}

/**
 * Names a beneficiary.
 *
 * A `group` line is labelled as one rather than resolved here: expanding a group into people is
 * a deterministic `GroupMembership` lookup in the services, snapshotted as of the expense date
 * (ADR-0009), and a frontend that guessed at it would be inventing a membership timeline.
 */
function beneficiaryNamer(people: readonly PersonSummary[]) {
  return (line: { beneficiaryType: string; beneficiaryId: string }): string => {
    if (line.beneficiaryType === "group") {
      return `A group · expanded into people before it can be settled`;
    }
    return personName(people, line.beneficiaryId);
  };
}
