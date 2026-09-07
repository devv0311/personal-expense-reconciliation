"use client";

import Link from "next/link";
import { NoteList } from "@/components/annotations";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import {
  accountTypeLabel,
  cashDiscrepancyLabel,
  verificationStatusDetail,
  verificationStatusLabel,
} from "@/lib/labels";
import { useAccountSnapshots, useAccounts } from "@/lib/queries";
import type {
  AccountSummary,
  ReconciliationAccountSnapshot,
  ReconciliationVerificationStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The third pillar: ADR-0017's second identity, per account, as a waterfall.
 *
 * ```text
 * opening + credits − debits = expected        vs.  the statement's actual closing
 * actual − expected          = cash delta
 * ```
 *
 * Three rules are load-bearing here and are the reason this screen looks the way it does:
 *
 * - **Unknown is not zero.** A missing statement balance renders as "not evidenced", never as
 *   `₹0.00`. `expectedEndingBalance` and `cashBalanceDelta` are `null` in that case and stay
 *   null on screen (17.5).
 * - **A verified zero is a claim, and it has conditions.** `verificationStatus` comes from a
 *   database `CHECK` covering evidenced boundaries, a zero delta, and nothing unexplained in
 *   either direction — so this screen never says "verified" on its own arithmetic. A numeric
 *   zero over unidentified movements cannot reach `verified` by any path.
 * - **Nothing is netted.** A ₹1,000 purchase and its ₹200 refund are ₹1,000 of debit and ₹200
 *   of credit, once each, whatever the expense nets to (17.4).
 *
 * The bar widths are geometry — a proportion of the largest magnitude on the row set — and
 * carry no figure of their own. Every number rendered is one the run already computed.
 */
export function AccountWaterfalls({ reconciliationRunId }: { reconciliationRunId: string }) {
  const snapshots = useAccountSnapshots(reconciliationRunId);
  const accounts = useAccounts();

  if (snapshots.isPending) {
    return (
      <LoadingStatus label="Loading account balances…">
        <TableSkeleton columns={3} rows={4} />
      </LoadingStatus>
    );
  }
  if (snapshots.isError) {
    return <ErrorBlock error={snapshots.error} onRetry={() => void snapshots.refetch()} />;
  }

  const rows = snapshots.data.snapshots;
  if (rows.length === 0) {
    return (
      <EmptyBlock>
        This run wrote no account snapshots, which means there were no accounts to check — not that
        every account closed.
      </EmptyBlock>
    );
  }

  const incomplete = rows.filter((row) => row.verificationStatus === "incomplete");
  const unreconciled = rows.filter((row) => row.verificationStatus === "unreconciled");

  return (
    <div className="flex flex-col gap-8">
      <PeriodVerdict
        total={rows.length}
        incomplete={incomplete.length}
        unreconciled={unreconciled.length}
      />
      {rows.map((snapshot) => (
        <AccountWaterfall
          key={snapshot.id}
          snapshot={snapshot}
          account={accounts.data?.find((entry) => entry.id === snapshot.accountId)}
        />
      ))}
    </div>
  );
}

/**
 * The one sentence a reader needs before the detail: is this period actually checked?
 *
 * Deliberately not a count of "verified" accounts on its own. "3 of 4 verified" reads as mostly
 * fine; "one account has no statement balance, so this period is not verified" is what is
 * actually true.
 */
function PeriodVerdict({
  total,
  incomplete,
  unreconciled,
}: {
  total: number;
  incomplete: number;
  unreconciled: number;
}) {
  if (incomplete === 0 && unreconciled === 0) {
    return (
      <p className="text-body text-credit">
        Every one of the {total} accounts closes: both boundaries evidenced, a zero delta, and
        nothing unexplained in either direction.
      </p>
    );
  }
  return (
    <NoteList
      items={[
        ...(incomplete > 0
          ? [
              {
                title: `This period is not verified — ${incomplete} of ${total} accounts could not be checked`,
                detail:
                  "A statement balance is missing, so there is nothing to check those " +
                  "movements against. That is unknown, not zero, and no amount of arithmetic " +
                  "below closes it.",
              },
            ]
          : []),
        ...(unreconciled > 0
          ? [
              {
                title: `${unreconciled} of ${total} accounts do not close`,
                detail:
                  "The statement was checked and disagrees, or something on the account is " +
                  "unexplained. The signed difference is on each account below.",
              },
            ]
          : []),
      ]}
    />
  );
}

export function AccountWaterfall({
  snapshot,
  account,
}: {
  snapshot: ReconciliationAccountSnapshot;
  account?: AccountSummary;
}) {
  const scale = largestMagnitude([
    snapshot.openingBalance,
    snapshot.closingBalance,
    snapshot.totalCredits,
    snapshot.totalDebits,
    snapshot.expectedEndingBalance,
  ]);

  const headingId = `account-${snapshot.id}`;

  return (
    <Section
      title={account?.name ?? "An account no longer in the roster"}
      headingId={headingId}
      description={
        account === undefined ? undefined : (
          <>
            {accountTypeLabel(account.type)}
            {account.institution !== null && ` · ${account.institution}`}
            {account.last4 !== null && ` · ends ${account.last4}`}
            {account.archivedAt !== null && " · closed"}
          </>
        )
      }
      actions={<VerificationWord status={snapshot.verificationStatus} />}
    >
      <p className="mb-4 max-w-prose text-meta text-ink-muted">
        {verificationStatusDetail(snapshot.verificationStatus)}
      </p>

      <table className="w-full max-w-lg text-body">
        <caption className="sr-only">
          Cash waterfall from the opening balance to the unaccounted delta
        </caption>
        <tbody>
          <WaterfallRow
            label="Opening balance"
            paise={snapshot.openingBalance}
            scale={scale}
            unknownLabel="Not evidenced"
          />
          <WaterfallRow label="Credits" paise={snapshot.totalCredits} scale={scale} sign="+" />
          <WaterfallRow label="Debits" paise={snapshot.totalDebits} scale={scale} sign="−" />
          <WaterfallRow
            label="Expected closing"
            paise={snapshot.expectedEndingBalance}
            scale={scale}
            strong
            unknownLabel="Cannot be computed"
          />
          <WaterfallRow
            label="Actual closing, per the statement"
            paise={snapshot.closingBalance}
            scale={scale}
            unknownLabel="Not evidenced"
          />
        </tbody>
      </table>

      <div className="mt-4 max-w-lg border-t-2 border-double border-rule-strong pt-3">
        <p className="text-meta text-ink-muted">Unaccounted delta</p>
        {snapshot.cashBalanceDelta === null ? (
          <p className="mt-1 text-body text-attention">
            Unknown — a statement balance is missing, so this cannot be zero or anything else.
          </p>
        ) : (
          <Money
            paise={snapshot.cashBalanceDelta}
            size="figure"
            tone={snapshot.verificationStatus === "verified" ? "credit" : "debit"}
            className="mt-1 block"
          />
        )}
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <Facts>
          <Fact label="Explained debits" mono>
            <Money paise={snapshot.explainedDebits} />
          </Fact>
          <Fact label="Unexplained debits" mono>
            <Money
              paise={snapshot.unexplainedDebits}
              tone={snapshot.unexplainedDebits === "0" ? "neutral" : "debit"}
            />
          </Fact>
          <Fact label="Internal transfers out" mono hint="A subset of debits, not a new term">
            <Money paise={snapshot.internalTransferDebits} />
          </Fact>
        </Facts>
        <Facts>
          <Fact label="Explained credits" mono>
            <Money paise={snapshot.explainedCredits} />
          </Fact>
          <Fact label="Unexplained credits" mono>
            <Money
              paise={snapshot.unexplainedCredits}
              tone={snapshot.unexplainedCredits === "0" ? "neutral" : "debit"}
            />
          </Fact>
          <Fact label="Internal transfers in" mono hint="A subset of credits, not a new term">
            <Money paise={snapshot.internalTransferCredits} />
          </Fact>
        </Facts>
      </div>

      {(snapshot.openingBalanceEvidenceId !== null ||
        snapshot.closingBalanceEvidenceId !== null) && (
        <p className="mt-4 text-meta text-ink-muted">
          Boundary evidence:{" "}
          {snapshot.openingBalanceEvidenceId !== null && (
            <Link
              href={`/evidence/${snapshot.openingBalanceEvidenceId}`}
              className="text-accent underline underline-offset-2"
            >
              opening
            </Link>
          )}
          {snapshot.openingBalanceEvidenceId !== null &&
            snapshot.closingBalanceEvidenceId !== null &&
            " · "}
          {snapshot.closingBalanceEvidenceId !== null && (
            <Link
              href={`/evidence/${snapshot.closingBalanceEvidenceId}`}
              className="text-accent underline underline-offset-2"
            >
              closing
            </Link>
          )}
        </p>
      )}

      {snapshot.discrepancies.length > 0 && (
        <div className="mt-4">
          <NoteList
            items={snapshot.discrepancies.map((discrepancy) => ({
              title: cashDiscrepancyLabel(discrepancy.kind),
              detail: discrepancy.detail,
            }))}
          />
        </div>
      )}
    </Section>
  );
}

function VerificationWord({ status }: { status: ReconciliationVerificationStatus }) {
  return (
    <span
      className={cn(
        "text-meta",
        status === "verified" && "text-credit",
        status === "unreconciled" && "text-debit",
        status === "incomplete" && "text-attention",
      )}
    >
      {verificationStatusLabel(status)}
    </span>
  );
}

function WaterfallRow({
  label,
  paise,
  scale,
  sign,
  strong = false,
  unknownLabel,
}: {
  label: string;
  paise: string | null;
  scale: bigint;
  sign?: "+" | "−";
  strong?: boolean;
  unknownLabel?: string;
}) {
  return (
    <tr className={cn(strong && "border-t border-rule")}>
      <th
        scope="row"
        className={cn(
          "py-1.5 pr-4 text-left font-normal",
          strong ? "text-ink" : "text-ink-muted",
          sign !== undefined && "pl-4",
        )}
      >
        {label}
      </th>
      <td className="w-24 py-1.5">
        {paise !== null && (
          <span
            aria-hidden="true"
            className="block h-1.5 rounded-sm bg-rule-strong"
            style={{ width: `${barPercent(paise, scale)}%` }}
          />
        )}
      </td>
      <td className={cn("py-1.5 text-right", strong ? "text-ink" : "text-ink-muted")}>
        {paise === null ? (
          <UnknownValue>{unknownLabel ?? "Not recorded"}</UnknownValue>
        ) : (
          <>
            {sign !== undefined && <span className="text-ink-faint">{sign} </span>}
            <Money paise={paise} className={cn(strong && "font-medium")} />
          </>
        )}
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------------------- geometry */

/**
 * The largest magnitude among the figures on one account, or `1n`.
 *
 * Only ever used to size a decorative bar. It is not a figure, is never rendered, and the bars
 * it scales are `aria-hidden` — the numbers beside them are what a reader (and a screen reader)
 * actually gets.
 */
function largestMagnitude(values: readonly (string | null)[]): bigint {
  let largest = 1n;
  for (const value of values) {
    if (value === null) continue;
    const magnitude = BigInt(value) < 0n ? -BigInt(value) : BigInt(value);
    if (magnitude > largest) largest = magnitude;
  }
  return largest;
}

function barPercent(paise: string, scale: bigint): number {
  const value = BigInt(paise);
  const magnitude = value < 0n ? -value : value;
  if (magnitude === 0n) return 0;
  // Integer percent, computed in BigInt and only then narrowed — a ratio of two paise counts
  // near 2^53 would lose precision through a plain division.
  const percent = Number((magnitude * 100n) / scale);
  return Math.max(2, Math.min(100, percent));
}
