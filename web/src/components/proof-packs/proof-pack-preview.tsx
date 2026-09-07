"use client";

import Link from "next/link";
import { useState } from "react";
import { NoteList } from "@/components/annotations";
import { EvidenceStatus } from "@/components/evidence-status";
import { Fact, Facts } from "@/components/facts";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { evidenceTypeLabel, proofPackWarningLabel, refundBasisLabel } from "@/lib/labels";
import type { ProofPackPreview as Preview } from "@/lib/types";

/**
 * The fifth pillar's screen: a recipient-specific summary, reviewed before anything leaves.
 *
 * Two rules from ADR-0047 shape it, and one from this phase:
 *
 * - **Every figure is quoted, never recomputed.** The pack the API returns already contains the
 *   balance, each share, each net-after-refund and each settlement. A pack that re-divides a
 *   share is a bug; so would a screen that did.
 * - **Uncertainty is carried, not smoothed.** Every warning the pack raises is shown before the
 *   text, not after it, because the reader is deciding whether to send it.
 * - **Copying is a separate, deliberate act** (this phase's own). The three checkboxes below
 *   are the "recipient-facing review of exactly what is about to be sent" the roadmap asks for:
 *   who it is for, what it says, and which evidence it cites. Generating the pack sends
 *   nothing, records no settlement and writes no row — and neither does copying it.
 */
export function ProofPackPreview({ preview }: { preview: Preview }) {
  // Keyed on the pack's identity, so a different recipient or a different as-of instant starts
  // from an unreviewed state. Carrying a previous confirmation across packs would let someone
  // copy a message they never read.
  return (
    <ProofPackPreviewBody
      key={`${preview.intendedRecipient.id}:${preview.asOf}`}
      preview={preview}
    />
  );
}

function ProofPackPreviewBody({ preview }: { preview: Preview }) {
  const { pack } = preview;
  const [reviewed, setReviewed] = useState({ recipient: false, content: false, evidence: false });
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  const allReviewed = reviewed.recipient && reviewed.content && reviewed.evidence;

  return (
    <div className="flex flex-col gap-8">
      <div className="border-t-2 border-double border-rule-strong pt-4">
        <p className="text-meta text-ink-muted">
          {pack.netDirection === "settled"
            ? "Settled"
            : pack.netDirection === "recipient_owes_user"
              ? `${pack.recipient.displayName} owes you`
              : `You owe ${pack.recipient.displayName}`}
        </p>
        <Money
          paise={pack.amountOwed}
          size="figure"
          tone={pack.netDirection === "settled" ? "credit" : "neutral"}
          className="mt-1 block"
        />
        <div className="mt-3 flex flex-wrap items-baseline gap-4">
          <EvidenceStatus status={pack.evidenceStatus} />
          <span className="text-meta text-ink-faint">
            As of {formatDateTime(pack.asOf)} — a snapshot label, not a historical filter
          </span>
        </div>
      </div>

      {preview.warnings.length > 0 && (
        <Section
          title="Before you send this"
          headingId="pack-warnings"
          description="Everything about this pair that is not settled fact. None of it is smoothed away in the text below."
        >
          <NoteList
            items={preview.warnings.map((warning) => ({
              title: proofPackWarningLabel(warning.code),
              detail: warning.message,
            }))}
          />
        </Section>
      )}

      <Section
        title="What it says"
        headingId="pack-lines"
        description="Each contributing expense, with the original amount, what came back, and the recipient's share of the rest."
      >
        {pack.expenseLines.length === 0 ? (
          <p className="text-body text-ink-muted">
            No shared expenses between you and {pack.recipient.displayName}.
          </p>
        ) : (
          <ResponsiveTable
            caption="Expenses this pack quotes"
            minWidth="620px"
            rows={pack.expenseLines}
            rowKey={(line) => line.expenseId}
            rowNote={(line) => (
              <>
                <span className="mt-0.5 block text-micro text-ink-faint">
                  {formatDate(line.occurredAt)} · {line.payer === "you" ? "you paid" : "they paid"}{" "}
                  · {refundBasisLabel(line.refundBasis).toLowerCase()}
                </span>
                {(line.pendingDistribution || line.reviewRequired !== null) && (
                  <span className="mt-0.5 block text-micro text-attention">
                    {line.reviewRequired !== null
                      ? "A refund on this expense needs a decision before it can be allocated."
                      : "A refund on this expense has not reached the allocation yet."}
                  </span>
                )}
                {line.conflictingEvidence && (
                  <span className="mt-0.5 block text-micro text-attention">
                    Two evidence records about this payment disagree.
                  </span>
                )}
              </>
            )}
            columns={[
              {
                key: "expense",
                header: "Expense",
                render: (line) => (
                  <Link
                    href={`/expenses/${line.expenseId}`}
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    {line.description}
                  </Link>
                ),
              },
              {
                key: "paid",
                header: "Paid",
                align: "right",
                render: (line) => <Money paise={line.grossAmount} />,
              },
              {
                key: "came-back",
                header: "Came back",
                align: "right",
                render: (line) => (
                  <>
                    <Money paise={line.attributedItemRefunds} />
                    {line.unattributedRefunds !== "0" && (
                      <span className="mt-0.5 block text-micro text-ink-faint">
                        + <Money paise={line.unattributedRefunds} className="text-micro" /> whole
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: "net",
                header: "Net",
                align: "right",
                render: (line) => <Money paise={line.netAmount} />,
              },
              {
                key: "share",
                header: "Their share",
                align: "right",
                render: (line) => <Money paise={line.recipientShare} />,
              },
            ]}
          />
        )}
      </Section>

      {pack.settlements.length > 0 && (
        <Section
          title="Already settled between you"
          headingId="pack-settlements"
          description="Recorded settlements stay recorded, even when a later refund leaves the balance running the other way."
        >
          <ul className="flex flex-col">
            {pack.settlements.map((settlement) => (
              <li
                key={settlement.settlementId}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0"
              >
                <span className="text-body text-ink">
                  {settlement.direction === "you_paid_recipient"
                    ? `You paid ${pack.recipient.displayName}`
                    : `${pack.recipient.displayName} paid you`}
                  <span className="ml-2 text-meta text-ink-muted">
                    {formatDate(settlement.occurredAt)}
                  </span>
                </span>
                <Money paise={settlement.amount} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {pack.openAuditFindings.length > 0 && (
        <Section
          title="Open Splitwise findings touching this pair"
          headingId="pack-findings"
          description="An unresolved finding means these facts are not settled. The pack says so rather than quoting a confident balance over it."
        >
          <ul className="flex flex-col">
            {pack.openAuditFindings.map((finding) => (
              <li key={finding.findingId} className="border-b border-rule py-2 last:border-b-0">
                <Link
                  href={`/splitwise/findings/${finding.findingId}`}
                  className="text-body text-accent underline-offset-2 hover:underline"
                >
                  {finding.summary}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Supporting evidence it cites"
        headingId="pack-evidence"
        description="Labels only, already redacted. The documents themselves never leave this machine."
      >
        {preview.evidenceReferences.length === 0 ? (
          <p className="text-body text-attention">This pack cites no supporting evidence.</p>
        ) : (
          <ul className="flex flex-col">
            {preview.evidenceReferences.map((reference) => (
              <li
                key={reference.evidenceId}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0"
              >
                <Link
                  href={`/evidence/${reference.evidenceId}`}
                  className="text-body text-accent underline-offset-2 hover:underline"
                >
                  {reference.label ?? evidenceTypeLabel(reference.type)}
                </Link>
                <span className="tabular font-mono text-meta text-ink-muted">
                  {formatDate(reference.capturedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Exactly what would be sent"
        headingId="pack-text"
        description="The message, verbatim. Free text in it has already been through the redaction boundary; an unredacted pack is refused rather than returned."
      >
        <pre
          data-testid="proof-pack-text"
          className="overflow-x-auto rounded-sm border border-rule bg-panel p-4 font-mono text-meta whitespace-pre-wrap text-ink"
        >
          {preview.generatedText}
        </pre>
      </Section>

      <Section
        title="Review before copying"
        headingId="pack-review"
        description="Nothing is sent from this app. Copying puts the text on your clipboard so you can send it yourself — which is the moment it stops being private."
      >
        <Facts className="mb-4">
          <Fact label="Intended recipient">
            {preview.intendedRecipient.displayName}
            <span className="ml-2 font-mono text-meta text-ink-faint">
              {preview.intendedRecipient.id.slice(0, 8)}
            </span>
          </Fact>
          <Fact label="Nobody else is named">
            Only you and {preview.intendedRecipient.displayName} appear in this pack.
          </Fact>
        </Facts>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-meta text-ink-muted">Confirm you have read each part</legend>
          <Checkbox
            id="review-recipient"
            checked={reviewed.recipient}
            onChange={(recipient) => setReviewed((current) => ({ ...current, recipient }))}
          >
            The recipient is {preview.intendedRecipient.displayName}.
          </Checkbox>
          <Checkbox
            id="review-content"
            checked={reviewed.content}
            onChange={(content) => setReviewed((current) => ({ ...current, content }))}
          >
            I have read the message above, including{" "}
            {preview.warnings.length === 0
              ? "the figures it quotes"
              : `the ${preview.warnings.length} thing${preview.warnings.length === 1 ? "" : "s"} it flags as not settled`}
            .
          </Checkbox>
          <Checkbox
            id="review-evidence"
            checked={reviewed.evidence}
            onChange={(evidence) => setReviewed((current) => ({ ...current, evidence }))}
          >
            I have checked which evidence it cites.
          </Checkbox>
        </fieldset>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={!allReviewed}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(preview.generatedText)
                .then(() => setCopied("done"))
                .catch(() => setCopied("failed"));
            }}
          >
            Copy the message
          </Button>
          {copied === "done" && (
            <span role="status" className="text-meta text-credit">
              Copied. Nothing was sent and nothing was recorded — sending it is up to you.
            </span>
          )}
          {copied === "failed" && (
            <span role="status" className="text-meta text-debit">
              Your browser blocked clipboard access. Select the text above and copy it manually.
            </span>
          )}
          {!allReviewed && (
            <span className="text-meta text-ink-muted">Confirm all three before copying.</span>
          )}
        </div>
      </Section>
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 accent-accent"
      />
      <label htmlFor={id} className="text-body text-ink">
        {children}
      </label>
    </div>
  );
}
