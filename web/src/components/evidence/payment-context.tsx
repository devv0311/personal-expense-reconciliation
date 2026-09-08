"use client";

import Link from "next/link";
import { NoteList } from "@/components/annotations";
import { EvidenceObservationFacts } from "@/components/evidence/observation";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { evidenceTypeLabel, sentenceCase } from "@/lib/labels";
import { usePaymentContext } from "@/lib/queries";
import type { ContextValue } from "@/lib/types";

/**
 * The first pillar, on one screen: what the attached evidence says about a payment, beside the
 * narration the bank actually wrote.
 *
 * Three rules from ADR-0044 are visible in the layout rather than described in a caption:
 *
 * - **The narration is never replaced.** It is the first thing on the screen, verbatim, and
 *   the reconstruction sits in its own section below it.
 * - **Disagreements are named, not resolved.** Where two sources — or a source and the ledger
 *   — say different things, both values are shown with who said them.
 * - **A value is only as good as its corroboration**, so every candidate carries the count of
 *   evidence records asserting it.
 */
export function PaymentContext({ paymentId }: { paymentId: string }) {
  const query = usePaymentContext(paymentId);

  if (query.isPending) {
    return (
      <LoadingStatus label="Loading this payment's context…">
        <TableSkeleton columns={2} rows={5} />
      </LoadingStatus>
    );
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  }

  const context = query.data.context;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Payment context"
        description="What the bank wrote, and what the evidence attached to it adds. Nothing here rewrites the narration."
      />

      <Section
        title="Narration, as the bank wrote it"
        headingId="context-narration"
        description="Immutable source. Never replaced by an interpretation of it."
      >
        <p className="rounded-sm border border-rule bg-panel p-3 font-mono text-body break-all text-ink">
          {context.narration}
        </p>
      </Section>

      {context.conflicts.length > 0 && (
        <Section
          title="Where the sources disagree"
          headingId="context-conflicts"
          description="Reported, never resolved — this system does not pick a winner between two records."
        >
          <NoteList
            items={context.conflicts.map((conflict) => ({
              title: `${sentenceCase(conflict.field)}: sources disagree`,
              detail: (
                <>
                  {conflict.detail}
                  <span className="mt-1 block font-mono text-meta">
                    {conflict.values.map((value) => value.value).join("  ·  ")}
                  </span>
                </>
              ),
            }))}
          />
        </Section>
      )}

      <Section
        title="What the evidence adds"
        headingId="context-reattached"
        description="Merchant names, references and instants a statement line does not carry, most-corroborated first."
      >
        <Facts>
          <Fact label="Merchant candidates">
            <ContextValues values={context.merchantCandidates} />
          </Fact>
          <Fact label="References" mono>
            <ContextValues values={context.references} />
          </Fact>
          <Fact label="Instants stated" mono>
            <ContextValues values={context.observedInstants} />
          </Fact>
          <Fact label="Sources read">
            {context.observedSourceCount} of {context.sources.length}
          </Fact>
        </Facts>
      </Section>

      <Section
        title="Contributing evidence"
        headingId="context-sources"
        description="Every attached record, oldest capture first. Several records enrich one movement — they are not several movements."
      >
        {context.sources.length === 0 ? (
          <EmptyBlock>
            No evidence is attached to this payment. Its narration is all the ledger has.
          </EmptyBlock>
        ) : (
          <ul className="flex flex-col gap-6">
            {context.sources.map((source) => (
              <li
                key={source.evidenceId}
                className="border-t border-rule pt-4 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <Link
                    href={`/evidence/${source.evidenceId}`}
                    className="text-body text-accent underline underline-offset-2"
                  >
                    {evidenceTypeLabel(source.evidenceType)}
                  </Link>
                  <span className="tabular font-mono text-meta text-ink-muted">
                    {formatDateTime(source.capturedAt)}
                  </span>
                </div>
                <div className="mt-2">
                  {source.observation === null ? (
                    <p className="text-meta text-ink-faint italic">
                      Attached, but never read into structured form.
                    </p>
                  ) : (
                    <EvidenceObservationFacts
                      observation={{ ...source.observation, evidenceId: source.evidenceId }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ContextValues({ values }: { values: readonly ContextValue[] }) {
  if (values.length === 0) return <UnknownValue>Nothing stated</UnknownValue>;
  return (
    <span className="flex flex-col items-end gap-0.5">
      {values.map((value) => (
        <span key={value.value}>
          {value.value}
          <span className="ml-2 font-sans text-micro text-ink-faint">
            {value.evidenceIds.length === 1 ? "1 source" : `${value.evidenceIds.length} sources`}
          </span>
        </span>
      ))}
    </span>
  );
}
