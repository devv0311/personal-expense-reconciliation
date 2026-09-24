"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import {
  useApproveRuleProposal,
  useDismissRuleProposal,
  useRestoreRuleProposal,
  useRuleProposals,
} from "@/lib/queries";
import type { LearnedRuleProposal } from "@/lib/types";

/**
 * Patterns the ledger could learn, offered for approval and active only once approved.
 *
 * [ADR-0064](../../../../docs/decisions/0064-a-pattern-is-a-proposal-a-person-approves-before-it-ever-matches.md).
 *
 * The product already learned from confirmations before this screen existed — invisibly, inside
 * a function. The point here is not that it learns more; it is that the learning became something
 * a person can read, judge and decline.
 *
 * Three rules shape it:
 *
 *  - **The wording is the thing being approved, so the wording is on screen.** "Learn from my
 *    Dining confirmations" is not judgeable. "Match any payment whose wording contains
 *    `HARBOUR CAFE`" is, and it is what the dialog quotes before the button.
 *  - **The consequence says what an approved pattern may and may not do.** It suggests; it never
 *    files anything. A reader who thinks they are switching on automatic categorisation has been
 *    misled by the screen, not by the rule.
 *  - **Declining is a decision too, and it sticks.** ADR-0064 left dismissal out on the grounds
 *    that it would be a second stored lifecycle. On a real ledger that meant a pattern declined
 *    once was re-offered forever, because the confirmations behind it never go away — so
 *    [ADR-0065](../../../../docs/decisions/0065-declining-a-pattern-is-a-decision-and-approving-one-shows-its-reach-first.md)
 *    records the dismissal with a reason, and offers it back rather than burying it.
 *  - **The reach is shown before the button.** The wording alone cannot tell anybody whether a
 *    pattern is too wide; what it would newly match can. Where that is not zero it leads.
 */
export function PatternsToApprove() {
  const proposals = useRuleProposals();
  const [pending, setPending] = useState<LearnedRuleProposal | null>(null);
  const [declining, setDeclining] = useState<LearnedRuleProposal | null>(null);
  const approve = useApproveRuleProposal();
  const dismiss = useDismissRuleProposal();
  const restore = useRestoreRuleProposal();

  return (
    <Section
      title="Patterns you could confirm"
      headingId="patterns-to-approve"
      description="Things you have filed the same way more than once. Nothing here is switched on, and approving one makes it suggest — never decide."
    >
      {proposals.isPending && (
        <LoadingStatus label="Looking at what you have already filed">
          <TableSkeleton columns={2} rows={2} />
        </LoadingStatus>
      )}

      {proposals.isError && (
        <ErrorBlock error={proposals.error} onRetry={() => void proposals.refetch()} />
      )}

      {proposals.isSuccess && proposals.data.proposals.length === 0 && (
        <EmptyBlock>
          <p className="text-body text-ink">No patterns to suggest yet.</p>
          <p className="mt-1 max-w-prose text-meta text-ink-muted">
            {proposals.data.confirmationsRead === 0
              ? "Once you have said what a few payments were for, anything you file the same way twice will show up here."
              : `Read ${String(proposals.data.confirmationsRead)} payments you have already filed. Nothing in them repeats often enough to be worth a rule.`}
          </p>
        </EmptyBlock>
      )}

      {proposals.isSuccess && proposals.data.proposals.length > 0 && (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {proposals.data.proposals.map((proposal) => (
            <li key={proposal.id} className="flex flex-col gap-3 py-5">
              <div className="min-w-0">
                <h3 className="text-body font-medium text-ink">
                  Always file{" "}
                  <span className="font-mono text-meta">&ldquo;{proposal.wording}&rdquo;</span> as{" "}
                  {proposal.category}?
                </h3>
                <p className="mt-1 max-w-prose text-meta text-ink-muted">{proposal.reason}</p>
              </div>

              <div>
                <h4 className="text-micro text-ink-faint">Because you filed these</h4>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {proposal.examples.map((example) => (
                    <li
                      key={example.paymentId}
                      className="flex flex-wrap items-baseline justify-between gap-x-4"
                    >
                      <span className="min-w-0 flex-1 truncate text-meta text-ink">
                        {example.narration}
                      </span>
                      <span className="shrink-0 text-micro text-ink-faint">
                        {formatDate(example.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <Reach proposal={proposal} />

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => {
                    approve.reset();
                    setPending(proposal);
                  }}
                >
                  Use this from now on
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    dismiss.reset();
                    setDeclining(proposal);
                  }}
                >
                  No, don&rsquo;t suggest this
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {proposals.isSuccess && proposals.data.dismissed.length > 0 && (
        <div className="mt-8">
          <h3 className="text-meta font-medium text-ink-muted">Patterns you turned down</h3>
          <p className="mt-1 max-w-prose text-micro text-ink-faint">
            Kept so you can see what you decided and change your mind. Nothing about the payments
            behind them changed.
          </p>
          <ul className="mt-2 flex flex-col divide-y divide-rule border-y border-rule">
            {proposals.data.dismissed.map((entry) => (
              <li
                key={entry.proposalKey}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
              >
                <span className="min-w-0">
                  <span className="block text-meta text-ink">
                    <span className="font-mono">&ldquo;{entry.wording}&rdquo;</span> as{" "}
                    {entry.category}
                  </span>
                  <span className="mt-0.5 block text-micro text-ink-faint">
                    {entry.reason} · {formatDate(entry.dismissedAt)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate({ proposalKey: entry.proposalKey, actor: "user" })}
                >
                  Offer it again
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <DecisionDialog
        open={declining !== null}
        onClose={() => {
          setDeclining(null);
          dismiss.reset();
        }}
        title="Stop suggesting this pattern"
        consequence={
          declining === null ? null : (
            <>
              This stops <strong className="font-mono">&ldquo;{declining.wording}&rdquo;</strong>{" "}
              being offered as a pattern. It is recorded with your reason, and you can bring it back
              from this page at any time.
              <br />
              <br />
              It changes nothing about the {declining.examples.length} payments you already filed,
              and nothing about how they are categorised.
            </>
          )
        }
        confirmLabel="Don't suggest this"
        confirmVariant="outline"
        reasonLabel="Why not?"
        reasonRequired
        pending={dismiss.isPending}
        error={dismiss.error}
        onConfirm={(reason) => {
          if (declining === null || reason === undefined) return;
          dismiss.mutate(
            { proposalId: declining.id, reason, actor: "user" },
            { onSuccess: () => setDeclining(null) },
          );
        }}
      />

      <DecisionDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          approve.reset();
        }}
        title="Use this pattern from now on"
        consequence={
          pending === null ? null : (
            <>
              From now on, any payment whose wording contains{" "}
              <strong className="font-mono">&ldquo;{pending.wording}&rdquo;</strong> will be{" "}
              <strong>suggested</strong> as {pending.category}, with this rule named beside it.
              <br />
              <br />
              It does not file anything. You will still be asked about every payment it matches, and
              you can pick something else. It changes nothing about the {
                pending.examples.length
              }{" "}
              payments you have already filed, and you can switch it off later under Rules.
              {pending.reach.wouldAlsoMatch > 0 && (
                <>
                  <br />
                  <br />
                  On what is on file today it would also start suggesting for{" "}
                  <strong>
                    {pending.reach.wouldAlsoMatch === 1
                      ? "1 other payment"
                      : `${String(pending.reach.wouldAlsoMatch)} other payments`}
                  </strong>
                  .
                </>
              )}
            </>
          )
        }
        confirmLabel="Use this pattern"
        reasonLabel="Note for the record"
        pending={approve.isPending}
        error={approve.error}
        onConfirm={(reason) => {
          if (pending === null) return;
          // The note goes to the audit trail, where every other recorded decision's does. The
          // rule keeps its suggested name; renaming is a separate edit under Rules.
          approve.mutate(
            {
              proposalId: pending.id,
              actor: "user",
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setPending(null) },
          );
        }}
      />
    </Section>
  );
}

/**
 * What this wording would actually reach.
 *
 * The confirmations are reassuring and go second. **What it would newly match goes first when it
 * is not zero**, because that is the only thing on screen that distinguishes a well-aimed pattern
 * from one that will start suggesting a category for a hardware shop. A count alone would be a
 * number to trust, so the examples are listed with it.
 */
function Reach({ proposal }: { proposal: LearnedRuleProposal }) {
  const { reach } = proposal;
  if (reach.wouldAlsoMatch === 0) {
    return (
      <p className="text-meta text-ink-muted">
        On what is on file today, this matches only the{" "}
        {reach.alreadyFiled === 1 ? "payment" : `${String(reach.alreadyFiled)} payments`} you
        already filed this way.
      </p>
    );
  }

  return (
    <div className="rounded-sm border border-rule bg-panel p-4">
      <p className="text-meta text-ink">
        It would also start suggesting{" "}
        <strong className="font-medium">
          {reach.wouldAlsoMatch === 1
            ? "1 other payment"
            : `${String(reach.wouldAlsoMatch)} other payments`}
        </strong>{" "}
        already on file. Check these look right before you use it:
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {reach.examplesOfNewMatches.map((example) => (
          <li
            key={example.paymentId}
            className="flex flex-wrap items-baseline justify-between gap-x-4"
          >
            <span className="min-w-0 flex-1 truncate text-meta text-ink">{example.narration}</span>
            <span className="shrink-0 text-micro text-ink-faint">
              {formatDate(example.occurredAt)}
            </span>
          </li>
        ))}
      </ul>
      {reach.wouldAlsoMatch > reach.examplesOfNewMatches.length && (
        <p className="mt-2 text-micro text-ink-faint">
          Showing {String(reach.examplesOfNewMatches.length)} of {String(reach.wouldAlsoMatch)}.
        </p>
      )}
    </div>
  );
}
