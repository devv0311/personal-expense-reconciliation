"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { formatDate } from "@/lib/dates";
import { useAnomalies } from "@/lib/queries";
import type { Anomaly } from "@/lib/types";

/**
 * Things worth a second look, with the rows each one compared.
 *
 * [ADR-0063](../../../../docs/decisions/0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md).
 *
 * Four rules, and the first two are the reason this is calm rather than a dashboard of alerts:
 *
 *  - **No severity, no colour-coding, no count badge.** Every finding is one observation worth a
 *    glance. Ranking them would be a judgement the API did not make, and a red one would make the
 *    list feel like a problem when most of what it reports is ordinary.
 *  - **The API's words, verbatim.** The headline and the detail are written in the domain, where
 *    the rule about never accusing anybody is tested. This package must not add a verdict, a
 *    recommendation or an urgency on top of them.
 *  - **Nothing to accept or dismiss.** There is no decision here, because nothing was proposed.
 *    A finding stops being reported when the rows stop supporting it.
 *  - **Empty is an answer.** Over a ledger that was actually read, "nothing stood out" is the
 *    result, and it says so rather than rendering an empty container (`web/CLAUDE.md` rule 2).
 */
export function WorthALook() {
  const anomalies = useAnomalies();

  return (
    <Section
      title="Worth a look"
      headingId="worth-a-look"
      description="Comparisons between records on file. Nothing here has been decided, and nothing needs your answer."
    >
      {anomalies.isPending && (
        <LoadingStatus label="Comparing your records">
          <TableSkeleton columns={2} rows={2} />
        </LoadingStatus>
      )}

      {anomalies.isError && (
        <ErrorBlock error={anomalies.error} onRetry={() => void anomalies.refetch()} />
      )}

      {anomalies.isSuccess && anomalies.data.anomalies.length === 0 && (
        <EmptyBlock>
          <p className="text-body text-ink">Nothing stood out.</p>
          <p className="mt-1 max-w-prose text-meta text-ink-muted">
            {anomalies.data.rowsRead === 0
              ? "There are no records on file to compare yet."
              : `All ${String(anomalies.data.rowsRead)} records on file were compared. This is the list being empty, not a filter hiding something.`}
          </p>
        </EmptyBlock>
      )}

      {anomalies.isSuccess && anomalies.data.anomalies.length > 0 && (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {anomalies.data.anomalies.map((anomaly) => (
            <AnomalyRow key={anomaly.id} anomaly={anomaly} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  return (
    <li className="flex flex-col gap-3 py-5">
      <div className="min-w-0">
        <h3 className="text-body font-medium text-ink">{anomaly.headline}</h3>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">{anomaly.detail}</p>
      </div>

      {/*
        The evidence is the point. "Why are you telling me this?" has to be one tap away, or the
        finding is an assertion rather than a comparison.
      */}
      <div>
        <h4 className="text-micro text-ink-faint">
          {anomaly.evidence.length === 1 ? "The record this is about" : "The records compared"}
        </h4>
        <ul className="mt-1.5 flex flex-col gap-1">
          {anomaly.evidence.map((item) => (
            <li
              key={item.paymentId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"
            >
              <Link
                href={`/connections/${item.paymentId}`}
                className="min-w-0 flex-1 truncate text-meta text-accent underline underline-offset-2"
              >
                {item.narration === "" ? "Open this record" : item.narration}
              </Link>
              <span className="flex shrink-0 items-baseline gap-3">
                <Money paise={item.amount} />
                <span className="text-micro text-ink-faint">{formatDate(item.occurredAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}
