"use client";

import Link from "next/link";
import { useState } from "react";
import { BackLink } from "@/components/back-link";
import { PageHeader, Section } from "@/components/page-header";
import { ImportStatementForm } from "@/components/payments/import-statement";
import { PipelineActions } from "@/components/payments/pipeline-actions";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { sourceChannelLabel } from "@/lib/labels";
import { useImports } from "@/lib/queries";

const PAGE_SIZE = 20;

/**
 * What has been loaded into this ledger, and the one control that loads more.
 *
 * The history is not decoration: every payment carries the batch it arrived in, so this list is
 * how a movement's provenance is read back — including the ones that were typed in by hand,
 * which get their own batch precisely so they never look like they came off a statement.
 */
export default function ImportPage() {
  const [offset, setOffset] = useState(0);
  const imports = useImports({ limit: PAGE_SIZE, offset });

  return (
    <div className="flex flex-col gap-8">
      <BackLink href="/payments">Payments</BackLink>

      <PageHeader
        title="Import a statement"
        description="One CSV at a time, all-or-nothing. A file that has already been loaded is recognised and not written twice."
      />

      <ImportStatementForm />

      <Section
        title="Then interpret what arrived"
        headingId="pipeline"
        description="Imported rows are unexplained until something explains them. These two runs are the deterministic step and the model step, in that order."
      >
        <PipelineActions eligibleLabel="everything still waiting, across every batch" />
      </Section>

      <Section
        title="What has been loaded"
        headingId="history"
        description="Newest first. Every payment names the batch it came from, so provenance survives."
      >
        {imports.isPending && (
          <LoadingStatus label="Loading import history…">
            <TableSkeleton columns={4} />
          </LoadingStatus>
        )}
        {imports.isError && (
          <ErrorBlock error={imports.error} onRetry={() => void imports.refetch()} />
        )}
        {imports.isSuccess && imports.data.batches.length === 0 && (
          <EmptyBlock>Nothing has been imported yet.</EmptyBlock>
        )}
        {imports.isSuccess && imports.data.batches.length > 0 && (
          <div className="flex flex-col gap-4">
            <Table className="min-w-[560px]">
              <TableCaption>Import history</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Loaded</TableHead>
                  <TableHead scope="col">Source</TableHead>
                  <TableHead scope="col" className="text-right">
                    Rows
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Ignored as duplicates
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.data.batches.map((batch) => (
                  <TableRow key={batch.id} className="align-top">
                    <TableCell>
                      <Link
                        href={`/payments?importBatchId=${batch.id}`}
                        className="text-accent underline underline-offset-2"
                      >
                        {formatDateTime(batch.importedAt)}
                      </Link>
                      {batch.fileReference !== null && (
                        <div className="mt-0.5 text-meta text-ink-muted">{batch.fileReference}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {sourceChannelLabel(batch.sourceChannel)}
                      {batch.parserVersion !== null && (
                        <div className="mt-0.5 text-micro text-ink-faint">
                          parser {batch.parserVersion}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right font-mono">
                      {batch.paymentCount}
                    </TableCell>
                    <TableCell className="tabular text-right font-mono">
                      {batch.ignoredCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
              <p className="text-meta text-ink-muted">
                Showing {offset + 1}–{offset + imports.data.batches.length} of{" "}
                <span className="tabular font-mono">{imports.data.total}</span> batches.
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
                  disabled={offset + imports.data.batches.length >= imports.data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
