"use client";

import { useState } from "react";
import { PageHeader, Section } from "@/components/page-header";
import { AuditFindingsList, ExternalReadBanner } from "@/components/splitwise/audit-findings";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import {
  auditFindingClassLabel,
  auditReviewStatusLabel,
  externalReadStatusLabel,
} from "@/lib/labels";
import { useRunSplitwiseAudit, useSplitwiseAuditRuns } from "@/lib/queries";
import {
  SPLITWISE_AUDIT_FINDING_CLASSES,
  SPLITWISE_AUDIT_REVIEW_STATUSES,
  type SplitwiseAuditFindingClass,
  type SplitwiseAuditReviewStatus,
} from "@/lib/types";

/**
 * The fourth pillar's screen: drift and ghost debt between this ledger and Splitwise.
 *
 * Nothing on this page writes to Splitwise, and it says so out loud. Re-syncing a `stale` row
 * remains separate, explicitly approved work that is deliberately not reachable from here
 * (ADR-0046) — reviewing a finding records what a person concluded, never an instruction to
 * correct either ledger.
 */
export default function SplitwisePage() {
  const [reviewStatus, setReviewStatus] = useState<SplitwiseAuditReviewStatus | "">("open");
  const [findingClass, setFindingClass] = useState<SplitwiseAuditFindingClass | "">("");
  const runs = useSplitwiseAuditRuns(10);
  const audit = useRunSplitwiseAudit();

  const latest = runs.data?.[0];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Splitwise audit"
        description="Where this ledger and Splitwise disagree, what each disagreement is actually evidence of, and what could not be checked at all. Nothing here writes to Splitwise."
        actions={
          <Button disabled={audit.isPending} onClick={() => audit.mutate()}>
            {audit.isPending ? "Auditing…" : "Run an audit"}
          </Button>
        }
      />

      {audit.isError && <ErrorBlock error={audit.error} />}

      {runs.isPending && (
        <LoadingStatus label="Loading audit history…">
          <TableSkeleton columns={3} rows={2} />
        </LoadingStatus>
      )}
      {runs.isError && <ErrorBlock error={runs.error} onRetry={() => void runs.refetch()} />}
      {runs.isSuccess && latest === undefined && (
        <EmptyBlock>
          No audit has been run yet. Running one reads Splitwise and records what it finds — it
          changes nothing on either side.
        </EmptyBlock>
      )}
      {latest !== undefined && <ExternalReadBanner run={latest} />}

      <Section
        title="Findings"
        headingId="findings-heading"
        description="Each one carries both compared snapshots, its evidence, the part of the gap it accounts for, and its confidence."
      >
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="review-status">Review state</Label>
            <Select
              id="review-status"
              value={reviewStatus}
              onChange={(event) =>
                setReviewStatus(event.target.value as SplitwiseAuditReviewStatus | "")
              }
              className="min-w-[160px]"
            >
              <option value="">Any state</option>
              {SPLITWISE_AUDIT_REVIEW_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {auditReviewStatusLabel(status)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="finding-class">Kind of finding</Label>
            <Select
              id="finding-class"
              value={findingClass}
              onChange={(event) =>
                setFindingClass(event.target.value as SplitwiseAuditFindingClass | "")
              }
              className="min-w-[200px]"
            >
              <option value="">Any kind</option>
              {SPLITWISE_AUDIT_FINDING_CLASSES.map((value) => (
                <option key={value} value={value}>
                  {auditFindingClassLabel(value)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <AuditFindingsList
          filter={{
            ...(reviewStatus === "" ? {} : { reviewStatus }),
            ...(findingClass === "" ? {} : { findingClass }),
            limit: 50,
          }}
        />
      </Section>

      <Section
        title="Audit history"
        headingId="audit-history-heading"
        description="Newest first. A rerun re-observes what is already on record rather than duplicating it."
      >
        {runs.isSuccess && runs.data.length > 0 && (
          <ul className="flex flex-col">
            {runs.data.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2.5 last:border-b-0"
              >
                <span className="tabular font-mono text-meta text-ink-muted">
                  {formatDateTime(run.runAt)}
                </span>
                <span className="text-meta text-ink-muted">
                  read {externalReadStatusLabel(run.externalReadStatus).toLowerCase()} ·{" "}
                  {run.findingsCreated} new · {run.findingsReobserved} re-observed ·{" "}
                  {run.findingsSuperseded} superseded
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
