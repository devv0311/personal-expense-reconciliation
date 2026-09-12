"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
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
} from "@/lib/labels";
import { useDiscoverRemoteChanges, useRemoteChanges, useRemoteReads } from "@/lib/queries";
import { SPLITWISE_REMOTE_CHANGE_STATUSES, type SplitwiseRemoteChangeStatus } from "@/lib/types";

/**
 * What somebody changed in Splitwise, and what this ledger proposes doing about it
 * (ADR-0056).
 *
 * The counterpart of the repair section above it, and the opposite direction of travel — so
 * the rule that governs it is the opposite one too. The repair writes a figure into somebody
 * else's ledger; this writes **nothing financial into ours**. Accepting a change records what
 * Splitwise holds, closes a sync row, joins two ids or maps a person; making their figure true
 * here stays an adjustment somebody records with evidence.
 *
 * Every consequence rendered here is the API's own sentence. Working out from
 * `kind` what accepting would do would be a second copy of a rule that has to agree with the
 * service forever (ADR-0048), which is the same argument `resync-candidates.tsx` makes about
 * `plannedRepair`.
 */
export function RemoteChanges() {
  const [status, setStatus] = useState<SplitwiseRemoteChangeStatus | "">("proposed");
  const changes = useRemoteChanges({ ...(status === "" ? {} : { status }), limit: 50 });
  const reads = useRemoteReads(5);
  const discover = useDiscoverRemoteChanges();

  const latest = reads.data?.reads[0];

  return (
    <Section
      title="Changes made in Splitwise"
      headingId="remote-changes"
      description="What somebody edited, deleted or added on their side, with both figures side by side. Accepting one records what they hold — it never moves a figure here."
      actions={
        <Button variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>
          {discover.isPending ? "Checking…" : "Check for changes"}
        </Button>
      }
    >
      {discover.isError && <ErrorBlock error={discover.error} />}

      {latest !== undefined && latest.externalReadStatus !== "complete" && (
        <Alert variant="attention">
          <AlertTitle>
            The last check read {externalReadStatusLabel(latest.externalReadStatus).toLowerCase()}.
          </AlertTitle>
          <AlertDescription>
            <p>
              {externalReadStatusDetail(latest.externalReadStatus)}{" "}
              {latest.externalReadDetail ?? ""}
            </p>
            <p className="mt-2">
              Nothing was reported as deleted from what could not be read: an entry missing from a
              page is an entry nobody looked for.{" "}
              {latest.pairsRead === 0
                ? "No pair could even be listed, so nothing on either side was compared."
                : `${latest.pairsUnchecked} of ${latest.pairsRead} people could not be checked at all.`}
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="remote-change-status">Decision state</Label>
          <Select
            id="remote-change-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as SplitwiseRemoteChangeStatus | "")}
            className="min-w-[180px]"
          >
            <option value="">Any state</option>
            {SPLITWISE_REMOTE_CHANGE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {remoteChangeStatusLabel(value)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {changes.isPending && (
        <LoadingStatus label="Loading changes made in Splitwise…">
          <TableSkeleton columns={4} rows={2} />
        </LoadingStatus>
      )}
      {changes.isError && (
        <ErrorBlock error={changes.error} onRetry={() => void changes.refetch()} />
      )}

      {changes.isSuccess && changes.data.changes.length === 0 && (
        <EmptyBlock>
          {latest === undefined
            ? "Nothing has been checked yet. Checking reads Splitwise and records what differs — it changes nothing on either side."
            : status === "proposed"
              ? "Nothing on their side is waiting on a decision. That is a statement about what the last check could read, not a claim that the two ledgers agree about everything."
              : "No changes match that filter."}
        </EmptyBlock>
      )}

      {changes.isSuccess && changes.data.changes.length > 0 && (
        <ResponsiveTable
          caption="Changes somebody made in Splitwise"
          minWidth="680px"
          rows={[...changes.data.changes]}
          rowKey={(change) => change.id}
          columns={[
            {
              key: "kind",
              header: "What happened",
              render: (change) => (
                <Link
                  href={`/splitwise/remote-changes/${change.id}`}
                  className="text-accent underline underline-offset-2"
                >
                  {remoteChangeKindLabel(change.kind)}
                </Link>
              ),
            },
            {
              key: "effect",
              header: "What accepting does",
              render: (change) => (
                <span className="text-ink-muted">{remoteChangeEffectLabel(change.effect)}</span>
              ),
            },
            {
              key: "read",
              header: "Seen under",
              secondary: true,
              render: (change) => (
                <span
                  className={change.readStatus === "complete" ? "text-ink-muted" : "text-attention"}
                >
                  {externalReadStatusLabel(change.readStatus)}
                </span>
              ),
            },
            {
              key: "observed",
              header: "First seen",
              secondary: true,
              render: (change) => (
                <span className="text-meta text-ink-muted">
                  {formatDateTime(change.firstObservedAt)}
                </span>
              ),
            },
            {
              key: "status",
              header: "State",
              render: (change) => (
                <span
                  className={change.status === "proposed" ? "text-attention" : "text-ink-muted"}
                >
                  {remoteChangeStatusLabel(change.status)}
                </span>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              render: (change) =>
                change.amount === null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <Money paise={change.amount} />
                ),
            },
          ]}
        />
      )}

      {reads.isSuccess && reads.data.reads.length > 0 && (
        <ul className="mt-6 flex flex-col">
          {reads.data.reads.map((read) => (
            <li
              key={read.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2.5 last:border-b-0"
            >
              <span className="tabular font-mono text-meta text-ink-muted">
                {formatDateTime(read.runAt)}
              </span>
              <span className="text-meta text-ink-muted">
                read {externalReadStatusLabel(read.externalReadStatus).toLowerCase()} ·{" "}
                {read.pairsRead - read.pairsUnchecked}/{read.pairsRead} people checked ·{" "}
                {read.changesCreated} new · {read.changesReobserved} re-observed ·{" "}
                {read.changesSuperseded} superseded
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
