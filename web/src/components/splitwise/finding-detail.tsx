"use client";

import Link from "next/link";
import { useState } from "react";
import { Confidence, NoteList } from "@/components/annotations";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import {
  BalanceImpact,
  FindingClassWord,
  ReviewStatusWord,
} from "@/components/splitwise/audit-findings";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { auditFindingClassDetail, auditFindingKindLabel, auditScopeLabel } from "@/lib/labels";
import { usePeople, useReviewAuditFinding, useSplitwiseAuditFinding } from "@/lib/queries";
import type { PersonSummary, SplitwiseAuditReviewDecision } from "@/lib/types";

const DECISIONS: readonly {
  value: SplitwiseAuditReviewDecision;
  label: string;
  consequence: string;
  reasonRequired: boolean;
}[] = [
  {
    value: "acknowledged",
    label: "Acknowledge",
    consequence:
      "Records that you have seen this. The finding stays open in every other sense, and the " +
      "next audit will re-observe it if it is still true.",
    reasonRequired: false,
  },
  {
    value: "resolved",
    label: "Mark resolved",
    consequence:
      "Records your conclusion that this is dealt with, with your reason. It does not change " +
      "either ledger, and it does not tell Splitwise anything.",
    reasonRequired: true,
  },
  {
    value: "dismissed",
    label: "Dismiss",
    consequence:
      "Records that this is not worth acting on, with your reason. The finding is kept — " +
      "dismissing is a decision on the record, not a delete.",
    reasonRequired: true,
  },
];

/**
 * One audit finding in full, and the three decisions a person can record about it.
 *
 * The banner above the buttons is not decoration: ADR-0046 is explicit that review "authorizes
 * **no** write to Splitwise", and a screen with an "resolve" button next to a Splitwise
 * disagreement is exactly where a reader would assume otherwise.
 */
export function AuditFindingDetail({ findingId }: { findingId: string }) {
  const query = useSplitwiseAuditFinding(findingId);
  const people = usePeople();
  const review = useReviewAuditFinding();
  const [decision, setDecision] = useState<SplitwiseAuditReviewDecision | null>(null);

  if (query.isPending) {
    return (
      <LoadingStatus label="Loading this finding…">
        <TableSkeleton columns={2} rows={6} />
      </LoadingStatus>
    );
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  }

  const { finding, history } = query.data;
  const chosen = DECISIONS.find((entry) => entry.value === decision);
  const nameFor = (personId: string | null): string =>
    personId === null ? "—" : personName(people.data ?? [], personId);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={auditFindingKindLabel(finding.kind)} description={finding.summary} />

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-meta">
        <FindingClassWord findingClass={finding.findingClass} />
        <Confidence level={finding.confidence} />
        <ReviewStatusWord status={finding.reviewStatus} />
        <span className="text-ink-faint">{auditScopeLabel(finding.scope)}</span>
      </div>

      <p className="max-w-prose text-body text-ink-muted">
        {auditFindingClassDetail(finding.findingClass)}
      </p>

      <Section title="What it is about" headingId="finding-subject">
        <Facts>
          <Fact label="Between">
            {finding.personAId === null && finding.personBId === null ? (
              <UnknownValue>Not a pair-level finding</UnknownValue>
            ) : (
              `${nameFor(finding.personAId)} and ${nameFor(finding.personBId)}`
            )}
          </Fact>
          <Fact label="Amount" mono>
            {finding.amount === null ? (
              <UnknownValue>No single amount</UnknownValue>
            ) : (
              <Money paise={finding.amount} />
            )}
          </Fact>
          <Fact label="Accounts for" hint="Attribution is earned, never assumed">
            <BalanceImpact finding={finding} />
          </Fact>
          {finding.expenseId !== null && (
            <Fact label="Expense">
              <Link
                href={`/expenses/${finding.expenseId}`}
                className="text-accent underline underline-offset-2"
              >
                Open the expense
              </Link>
            </Fact>
          )}
          <Fact label="External reference" mono>
            {finding.externalReference ?? <UnknownValue>None</UnknownValue>}
          </Fact>
          <Fact label="First seen" mono>
            {formatDateTime(finding.firstObservedAt)}
          </Fact>
          <Fact label="Last seen" mono>
            {formatDateTime(finding.lastObservedAt)}
          </Fact>
        </Facts>
      </Section>

      <Section
        title="The two snapshots it compared"
        headingId="finding-snapshots"
        description="Both sides are kept, exactly as they were read, so the comparison stays checkable after either ledger moves on."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SnapshotBlock title="This ledger" value={finding.localSnapshot} />
          <SnapshotBlock title="Splitwise" value={finding.externalSnapshot} />
        </div>
        {finding.evidence !== null && finding.evidence !== undefined && (
          <div className="mt-4">
            <SnapshotBlock title="Evidence the audit used" value={finding.evidence} />
          </div>
        )}
      </Section>

      {finding.supersededAt !== null && (
        <NoteList
          items={[
            {
              title: "A later audit superseded this finding",
              detail: `${formatDateTime(finding.supersededAt)}${
                finding.supersedeReason === null ? "" : ` — ${finding.supersedeReason}`
              }. It is kept as history rather than deleted.`,
            },
          ]}
        />
      )}

      <Section
        title="Record what you concluded"
        headingId="finding-review"
        description="A review records a person's conclusion with actor, time and reason. It authorizes no write to Splitwise — re-syncing a stale row is separate work, and is not reachable from here."
      >
        {finding.reviewStatus !== "open" && (
          <p className="mb-3 text-meta text-ink-muted">
            Currently <ReviewStatusWord status={finding.reviewStatus} />
            {finding.reviewedBy !== null && ` by ${finding.reviewedBy}`}
            {finding.reviewedAt !== null && ` on ${formatDateTime(finding.reviewedAt)}`}
            {finding.reviewReason !== null && ` — “${finding.reviewReason}”`}.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {DECISIONS.map((entry) => (
            <Button
              key={entry.value}
              variant={entry.value === "acknowledged" ? "default" : "outline"}
              onClick={() => setDecision(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </Section>

      <Section
        title="History"
        headingId="finding-history"
        description="Append-only. Reviewing supersedes rather than rewrites, so nothing here can be edited away."
      >
        <ul className="flex flex-col">
          {history.map((event, index) => (
            <li
              key={`${event.occurredAt}-${event.action}-${index}`}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0"
            >
              <span className="text-body text-ink">
                {event.action}
                {event.reason !== null && <span className="text-ink-muted"> — {event.reason}</span>}
              </span>
              <span className="tabular font-mono text-meta text-ink-muted">
                {event.actor} · {formatDateTime(event.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <DecisionDialog
        open={decision !== null}
        onClose={() => {
          setDecision(null);
          review.reset();
        }}
        title={chosen === undefined ? "Record a decision" : chosen.label}
        consequence={
          <>
            {chosen?.consequence}
            <span className="mt-2 block">Nothing about this call reaches Splitwise.</span>
          </>
        }
        confirmLabel={chosen?.label ?? "Record"}
        confirmVariant={decision === "acknowledged" ? "default" : "outline"}
        reasonRequired={chosen?.reasonRequired ?? false}
        pending={review.isPending}
        error={review.error}
        onConfirm={(reason) => {
          if (decision === null) return;
          review.mutate(
            { findingId, decision, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setDecision(null) },
          );
        }}
      />
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
