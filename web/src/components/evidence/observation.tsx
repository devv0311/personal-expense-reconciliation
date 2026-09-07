import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { formatDateTime } from "@/lib/dates";
import { sentenceCase } from "@/lib/labels";
import type { EvidenceObservationView } from "@/lib/types";

/**
 * The structured reading of one evidence record (Phase 17, ADR-0044).
 *
 * Every field can legitimately be absent, and absent is rendered as absent — an SMS that never
 * stated a reference has no reference, which is a different fact from a reference of `""`. The
 * derivation line matters too: a reading parsed off the text and one an importer supplied are
 * different claims about where the number came from.
 */
export function EvidenceObservationFacts({
  observation,
}: {
  observation: EvidenceObservationView;
}) {
  return (
    <Facts>
      <Fact label="Amount" mono>
        {observation.observedAmount === null ? (
          <UnknownValue>Not stated</UnknownValue>
        ) : (
          <Money paise={observation.observedAmount} />
        )}
      </Fact>
      <Fact label="Direction">
        {observation.observedDirection === null ? (
          <UnknownValue>Not stated</UnknownValue>
        ) : (
          sentenceCase(observation.observedDirection)
        )}
      </Fact>
      <Fact label="Reference" mono>
        {observation.observedReference === null ? (
          <UnknownValue>Not stated</UnknownValue>
        ) : (
          <>
            {observation.observedReference}
            {observation.observedReferenceType !== null && (
              <span className="ml-2 font-sans text-meta text-ink-muted">
                {observation.observedReferenceType.toUpperCase()}
              </span>
            )}
          </>
        )}
      </Fact>
      <Fact label="Account hint" mono hint="A masked tail only">
        {observation.observedAccountHint ?? <UnknownValue>Not stated</UnknownValue>}
      </Fact>
      <Fact label="Merchant text">
        {observation.observedMerchantText ?? <UnknownValue>Not stated</UnknownValue>}
      </Fact>
      <Fact label="Instant" mono>
        {observation.observedOccurredAt === null ? (
          <UnknownValue>Not stated</UnknownValue>
        ) : (
          formatDateTime(observation.observedOccurredAt)
        )}
      </Fact>
      <Fact label="Derived by">
        {observation.derivation === "parsed_from_text"
          ? "Parsed from the text, deterministically"
          : "Supplied by the importer"}
      </Fact>
    </Facts>
  );
}
