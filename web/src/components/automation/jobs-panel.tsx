"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import { jobKindLabel, jobStatusLabel } from "@/lib/labels";
import { useCancelJob, useJobs, useRetryJob } from "@/lib/queries";
import { JOB_STATUSES, type JobRecord, type JobStatus } from "@/lib/types";

/**
 * The background queue: work the system performs out of band.
 *
 * A job never makes a financial decision. Each kind is an orchestration of service calls that
 * already refuse to write approved state without a person — importing, normalizing, asking a
 * model, reading a receipt. What a job produces is a queue item, never an approval.
 *
 * A failure stays visible with its error and its attempt count rather than disappearing.
 * Nothing here retries on its own: giving up and trying again are both a person's call, which
 * is why `cancelled` is only ever reached by one.
 */
export function JobsPanel() {
  const [status, setStatus] = useState<JobStatus | "">("");
  const [cancelling, setCancelling] = useState<JobRecord | null>(null);

  const jobs = useJobs(status === "" ? {} : { status });
  const retry = useRetryJob();
  const cancel = useCancelJob();

  return (
    <Section
      title="Background work"
      headingId="jobs"
      description="Imports, normalization, model calls and audits queued to run out of band. None of them approves anything."
      actions={
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="job-status" className="sr-only">
            Status
          </Label>
          <Select
            id="job-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as JobStatus | "")}
            className="min-w-[150px]"
          >
            <option value="">Any status</option>
            {JOB_STATUSES.map((option) => (
              <option key={option} value={option}>
                {jobStatusLabel(option)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {jobs.isPending && (
        <LoadingStatus label="Loading the queue…">
          <TableSkeleton columns={4} />
        </LoadingStatus>
      )}
      {jobs.isError && <ErrorBlock error={jobs.error} onRetry={() => void jobs.refetch()} />}
      {jobs.isSuccess && jobs.data.jobs.length === 0 && (
        <EmptyBlock>
          Nothing is queued. Every run so far has been one somebody started by hand.
        </EmptyBlock>
      )}
      {jobs.isSuccess && jobs.data.jobs.length > 0 && (
        <ResponsiveTable
          caption="Background jobs"
          minWidth="560px"
          rows={jobs.data.jobs}
          rowKey={(job) => job.id}
          columns={[
            {
              key: "kind",
              header: "Work",
              render: (job) => (
                <>
                  {jobKindLabel(job.kind)}
                  <span className="block text-micro text-ink-faint">
                    queued {formatDateTime(job.createdAt)} by {job.actor}
                  </span>
                </>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (job) => (
                <span className={job.status === "failed" ? "text-attention" : "text-ink"}>
                  {jobStatusLabel(job.status)}
                  {job.lastError !== null && (
                    <span className="block text-micro text-attention">{job.lastError}</span>
                  )}
                </span>
              ),
            },
            {
              key: "attempts",
              header: "Attempts",
              align: "right",
              secondary: true,
              render: (job) => (
                <span className="tabular font-mono text-meta text-ink-muted">
                  {job.attempts} of {job.maxAttempts}
                </span>
              ),
            },
            {
              key: "actions",
              header: "Actions",
              align: "right",
              render: (job) => (
                <span className="flex justify-end gap-2">
                  {job.status === "failed" && (
                    <Button
                      variant="link"
                      size="sm"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(job.id)}
                    >
                      Retry
                    </Button>
                  )}
                  {(job.status === "queued" || job.status === "failed") && (
                    <Button variant="link" size="sm" onClick={() => setCancelling(job)}>
                      Cancel
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}

      <DecisionDialog
        open={cancelling !== null}
        onClose={() => {
          setCancelling(null);
          cancel.reset();
        }}
        title="Cancel this job"
        consequence={
          <>
            This stops the job before it runs. Cancelling is permanent — a cancelled job is not
            retried, and whatever it would have done stays undone until somebody queues it again.
            Nothing already written is undone by this.
          </>
        }
        confirmLabel="Cancel it"
        confirmVariant="outline"
        reasonLabel="Why"
        pending={cancel.isPending}
        error={cancel.error}
        onConfirm={(reason) => {
          if (cancelling === null) return;
          cancel.mutate(
            { jobId: cancelling.id, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setCancelling(null) },
          );
        }}
      />
    </Section>
  );
}
