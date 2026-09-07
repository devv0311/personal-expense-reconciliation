"use client";

import Link from "next/link";
import { Confidence, NoteList } from "@/components/annotations";
import { Money } from "@/components/money";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import {
  auditFindingClassDetail,
  auditFindingClassLabel,
  auditFindingKindLabel,
  auditReviewStatusLabel,
  externalReadStatusDetail,
  externalReadStatusLabel,
} from "@/lib/labels";
import { useSplitwiseAuditFindings } from "@/lib/queries";
import type { AuditFindingFilter } from "@/lib/api";
import type {
  SplitwiseAuditFinding,
  SplitwiseAuditFindingClass,
  SplitwiseAuditRun,
  SplitwiseAuditReviewStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The fourth pillar's list: every current finding, with the one distinction ADR-0046 insists on
 * kept visible — a **disagreement**, an **observability limit**, and an **incomplete check** are
 * three different things, and only the first means the two ledgers say different things.
 *
 * Colors follow the same rule they do everywhere else: `attention` for a finding to look at,
 * never `debit`. A Splitwise mismatch is a signal, not proof that one particular expense is
 * wrong, and painting it the same red as an unexplained rupee would teach the eye to distrust
 * both.
 */
export function AuditFindingsList({ filter }: { filter: AuditFindingFilter }) {
  const findings = useSplitwiseAuditFindings(filter);

  if (findings.isPending) {
    return (
      <LoadingStatus label="Loading findings…">
        <TableSkeleton columns={3} rows={4} />
      </LoadingStatus>
    );
  }
  if (findings.isError) {
    return <ErrorBlock error={findings.error} onRetry={() => void findings.refetch()} />;
  }
  if (findings.data.length === 0) {
    return (
      <EmptyBlock>
        No findings match this filter. That is not the same as the two ledgers agreeing — check the
        read status of the latest audit above before reading it that way.
      </EmptyBlock>
    );
  }

  return (
    <ul className="flex flex-col">
      {findings.data.map((finding) => (
        <li key={finding.id}>
          <Link
            href={`/splitwise/findings/${finding.id}`}
            className="block border-b border-rule py-3 transition-colors last:border-b-0 hover:bg-accent-bg/50"
          >
            <span className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-body text-ink">{auditFindingKindLabel(finding.kind)}</span>
              {finding.amount !== null && <Money paise={finding.amount} className="text-meta" />}
            </span>
            <span className="mt-0.5 block max-w-prose text-meta text-ink-muted">
              {finding.summary}
            </span>
            <span className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-micro">
              <FindingClassWord findingClass={finding.findingClass} />
              <Confidence level={finding.confidence} />
              <ReviewStatusWord status={finding.reviewStatus} />
              <span className="text-ink-faint">
                last seen {formatDateTime(finding.lastObservedAt)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function FindingClassWord({ findingClass }: { findingClass: SplitwiseAuditFindingClass }) {
  return (
    <span
      className={cn(
        findingClass === "discrepancy" && "text-attention",
        findingClass === "limitation" && "text-ink-muted",
        findingClass === "incomplete" && "text-ink-muted",
      )}
      title={auditFindingClassDetail(findingClass)}
    >
      {auditFindingClassLabel(findingClass)}
    </span>
  );
}

export function ReviewStatusWord({ status }: { status: SplitwiseAuditReviewStatus }) {
  return (
    <span
      className={cn(
        status === "open" && "text-attention",
        status === "acknowledged" && "text-accent",
        status === "resolved" && "text-credit",
        status === "dismissed" && "text-ink-muted",
      )}
    >
      {auditReviewStatusLabel(status)}
    </span>
  );
}

/**
 * What the last audit could actually see.
 *
 * This is the single most important sentence on the Splitwise screen, and it goes above the
 * findings rather than below them: a failed, partial, unsupported or unreported read is an
 * **incomplete check, never agreement** (ADR-0046). An empty findings list under a failed read
 * means nothing was checked, not that nothing was wrong.
 */
export function ExternalReadBanner({ run }: { run: SplitwiseAuditRun }) {
  if (run.externalReadStatus === "complete") {
    return (
      <p className="text-body text-ink-muted">
        The last audit read every entry Splitwise holds for the audited scope — {run.pairsAudited}{" "}
        {run.pairsAudited === 1 ? "pair" : "pairs"} compared
        {run.pairsUnchecked > 0 && `, ${run.pairsUnchecked} it could not reach`}. Absence of a
        finding means something here.
      </p>
    );
  }
  return (
    <NoteList
      items={[
        {
          title: `Splitwise read: ${externalReadStatusLabel(run.externalReadStatus).toLowerCase()} — this was an incomplete check, not agreement`,
          detail: (
            <>
              {externalReadStatusDetail(run.externalReadStatus)}
              {run.externalReadDetail !== null && (
                <span className="mt-1 block font-mono text-micro">{run.externalReadDetail}</span>
              )}
              <span className="mt-1 block">
                {run.pairsAudited} {run.pairsAudited === 1 ? "pair" : "pairs"} compared,{" "}
                {run.pairsUnchecked} unchecked. No finding is retired by a read that could not be
                made.
              </span>
            </>
          ),
        },
      ]}
    />
  );
}

/** A finding's own attribution line: how much of the pair gap this record actually accounts for. */
export function BalanceImpact({ finding }: { finding: SplitwiseAuditFinding }) {
  if (finding.kind === "unattributed_balance_mismatch") {
    return (
      <span className="text-body text-ink-muted">
        Nothing on record explains this part of the gap, so it stays unattributed rather than being
        pinned on whichever record would have balanced the totals.
      </span>
    );
  }
  return (
    <span>
      <Money paise={finding.balanceImpact} /> of the pair&apos;s gap
    </span>
  );
}
