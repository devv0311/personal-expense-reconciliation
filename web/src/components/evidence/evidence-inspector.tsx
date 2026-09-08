"use client";

import Link from "next/link";
import { NoteList } from "@/components/annotations";
import { EvidenceMatchCandidates } from "@/components/evidence/match-candidates";
import { EvidenceObservationFacts } from "@/components/evidence/observation";
import { ObservationEditor } from "@/components/evidence/observation-editor";
import { ReceiptReview } from "@/components/evidence/receipt-review";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { evidenceTypeLabel } from "@/lib/labels";
import {
  useEnrichEvidence,
  useEvidence,
  useEvidenceMatches,
  useEvidenceObservation,
} from "@/lib/queries";

/**
 * One evidence record, in full: what it is, what was read off it, what it could be about, and
 * whether it is attached to anything.
 *
 * The raw text is shown verbatim, because that is the point of an evidence inspector — this is
 * the immutable source, and the structured reading sits beside it rather than replacing it
 * (`invariants.md` #2/#4). Everything on this screen stays behind the local boundary: nothing
 * here is what a proof pack exports, and the proof-pack screen redacts separately.
 */
export function EvidenceInspector({ evidenceId }: { evidenceId: string }) {
  const evidence = useEvidence(evidenceId);
  const observation = useEvidenceObservation(evidenceId);
  const matches = useEvidenceMatches(evidenceId);
  const enrich = useEnrichEvidence();

  if (evidence.isPending) {
    return (
      <LoadingStatus label="Loading this document…">
        <TableSkeleton columns={2} rows={5} />
      </LoadingStatus>
    );
  }
  if (evidence.isError) {
    return <ErrorBlock error={evidence.error} onRetry={() => void evidence.refetch()} />;
  }

  const record = evidence.data;
  const linked = record.linkedPaymentId !== null || record.linkedExpenseId !== null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={evidenceTypeLabel(record.type)}
        description={
          linked
            ? "Attached. Evidence linkage is write-once, so this cannot be re-pointed at something else."
            : "Attached to nothing yet. Accepting one of the offers below is the only way to attach it."
        }
      />

      <Section title="The record" headingId="evidence-record">
        <Facts>
          <Fact label="Id" mono>
            {record.id}
          </Fact>
          <Fact label="Captured" mono>
            {formatDateTime(record.capturedAt)}
          </Fact>
          <Fact label="Ingested" mono>
            {formatDateTime(record.createdAt)}
          </Fact>
          <Fact label="Note kind">
            {record.noteKind ?? <UnknownValue>Not a note</UnknownValue>}
          </Fact>
          <Fact label="Attached to">
            {record.linkedPaymentId !== null ? (
              <Link
                href={`/payments/${record.linkedPaymentId}`}
                className="text-accent underline underline-offset-2"
              >
                A payment
              </Link>
            ) : record.linkedExpenseId !== null ? (
              <Link
                href={`/expenses/${record.linkedExpenseId}`}
                className="text-accent underline underline-offset-2"
              >
                An expense
              </Link>
            ) : (
              <UnknownValue>Nothing</UnknownValue>
            )}
          </Fact>
          {record.mediaType !== null && (
            <Fact label="Stored document">
              <a
                href={`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/evidence/${record.id}/content`}
                className="text-accent underline underline-offset-2"
                target="_blank"
                rel="noreferrer"
              >
                Open the {record.mediaType} file
              </a>
              {record.byteSize !== null && (
                <span className="ml-2 text-meta text-ink-muted">{record.byteSize} bytes</span>
              )}
            </Fact>
          )}
        </Facts>
      </Section>

      {record.rawText !== null && (
        <Section
          title="The source, verbatim"
          headingId="evidence-source"
          description="Stored exactly as it arrived and never rewritten. This stays local — it is not what a proof pack exports."
        >
          <pre className="overflow-x-auto rounded-sm border border-rule bg-panel p-3 font-mono text-meta whitespace-pre-wrap text-ink">
            {record.rawText}
          </pre>
        </Section>
      )}

      <Section
        title="What was read off it"
        headingId="evidence-observation"
        description="A structured reading, derived deterministically — never by a model."
        actions={
          observation.isSuccess ? (
            <ObservationEditor evidenceId={evidenceId} observation={observation.data} />
          ) : undefined
        }
      >
        {observation.isPending && (
          <LoadingStatus label="Loading the reading…">
            <TableSkeleton columns={2} rows={3} />
          </LoadingStatus>
        )}
        {observation.isError && (
          <ErrorBlock error={observation.error} onRetry={() => void observation.refetch()} />
        )}
        {observation.isSuccess &&
          (observation.data !== null ? (
            <EvidenceObservationFacts observation={observation.data} />
          ) : (
            <EmptyBlock>
              Nothing has read this document into structured form. Run &ldquo;Find candidates&rdquo;
              below to parse it and record what it could be about — that reads, it does not attach.
            </EmptyBlock>
          ))}
      </Section>

      {record.receiptId !== null && <ReceiptReview receiptId={record.receiptId} />}

      <Section
        title="Payments this could be about"
        headingId="evidence-candidates"
        description="Every offer with the six signals behind it. Accepting one is a permanent, explicit act."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={enrich.isPending}
            onClick={() => enrich.mutate(evidenceId)}
          >
            {enrich.isPending ? "Looking…" : "Find candidates"}
          </Button>
        }
      >
        {enrich.data?.outcome === "already_linked" && (
          <NoteList
            items={[
              {
                title: "Already attached",
                detail:
                  "Linkage is write-once, so there is no candidate worth offering. Superseding " +
                  "evidence is the remedy if this was wrong.",
              },
            ]}
          />
        )}
        {enrich.data?.outcome === "no_observation" && (
          <NoteList
            items={[
              {
                title: "Nothing could be read off this document",
                detail:
                  "No extracted total and no parseable text, so there is nothing to match on. " +
                  "That is an outcome, not an error.",
              },
            ]}
          />
        )}
        {matches.isPending && (
          <LoadingStatus label="Loading candidates…">
            <TableSkeleton columns={4} rows={2} />
          </LoadingStatus>
        )}
        {matches.isError && (
          <ErrorBlock error={matches.error} onRetry={() => void matches.refetch()} />
        )}
        {matches.isSuccess && (
          <EvidenceMatchCandidates
            evidenceId={evidenceId}
            candidates={matches.data.candidates}
            enrichError={enrich.error}
          />
        )}
      </Section>
    </div>
  );
}
