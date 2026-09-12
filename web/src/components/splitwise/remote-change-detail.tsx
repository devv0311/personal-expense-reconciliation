"use client";

import Link from "next/link";
import { useState } from "react";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import {
  externalReadStatusDetail,
  externalReadStatusLabel,
  remoteChangeEffectLabel,
  remoteChangeKindLabel,
  remoteChangeStatusLabel,
  sentenceCase,
} from "@/lib/labels";
import {
  useDecideRemoteChange,
  useExpenses,
  usePeople,
  useRemoteChange,
  useSettlements,
} from "@/lib/queries";
import type { PersonSummary, SplitwiseRemoteChangeEffect } from "@/lib/types";

/**
 * One change somebody made in Splitwise, both snapshots, and the two decisions about it.
 *
 * What the screen must get right, and what everything below is arranged around: **a person has
 * to know what accepting writes before they press the button, and the answer has to be the
 * service's.** So `consequence` is rendered verbatim from the API (ADR-0056), the dialog
 * repeats it, and an adoption cannot be confirmed until the local record it joins to is named
 * — because which record that is, is a judgement no comparison can make.
 *
 * Nothing here changes an amount. Where a change makes it clear the ledger ought to say
 * something different, the way to do that is the adjustment surface, with evidence.
 */
export function RemoteChangeDetail({ changeId }: { changeId: string }) {
  const query = useRemoteChange(changeId);
  const people = usePeople();
  const decide = useDecideRemoteChange();
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const [targetId, setTargetId] = useState("");

  if (query.isPending) {
    return (
      <LoadingStatus label="Loading this change…">
        <TableSkeleton columns={2} rows={6} />
      </LoadingStatus>
    );
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  }

  const { change, discoveredBy, needsTarget, acceptable } = query.data;
  const decided = change.status !== "proposed";
  const nameFor = (personId: string | null): string =>
    personId === null ? "—" : personName(people.data ?? [], personId);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={remoteChangeKindLabel(change.kind)}
        description={change.summary}
        actions={
          decided || change.supersededAt !== null ? undefined : (
            <div className="flex gap-3">
              {acceptable && <Button onClick={() => setDecision("accept")}>Accept</Button>}
              <Button variant="outline" onClick={() => setDecision("reject")}>
                Reject
              </Button>
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-meta">
        <span className={change.status === "proposed" ? "text-attention" : "text-ink-muted"}>
          {remoteChangeStatusLabel(change.status)}
        </span>
        <span className="text-ink-faint">{remoteChangeEffectLabel(change.effect)}</span>
        <span className={change.readStatus === "complete" ? "text-ink-faint" : "text-attention"}>
          Read {externalReadStatusLabel(change.readStatus).toLowerCase()}
        </span>
      </div>

      {acceptable ? (
        // Deliberately not an `Alert`: what accepting does is the ordinary, expected statement
        // of this screen, and colouring it `destructive` or `attention` would spend a semantic
        // colour on the one thing here that is not a warning (`Design.md`, "Color").
        <div className="rounded-sm border border-rule bg-panel px-4 py-3">
          <p className="font-medium text-ink">What accepting does</p>
          <p className="mt-1 max-w-prose text-body text-ink-muted">{change.consequence}</p>
        </div>
      ) : (
        <Alert variant="attention">
          <AlertTitle>There is nothing to accept</AlertTitle>
          <AlertDescription>
            <p>{change.consequence}</p>
          </AlertDescription>
        </Alert>
      )}

      {change.readStatus !== "complete" && (
        <Alert variant="attention">
          <AlertTitle>This was seen under an incomplete read.</AlertTitle>
          <AlertDescription>
            <p>
              {externalReadStatusDetail(change.readStatus)} {change.readDetail ?? ""} What was seen
              was seen; what was not read is not reported as missing.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Section title="What it is about" headingId="remote-change-subject">
        <Facts>
          <Fact label="Between">
            {change.personAId === null && change.personBId === null ? (
              <UnknownValue>Not a pair-level change</UnknownValue>
            ) : (
              `${nameFor(change.personAId)} and ${nameFor(change.personBId)}`
            )}
          </Fact>
          <Fact label="Amount" mono>
            {change.amount === null ? (
              <UnknownValue>No single amount</UnknownValue>
            ) : (
              <Money paise={change.amount} />
            )}
          </Fact>
          {change.expenseId !== null && (
            <Fact label="Expense">
              <Link
                href={`/expenses/${change.expenseId}`}
                className="text-accent underline underline-offset-2"
              >
                Open the expense
              </Link>
            </Fact>
          )}
          <Fact label="Splitwise entry" mono>
            {change.externalReference ?? <UnknownValue>None</UnknownValue>}
          </Fact>
          <Fact label="Splitwise account" mono>
            {change.externalUserReference ?? <UnknownValue>Not about an account</UnknownValue>}
          </Fact>
          <Fact label="First seen" mono>
            {formatDateTime(change.firstObservedAt)}
          </Fact>
          <Fact label="Last seen" mono>
            {formatDateTime(change.lastObservedAt)}
          </Fact>
          <Fact label="Found by" mono>
            {discoveredBy === null ? (
              <UnknownValue>The run is no longer on record</UnknownValue>
            ) : (
              formatDateTime(discoveredBy.runAt)
            )}
          </Fact>
        </Facts>
      </Section>

      <Section
        title="The two snapshots it compared"
        headingId="remote-change-snapshots"
        description="Both sides are kept exactly as they were recorded, so the comparison stays checkable after either ledger moves on again."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SnapshotBlock title="This ledger" value={change.localSnapshot} />
          <SnapshotBlock title="Splitwise" value={change.remoteSnapshot} />
        </div>
      </Section>

      {decided && (
        <Section title="The decision on record" headingId="remote-change-decision">
          <Facts>
            <Fact label="Decision">{remoteChangeStatusLabel(change.status)}</Fact>
            <Fact label="By" mono>
              {change.decidedBy ?? <UnknownValue />}
            </Fact>
            <Fact label="When" mono>
              {change.decidedAt === null ? <UnknownValue /> : formatDateTime(change.decidedAt)}
            </Fact>
            <Fact label="Reason">{change.decisionReason ?? <UnknownValue />}</Fact>
            <Fact label="What it applied">
              {change.appliedEffect === null ? (
                <UnknownValue>Nothing — a rejection applies nothing</UnknownValue>
              ) : (
                remoteChangeEffectLabel(change.appliedEffect)
              )}
            </Fact>
          </Facts>
        </Section>
      )}

      {change.supersededAt !== null && (
        <Alert variant="attention">
          <AlertTitle>A later check superseded this change.</AlertTitle>
          <AlertDescription>
            <p>
              Splitwise moved again on {formatDateTime(change.supersededAt)}. This row is kept as
              the record of what was true then; decide about the current one instead.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <DecisionDialog
        open={decision !== null}
        onClose={() => {
          setDecision(null);
          setTargetId("");
          decide.reset();
        }}
        title={decision === "accept" ? "Accept this change" : "Reject this change"}
        consequence={
          decision === "accept" ? (
            <>
              {change.consequence} Nothing in this ledger&apos;s figures moves — not the amount, not
              the allocation, not a balance.
            </>
          ) : (
            <>
              Nothing is applied. The change stays on file with your reason, and a later check that
              sees the same thing will not raise it again.
            </>
          )
        }
        confirmLabel={decision === "accept" ? "Accept it" : "Reject it"}
        confirmVariant={decision === "accept" ? "default" : "outline"}
        reasonRequired
        reasonLabel={
          decision === "accept" ? "Why you are accepting this" : "Why you are rejecting it"
        }
        reasonPlaceholder="Recorded on the change and on an audit event."
        confirmDisabled={decision === "accept" && needsTarget && targetId === ""}
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          if (decision === null || reason === undefined) return;
          decide.mutate(
            {
              changeId: change.id,
              decision,
              reason,
              ...(decision === "accept" && needsTarget ? { targetId } : {}),
            },
            {
              onSuccess: () => {
                setDecision(null);
                setTargetId("");
              },
            },
          );
        }}
      >
        {decision === "accept" && needsTarget && (
          <TargetPicker
            effect={change.effect}
            value={targetId}
            onChange={setTargetId}
            people={people.data ?? []}
          />
        )}
      </DecisionDialog>
    </div>
  );
}

/**
 * Which local record an adoption or a mapping joins to.
 *
 * Required, and deliberately not defaulted to the first plausible row: two dinners on the same
 * evening for the same amount are not interchangeable, and a pre-selected answer to a question
 * only the person can answer is how the wrong one gets confirmed.
 */
function TargetPicker({
  effect,
  value,
  onChange,
  people,
}: {
  effect: SplitwiseRemoteChangeEffect;
  value: string;
  onChange: (next: string) => void;
  people: readonly PersonSummary[];
}) {
  // Deliberately unfiltered by state. An expense may be joined once it is approved *or later*
  // — allocated, synced, reconciled — and `listExpenses` takes one state at a time, so
  // filtering to `approved` here hid almost every eligible row. The state is shown per option
  // and the service is the authority on which are eligible; a screen that decided that for
  // itself would be a second copy of the rule (ADR-0048).
  const expenses = useExpenses({ limit: 50 });
  const settlements = useSettlements();

  if (effect === "map_person") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="target-person">Which person is this Splitwise account?</Label>
        <Select id="target-person" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose a person…</option>
          {people
            .filter((person) => !person.isUser && person.splitwiseUserId === null)
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
        </Select>
        <p className="text-micro text-ink-faint">
          Only people with no Splitwise mapping are listed. Repointing an existing mapping is a
          change to master data, and belongs on the people screen.
        </p>
      </div>
    );
  }

  if (effect === "adopt_settlement_link") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="target-settlement">Which repayment is this?</Label>
        <Select
          id="target-settlement"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a repayment…</option>
          {(settlements.data?.settlements ?? []).map((settlement) => (
            <option key={settlement.id} value={settlement.id}>
              {settlement.counterpartyName} — {settlement.paymentDescription}
            </option>
          ))}
        </Select>
        <p className="text-micro text-ink-faint">
          A repayment has to already exist here, backed by a payment this ledger observed. If none
          does, record the payment first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="target-expense">Which expense is this?</Label>
      <Select id="target-expense" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose an expense…</option>
        {(expenses.data?.expenses ?? []).map((expense) => (
          <option key={expense.id} value={expense.id}>
            {expense.description ?? "Untitled"} — {expense.occurredAt.slice(0, 10)} —{" "}
            {sentenceCase(expense.state)}
          </option>
        ))}
      </Select>
      <p className="text-micro text-ink-faint">
        An expense has to be approved before it can be joined, and may hold only one link — one
        still proposed or under review will be refused. Adopting creates no expense: if none exists
        here, author it first.
      </p>
    </div>
  );
}

function SnapshotBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <h3 className="mb-1 text-meta text-ink-muted">{title}</h3>
      <pre className="overflow-x-auto rounded-sm border border-rule bg-panel p-3 font-mono text-micro whitespace-pre-wrap text-ink-muted">
        {value === null || value === undefined ? "null" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function personName(people: readonly PersonSummary[], personId: string): string {
  const match = people.find((person) => person.id === personId);
  if (match === undefined) return "someone not in the roster";
  return match.isUser ? `${match.displayName} (you)` : match.displayName;
}
