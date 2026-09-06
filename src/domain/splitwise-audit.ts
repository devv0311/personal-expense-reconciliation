/**
 * The Splitwise **drift and ghost-debt auditing engine** (phase 19, ADR-0046).
 *
 * `splitwise-drift.ts` answers *do the two ledgers agree about this pair?* — one exact
 * `bigint` comparison, unchanged since phase 15 and reused here rather than reimplemented.
 * This module answers the question that comes next: *when they disagree, which record is
 * responsible, and how sure can this ledger honestly be?*
 *
 * Three rules shape every line of it:
 *
 *  - **Attribution is earned, never assumed.** A pair-level mismatch names a culprit only
 *    when a specific record — a synced row absent from Splitwise, an entry Splitwise holds
 *    twice, a local refund Splitwise was never told about — actually accounts for it. What
 *    attribution cannot explain stays `unattributed_balance_mismatch` at `unknown`
 *    confidence. The engine never promotes the guess that would have balanced the totals.
 *  - **A failed, partial or unsupported read is an incomplete check, not agreement.**
 *    Absence is evidence only under a `complete` read; under any other status the
 *    absence-based findings are suppressed and the incompleteness is itself recorded
 *    (`external_read_*`). Nothing here can turn a Splitwise outage into a clean bill.
 *  - **`stale` and `drifted` stay distinct.** `stale` is *our* side having changed after a
 *    sync (an `ExpenseAdjustment`, including ADR-0018's item-attributed refunds); `drifted`
 *    is *theirs*. The findings for the first name the local adjustment as the cause; the
 *    findings for the second name the external record. They are never collapsed
 *    (`invariants.md` #18).
 *
 * Every amount is exact integer paise and every comparison is `bigint` equality — no
 * tolerance, for the reason ADR-0041 §3 already gave: both sides are exact minor units, so
 * a small disagreement is a small real disagreement.
 *
 * Pure. Loading the local views, calling the port and persisting findings is
 * `services.runSplitwiseAudit`'s half of the same decision.
 */

import type {
  ConfidenceLevel,
  SplitwiseAuditFindingClass,
  SplitwiseAuditFindingKind,
  SplitwiseAuditFindingScope,
  SplitwiseExpenseSyncStatus,
  SplitwiseExternalReadStatus,
  SplitwiseSettlementSyncStatus,
  PaymentDirection,
} from './enums.js';
import type {
  ExpenseAdjustmentId,
  ExpenseId,
  PersonId,
  SettlementId,
  SplitwiseExpenseId,
  SplitwiseSettlementId,
} from './ids.js';
import { negatePaise } from './money.js';
import type { Paise } from './money.js';

/* ============================================================================== inputs */

/** How a local expense's reduction was recorded — the evidence behind a `stale` row. */
export type LocalRefundBasis = 'none' | 'item_attributed' | 'whole_expense' | 'mixed';

/**
 * One `SplitwiseExpense` this ledger synced, as the audit reads it.
 *
 * `friendShareAtSync` comes from the row's own `our_snapshot` — what was actually sent — and
 * `friendShareNow` from the **current** allocation, which after phase 18 is already
 * refund-aware. The audit re-uses that figure rather than recomputing a net share of its own
 * (there is exactly one allocation engine, ADR-0045).
 */
export interface LocalSyncedExpenseView {
  readonly splitwiseExpenseRowId: SplitwiseExpenseId;
  readonly expenseId: ExpenseId;
  /** Splitwise's own id for the entry, as stored at sync time. */
  readonly externalId: string;
  readonly syncStatus: SplitwiseExpenseSyncStatus;
  readonly description: string | null;
  /** The friend's share in the payload this ledger sent. `null` when the snapshot lacks it. */
  readonly friendShareAtSync: Paise | null;
  /** The friend's share in the current allocation — after every recorded refund. */
  readonly friendShareNow: Paise;
  readonly expenseGrossAmount: Paise;
  readonly expenseNetAmount: Paise;
  readonly refundBasis: LocalRefundBasis;
  /** Everything refunded against the expense so far, attributed or not. */
  readonly refundedTotal: Paise;
  readonly adjustmentIds: readonly ExpenseAdjustmentId[];
}

/** One local `Settlement` between the user and the friend, with its sync row if it has one. */
export interface LocalSettlementView {
  readonly settlementId: SettlementId;
  readonly amount: Paise;
  /** `debit`: the user paid the friend. `credit`: the friend paid the user. */
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly splitwiseSettlementRowId: SplitwiseSettlementId | null;
  readonly externalId: string | null;
  readonly syncStatus: SplitwiseSettlementSyncStatus | null;
}

/** One entry Splitwise reports for the pair, already narrowed to what the audit compares. */
export interface ExternalEntryView {
  readonly externalId: string;
  readonly kind: 'expense' | 'payment';
  readonly description: string | null;
  readonly totalAmount: Paise;
  readonly deleted: boolean;
  readonly occurredAt: Date | null;
  /** Positive means the user owes the friend, the same convention as `computeNetBalance`. */
  readonly pairNetBalance: Paise;
}

/** What the finer external read produced for one pair, and how much of it can be trusted. */
export interface ExternalPairObservation {
  readonly status: SplitwiseExternalReadStatus;
  /** Why the read is not `complete`, when it is not. Recorded verbatim on the finding. */
  readonly detail: string | null;
  readonly entries: readonly ExternalEntryView[];
}

export interface SplitwisePairAuditInput {
  readonly userPersonId: PersonId;
  readonly friendPersonId: PersonId;
  readonly friendSplitwiseUserId: string;
  /** `domain.computeNetBalance(user, friend)` — this ledger's own answer. */
  readonly ourNetBalance: Paise;
  /** Splitwise's reported figure, or `null` when its read did not report this friend at all. */
  readonly theirNetBalance: Paise | null;
  readonly expenses: readonly LocalSyncedExpenseView[];
  readonly settlements: readonly LocalSettlementView[];
  /**
   * Obligations on this pair arising from expenses somebody **other than the user** fronted.
   *
   * Phase 14/15 only ever sync and attribute expenses this ledger recorded the user paying
   * (ADR-0041 §4), so drift on these is real but unattributable — recorded as an explicit
   * limitation rather than left to read as agreement.
   */
  readonly crossPayerObligationTotal: Paise;
  readonly crossPayerExpenseCount: number;
  readonly external: ExternalPairObservation;
}

/* ============================================================================= outputs */

/** A pointer to the record that supports a finding — never a copy of it. */
export interface SplitwiseAuditEvidenceRef {
  readonly type:
    | 'expense'
    | 'expense_adjustment'
    | 'settlement'
    | 'splitwise_expense'
    | 'splitwise_settlement'
    | 'external_entry'
    | 'external_balance';
  readonly id: string;
  readonly note?: string;
}

/**
 * One audit finding, before it is given an id and written down.
 *
 * `balanceImpact` is what makes attribution checkable rather than rhetorical: it is the
 * signed share of `theirNetBalance − ourNetBalance` this finding claims to account for, in
 * `computeNetBalance`'s convention. The engine subtracts every claim from the gap and reports
 * whatever is left as explicitly unattributed, so a finding set can never quietly over- or
 * under-explain the disagreement it is supposed to describe.
 */
export interface SplitwiseAuditFindingDraft {
  readonly kind: SplitwiseAuditFindingKind;
  readonly findingClass: SplitwiseAuditFindingClass;
  readonly scope: SplitwiseAuditFindingScope;
  readonly summary: string;
  readonly confidence: ConfidenceLevel;
  /** The positive magnitude the finding is about, or `null` when it is not about an amount. */
  readonly amount: Paise | null;
  readonly balanceImpact: Paise;
  readonly personAId: PersonId | null;
  readonly personBId: PersonId | null;
  readonly expenseId: ExpenseId | null;
  readonly splitwiseExpenseRowId: SplitwiseExpenseId | null;
  readonly settlementId: SettlementId | null;
  readonly splitwiseSettlementRowId: SplitwiseSettlementId | null;
  readonly externalReference: string | null;
  /** What this ledger held at comparison time — the local half of the compared snapshots. */
  readonly localSnapshot: Readonly<Record<string, unknown>>;
  /** What Splitwise reported, uninterpreted. `null` when the read produced nothing to record. */
  readonly externalSnapshot: Readonly<Record<string, unknown>> | null;
  readonly evidence: readonly SplitwiseAuditEvidenceRef[];
}

/* ========================================================================= the engine */

/**
 * Audits one (user, friend) pair and returns every finding its evidence supports.
 *
 * Deterministic: the same inputs produce the same findings in the same order, which is what
 * lets `services.runSplitwiseAudit` recognise a rerun as a rerun rather than as new noise.
 */
export function auditSplitwisePair(
  input: SplitwisePairAuditInput,
): readonly SplitwiseAuditFindingDraft[] {
  const findings: SplitwiseAuditFindingDraft[] = [];
  // Absence is evidence only under a read complete enough to make it one. A friend Splitwise's
  // own balances call did not report is an unread pair whatever the entry listing returned:
  // concluding "Splitwise no longer holds this expense" from the entries alone, while the
  // friends list has nothing to say about the pair at all, would manufacture precision out of
  // half a read.
  const absenceIsEvidence = input.external.status === 'complete' && input.theirNetBalance !== null;

  findings.push(...externalReadFindings(input));

  const expenses = [...input.expenses].sort((a, b) => compareText(a.externalId, b.externalId));
  const settlements = [...input.settlements].sort(
    (a, b) =>
      compareDate(a.occurredAt, b.occurredAt) || compareText(a.settlementId, b.settlementId),
  );
  const entries = [...input.external.entries].sort((a, b) =>
    compareText(a.externalId, b.externalId),
  );

  const entryById = new Map(entries.map((entry) => [entry.externalId, entry]));
  const linkedExternalIds = new Set<string>([
    ...expenses.map((expense) => expense.externalId),
    ...settlements.flatMap((settlement) =>
      settlement.externalId === null ? [] : [settlement.externalId],
    ),
  ]);

  /* ---------------------------------------------------------------- synced expenses */

  for (const expense of expenses) {
    const entry = entryById.get(expense.externalId);
    const liveEntry = entry === undefined || entry.deleted ? null : entry;

    // A row Splitwise no longer holds is a missing entry first and a stale one second: there is
    // no lingering debt to describe once the entry is gone, so reporting staleness there would
    // name a cause that has stopped applying.
    if (liveEntry === null && absenceIsEvidence) {
      findings.push(missingExternalExpenseFinding(input, expense, entry ?? null));
      continue;
    }

    if (expense.syncStatus === 'stale') {
      findings.push(staleRefundFinding(input, expense, liveEntry, entry ?? null));
      continue;
    }

    // No entry, and a read too incomplete to make its absence mean anything.
    if (liveEntry === null) continue;

    // Both sides hold the entry. `ours` contributes the friend's current share as a debt
    // owed *to* the user, hence the negation; agreement is exact equality, never a tolerance.
    const ourContribution = negatePaise(expense.friendShareNow);
    if (liveEntry.pairNetBalance === ourContribution) continue;
    findings.push(amountDisagreementFinding(input, expense, liveEntry, ourContribution));
  }

  /* -------------------------------------------------------------------- settlements */

  const unlinkedEntries = entries.filter(
    (entry) => !linkedExternalIds.has(entry.externalId) && !entry.deleted,
  );
  const unlinkedPayments = unlinkedEntries.filter((entry) => entry.kind === 'payment');
  const claimedExternalIds = new Set<string>();

  for (const settlement of settlements) {
    const localEffect = settlementEffect(settlement);

    if (settlement.externalId !== null) {
      const entry = entryById.get(settlement.externalId);
      if (entry !== undefined && !entry.deleted) continue; // both sides hold it
      if (!absenceIsEvidence) continue;
      findings.push(
        missingExternalSettlementFinding(input, settlement, localEffect, entry ?? null),
      );
      continue;
    }

    // Never synced from here. Splitwise may still hold it — the friend can record a payment
    // on their own side — so a matching unlinked payment entry is checked for first, and a
    // match means the two ledgers agree despite the missing local link.
    const match = unlinkedPayments.find(
      (entry) =>
        !claimedExternalIds.has(entry.externalId) &&
        entry.totalAmount === settlement.amount &&
        entry.pairNetBalance === localEffect,
    );
    if (match !== undefined) {
      claimedExternalIds.add(match.externalId);
      continue;
    }
    findings.push(missingExternalSettlementFinding(input, settlement, localEffect, null));
  }

  /* --------------------------------------------------- entries only Splitwise holds */

  const linkedEntries = entries.filter(
    (entry) => linkedExternalIds.has(entry.externalId) && !entry.deleted,
  );

  for (const entry of unlinkedEntries) {
    if (claimedExternalIds.has(entry.externalId)) continue;
    const twin = linkedEntries.find(
      (candidate) => candidate.kind === entry.kind && isSameEntryShape(candidate, entry),
    );

    if (entry.kind === 'payment') {
      findings.push(
        twin === undefined
          ? unrecordedExternalSettlementFinding(input, entry)
          : duplicateExternalSettlementFinding(input, entry, twin),
      );
      continue;
    }
    findings.push(
      twin === undefined
        ? ghostDebtEntryFinding(input, entry)
        : duplicateExternalExpenseFinding(input, entry, twin),
    );
  }

  /* -------------------------------------------------------------- permanent limits */

  if (input.crossPayerExpenseCount > 0) {
    findings.push(crossPayerLimitationFinding(input));
  }

  /* ----------------------------------------------- the aggregate, and what is left */

  if (input.theirNetBalance === null) return findings;

  const gap = (input.theirNetBalance - input.ourNetBalance) as Paise;
  const attributed = findings
    .filter((finding) => finding.findingClass === 'discrepancy')
    .reduce((total, finding) => total + finding.balanceImpact, 0n);
  const residual = (gap - attributed) as Paise;
  if (residual === 0n) return findings;

  const nothingLocalSupportsIt =
    input.expenses.length === 0 &&
    input.settlements.length === 0 &&
    input.crossPayerExpenseCount === 0 &&
    input.ourNetBalance === 0n;

  findings.push(
    nothingLocalSupportsIt
      ? ghostDebtPairFinding(input, residual)
      : unattributedMismatchFinding(input, residual, attributed),
  );
  return findings;
}

/* ---------------------------------------------------------------- non-user pairs */

export interface UnobservablePairInput {
  readonly personAId: PersonId;
  readonly personBId: PersonId;
  readonly netBalance: Paise;
  readonly expenseCount: number;
}

/**
 * Records, per pair, that this ledger cannot check a **non-user** obligation against
 * Splitwise at all.
 *
 * `SplitwisePort.fetchBalances()` is the connected account's own friends list, so the only
 * pairs it can report are ones the user is half of. An obligation between two other people —
 * Flatmate C owing Flatmate A — is fully computable here (`invariants.md` #9b: the obligation
 * is never unobservable, only its *discharge* is) and entirely uncheckable there. Saying so
 * is the point: a pair nobody can compare must not be counted among the pairs that agreed.
 */
export function auditUnobservablePairs(
  pairs: readonly UnobservablePairInput[],
): readonly SplitwiseAuditFindingDraft[] {
  return [...pairs]
    .sort((a, b) => compareText(a.personAId, b.personAId) || compareText(a.personBId, b.personBId))
    .map((pair) => ({
      kind: 'non_user_settlement_unobservable' as const,
      findingClass: 'limitation' as const,
      scope: 'pair' as const,
      summary:
        `This ledger computes a net balance of ${pair.netBalance} paise between two people ` +
        'neither of whom is the user, across ' +
        `${pair.expenseCount} expense(s). Splitwise's friends-list read only reports pairs the ` +
        'connected account is half of, so this pair cannot be compared against it at all, and ' +
        'a settlement between the two would be invisible here (invariants.md #9b). Unchecked, ' +
        'not agreed.',
      confidence: 'unknown' as const,
      amount: absolute(pair.netBalance),
      balanceImpact: 0n as Paise,
      personAId: pair.personAId,
      personBId: pair.personBId,
      expenseId: null,
      splitwiseExpenseRowId: null,
      settlementId: null,
      splitwiseSettlementRowId: null,
      externalReference: null,
      localSnapshot: {
        netBalance: pair.netBalance.toString(),
        contributingExpenseCount: pair.expenseCount,
      },
      externalSnapshot: null,
      evidence: [],
    }));
}

/**
 * Whether a finding of this kind could only have been produced by reading Splitwise's own
 * entries.
 *
 * The rule a rerun needs: a finding that no longer reproduces may be closed as history only
 * when this run actually had the standing to re-derive it. A local-evidence finding (a `stale`
 * row, a pair nobody can observe) is fully re-derived every time; an external-evidence one is
 * not, and closing it after a failed or partial read would turn an unread Splitwise into a
 * resolved discrepancy — the exact conversion ADR-0046 forbids.
 */
export function findingDependsOnExternalRead(kind: SplitwiseAuditFindingKind): boolean {
  switch (kind) {
    case 'stale_refund_partial':
    case 'stale_refund_full':
    case 'unreflected_item_refund':
    case 'non_user_settlement_unobservable':
    case 'cross_payer_attribution_unavailable':
      return false;
    default:
      return true;
  }
}

/**
 * Downgrades a `complete` listing that cannot account for the balance Splitwise itself
 * reported.
 *
 * Splitwise's friends-list figure is the sum of the pair's own entries, so a listing that
 * claims to be complete and sums to something else has not returned everything — whatever the
 * adapter believed. Catching that here is what stops a short read from being mistaken for a
 * ledger full of missing expenses.
 */
export function assessExternalListingCompleteness(
  observation: ExternalPairObservation,
  theirNetBalance: Paise | null,
): ExternalPairObservation {
  if (observation.status !== 'complete' || theirNetBalance === null) return observation;

  const listed = observation.entries
    .filter((entry) => !entry.deleted)
    .reduce((total, entry) => total + entry.pairNetBalance, 0n);
  if (listed === theirNetBalance) return observation;

  return {
    status: 'partial',
    detail:
      `the ${observation.entries.length} entries returned sum to ${listed} paise for this pair, ` +
      `while Splitwise's own reported balance is ${theirNetBalance} paise, so the listing is ` +
      'not everything it holds',
    entries: observation.entries,
  };
}

/* ============================================================ identity and materiality */

/**
 * The stable identity of a finding across audit runs.
 *
 * Deliberately excludes every amount: a finding is "the same finding" when it is about the
 * same cause on the same record, even after the numbers move. That is what makes a rerun
 * recognise its predecessor and supersede it rather than pile a second row beside it.
 */
export function findingFingerprint(finding: SplitwiseAuditFindingDraft): string {
  const subject =
    finding.expenseId ??
    finding.settlementId ??
    finding.externalReference ??
    finding.splitwiseExpenseRowId ??
    finding.splitwiseSettlementRowId ??
    '';
  return [
    finding.kind,
    finding.scope,
    finding.personAId ?? '',
    finding.personBId ?? '',
    subject,
  ].join('|');
}

/**
 * Everything about a finding that makes a rerun **materially different** from its predecessor.
 *
 * The service hashes this. Two runs that produce the same source string describe the same
 * comparison and must not create a second row; a changed one supersedes rather than edits, so
 * the earlier evidence and snapshots stay exactly as they were recorded.
 */
export function findingComparisonSource(finding: SplitwiseAuditFindingDraft): string {
  return canonicalJson({
    kind: finding.kind,
    findingClass: finding.findingClass,
    scope: finding.scope,
    confidence: finding.confidence,
    amount: finding.amount === null ? null : finding.amount.toString(),
    balanceImpact: finding.balanceImpact.toString(),
    localSnapshot: finding.localSnapshot,
    externalSnapshot: finding.externalSnapshot,
  });
}

/**
 * A stable JSON rendering: object keys sorted, `bigint` as its exact decimal string.
 *
 * Key order in a JavaScript object is an implementation detail; a digest built over it would
 * make idempotency depend on how a snapshot happened to be assembled.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => compareText(a, b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/* ============================================================== finding constructors */

function externalReadFindings(
  input: SplitwisePairAuditInput,
): readonly SplitwiseAuditFindingDraft[] {
  const base = {
    findingClass: 'incomplete' as const,
    scope: 'pair' as const,
    confidence: 'unknown' as const,
    amount: null,
    balanceImpact: 0n as Paise,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    localSnapshot: {
      ourNetBalance: input.ourNetBalance.toString(),
      syncedExpenseCount: input.expenses.length,
      settlementCount: input.settlements.length,
    },
    evidence: [] as readonly SplitwiseAuditEvidenceRef[],
  };
  const externalSnapshot = {
    readStatus: input.external.status,
    detail: input.external.detail,
    entriesReturned: input.external.entries.length,
    theirNetBalance: input.theirNetBalance === null ? null : input.theirNetBalance.toString(),
  };

  const findings: SplitwiseAuditFindingDraft[] = [];

  if (input.theirNetBalance === null) {
    findings.push({
      ...base,
      kind: 'external_record_inaccessible',
      summary:
        `This ledger links ${input.friendSplitwiseUserId} to a Splitwise account, but the ` +
        'balances read did not report that friend at all. Nothing was compared for this pair — ' +
        'an unreported friend is an unread one, never a friend Splitwise says is settled.',
      externalSnapshot,
    });
  }

  if (input.external.status === 'unsupported') {
    findings.push({
      ...base,
      kind: 'external_read_unsupported',
      summary:
        'The configured Splitwise port does not implement the per-entry read ' +
        '(SplitwisePort.fetchLedgerEntries), so this pair could only be compared at the ' +
        'aggregate balance level. No finding below names a specific external record, because ' +
        'none could be seen.',
      externalSnapshot,
    });
  } else if (input.external.status === 'partial') {
    findings.push({
      ...base,
      kind: 'external_read_partial',
      summary:
        'Splitwise returned only part of this pair’s entries' +
        (input.external.detail === null ? '' : `: ${input.external.detail}`) +
        '. Nothing is reported as missing from a partial listing — under an incomplete read, ' +
        'absence is not evidence.',
      externalSnapshot,
    });
  } else if (input.external.status === 'failed') {
    findings.push({
      ...base,
      kind: 'external_read_failed',
      summary:
        'The per-entry Splitwise read failed for this pair' +
        (input.external.detail === null ? '' : `: ${input.external.detail}`) +
        '. This is an incomplete audit of the pair, not a clean one.',
      externalSnapshot,
    });
  }

  return findings;
}

function staleRefundFinding(
  input: SplitwisePairAuditInput,
  expense: LocalSyncedExpenseView,
  liveEntry: ExternalEntryView | null,
  rawEntry: ExternalEntryView | null,
): SplitwiseAuditFindingDraft {
  const shareAtSync = expense.friendShareAtSync ?? expense.friendShareNow;
  const noLongerSupported = (shareAtSync - expense.friendShareNow) as Paise;
  const ourContribution = negatePaise(expense.friendShareNow);
  // With the entry in hand the impact is exact; without it, the payload this ledger sent is
  // the best evidence of what Splitwise still holds, and the confidence says so.
  const balanceImpact =
    liveEntry === null
      ? ((negatePaise(shareAtSync) - ourContribution) as Paise)
      : ((liveEntry.pairNetBalance - ourContribution) as Paise);

  const itemAttributed =
    expense.refundBasis === 'item_attributed' || expense.refundBasis === 'mixed';
  const fullyRefunded = expense.expenseNetAmount === 0n;
  const kind: SplitwiseAuditFindingKind = itemAttributed
    ? 'unreflected_item_refund'
    : fullyRefunded
      ? 'stale_refund_full'
      : 'stale_refund_partial';

  const cause = itemAttributed
    ? 'a refund attributed to specific purchased items (ADR-0018), which reduced only those ' +
      'items’ beneficiaries'
    : fullyRefunded
      ? 'a full refund, which left every original beneficiary on a zero-valued line (ADR-0013)'
      : 'a partial whole-expense refund distributed across the current allocation (ADR-0008)';

  return {
    kind,
    findingClass: 'discrepancy',
    scope: 'expense',
    summary:
      `This ledger synced expense ${expense.expenseId} to Splitwise and has since recorded ` +
      `${cause}. The friend’s share moved from ${shareAtSync} to ${expense.friendShareNow} ` +
      `paise, so the SplitwiseExpense row is "stale" — our side changed, not theirs — and ` +
      `${noLongerSupported} paise of the debt Splitwise still shows has no support in the ` +
      'current local ledger. Correcting Splitwise is a separate, explicitly approved write; ' +
      'this audit does not perform one.',
    confidence: liveEntry === null ? 'medium' : 'high',
    amount: absolute(noLongerSupported),
    balanceImpact,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: expense.expenseId,
    splitwiseExpenseRowId: expense.splitwiseExpenseRowId,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: expense.externalId,
    localSnapshot: {
      syncStatus: expense.syncStatus,
      refundBasis: expense.refundBasis,
      refundedTotal: expense.refundedTotal.toString(),
      expenseGrossAmount: expense.expenseGrossAmount.toString(),
      expenseNetAmount: expense.expenseNetAmount.toString(),
      friendShareAtSync: expense.friendShareAtSync === null ? null : shareAtSync.toString(),
      friendShareNow: expense.friendShareNow.toString(),
    },
    externalSnapshot: externalEntrySnapshot(rawEntry),
    evidence: [
      { type: 'expense', id: expense.expenseId },
      { type: 'splitwise_expense', id: expense.splitwiseExpenseRowId },
      ...expense.adjustmentIds.map((id) => ({ type: 'expense_adjustment' as const, id })),
      ...(rawEntry === null ? [] : [{ type: 'external_entry' as const, id: rawEntry.externalId }]),
    ],
  };
}

function missingExternalExpenseFinding(
  input: SplitwisePairAuditInput,
  expense: LocalSyncedExpenseView,
  rawEntry: ExternalEntryView | null,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'missing_external_expense',
    findingClass: 'discrepancy',
    scope: 'expense',
    summary:
      `Splitwise entry ${expense.externalId}, which this ledger synced for expense ` +
      `${expense.expenseId}, ` +
      (rawEntry === null
        ? 'is absent from a complete read of this pair’s entries'
        : 'is present but marked deleted on Splitwise') +
      `. The friend’s current share of ${expense.friendShareNow} paise is recorded here and ` +
      'is not reflected there.',
    confidence: 'high',
    amount: absolute(expense.friendShareNow),
    balanceImpact: expense.friendShareNow,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: expense.expenseId,
    splitwiseExpenseRowId: expense.splitwiseExpenseRowId,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: expense.externalId,
    localSnapshot: {
      syncStatus: expense.syncStatus,
      friendShareNow: expense.friendShareNow.toString(),
      expenseNetAmount: expense.expenseNetAmount.toString(),
    },
    externalSnapshot:
      rawEntry === null
        ? { present: false, readStatus: input.external.status }
        : externalEntrySnapshot(rawEntry),
    evidence: [
      { type: 'expense', id: expense.expenseId },
      { type: 'splitwise_expense', id: expense.splitwiseExpenseRowId },
    ],
  };
}

function amountDisagreementFinding(
  input: SplitwisePairAuditInput,
  expense: LocalSyncedExpenseView,
  entry: ExternalEntryView,
  ourContribution: Paise,
): SplitwiseAuditFindingDraft {
  const impact = (entry.pairNetBalance - ourContribution) as Paise;
  return {
    kind: 'external_amount_disagreement',
    findingClass: 'discrepancy',
    scope: 'expense',
    summary:
      `Both ledgers hold Splitwise entry ${entry.externalId} for expense ${expense.expenseId}, ` +
      `and they disagree about it: this ledger’s current allocation puts ` +
      `${expense.friendShareNow} paise of it on the friend, Splitwise reports a pair balance of ` +
      `${entry.pairNetBalance} paise for the same entry. Nothing local is stale, so the ` +
      'difference is on Splitwise’s side of a record both sides still hold.',
    confidence: 'high',
    amount: absolute(impact),
    balanceImpact: impact,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: expense.expenseId,
    splitwiseExpenseRowId: expense.splitwiseExpenseRowId,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    localSnapshot: {
      syncStatus: expense.syncStatus,
      friendShareNow: expense.friendShareNow.toString(),
      ourPairContribution: ourContribution.toString(),
      expenseNetAmount: expense.expenseNetAmount.toString(),
    },
    externalSnapshot: externalEntrySnapshot(entry),
    evidence: [
      { type: 'expense', id: expense.expenseId },
      { type: 'splitwise_expense', id: expense.splitwiseExpenseRowId },
      { type: 'external_entry', id: entry.externalId },
    ],
  };
}

function missingExternalSettlementFinding(
  input: SplitwisePairAuditInput,
  settlement: LocalSettlementView,
  localEffect: Paise,
  rawEntry: ExternalEntryView | null,
): SplitwiseAuditFindingDraft {
  const neverSynced = settlement.externalId === null;
  return {
    kind: 'missing_external_settlement',
    findingClass: 'discrepancy',
    scope: 'settlement',
    summary:
      `This ledger records Settlement ${settlement.settlementId} for ${settlement.amount} paise ` +
      `(${settlement.direction === 'debit' ? 'the user paid the friend' : 'the friend paid the user'}), ` +
      (neverSynced
        ? 'which was never synced to Splitwise and which no external payment entry matches'
        : `whose Splitwise entry ${settlement.externalId} is absent from a complete read`) +
      '. Splitwise therefore still shows a debt this ledger has evidence was discharged. The ' +
      'settlement stays exactly as recorded; no Payment or Settlement is invented here.',
    confidence: rawEntry !== null || input.external.status === 'complete' ? 'high' : 'medium',
    amount: settlement.amount,
    balanceImpact: negatePaise(localEffect),
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: settlement.settlementId,
    splitwiseSettlementRowId: settlement.splitwiseSettlementRowId,
    externalReference: settlement.externalId,
    localSnapshot: {
      amount: settlement.amount.toString(),
      direction: settlement.direction,
      occurredAt: settlement.occurredAt.toISOString(),
      syncStatus: settlement.syncStatus,
      pairContribution: localEffect.toString(),
    },
    externalSnapshot:
      rawEntry === null
        ? { present: false, readStatus: input.external.status }
        : externalEntrySnapshot(rawEntry),
    evidence: [
      { type: 'settlement', id: settlement.settlementId },
      ...(settlement.splitwiseSettlementRowId === null
        ? []
        : [{ type: 'splitwise_settlement' as const, id: settlement.splitwiseSettlementRowId }]),
    ],
  };
}

function duplicateExternalExpenseFinding(
  input: SplitwisePairAuditInput,
  entry: ExternalEntryView,
  twin: ExternalEntryView,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'duplicate_external_expense',
    findingClass: 'discrepancy',
    scope: 'external_entry',
    summary:
      `Splitwise holds entry ${entry.externalId}, which this ledger never synced, with the same ` +
      `amount, description and date as ${twin.externalId}, which it did. The most likely reading ` +
      'is a duplicated Splitwise expense adding ' +
      `${absolute(entry.pairNetBalance)} paise of debt the local ledger records once. The two ` +
      'entries are matched on shape, not on an identifier, so this is a strong signal rather ' +
      'than a certainty.',
    confidence: 'medium',
    amount: absolute(entry.pairNetBalance),
    balanceImpact: entry.pairNetBalance,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    localSnapshot: {
      linkedExternalId: twin.externalId,
      matchedOn: ['totalAmount', 'description', 'date'],
    },
    externalSnapshot: { entry: externalEntrySnapshot(entry), twin: externalEntrySnapshot(twin) },
    evidence: [
      { type: 'external_entry', id: entry.externalId, note: 'unlinked duplicate' },
      { type: 'external_entry', id: twin.externalId, note: 'the entry this ledger synced' },
    ],
  };
}

function duplicateExternalSettlementFinding(
  input: SplitwisePairAuditInput,
  entry: ExternalEntryView,
  twin: ExternalEntryView,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'duplicate_external_settlement',
    findingClass: 'discrepancy',
    scope: 'external_entry',
    summary:
      `Splitwise holds payment entry ${entry.externalId} with the same amount and date as ` +
      `${twin.externalId}, which this ledger synced for a recorded Settlement. One real payment ` +
      'appears to have been recorded twice on Splitwise, discharging ' +
      `${absolute(entry.pairNetBalance)} paise more than the ledger has evidence for.`,
    confidence: 'medium',
    amount: absolute(entry.pairNetBalance),
    balanceImpact: entry.pairNetBalance,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    localSnapshot: { linkedExternalId: twin.externalId, matchedOn: ['totalAmount', 'date'] },
    externalSnapshot: { entry: externalEntrySnapshot(entry), twin: externalEntrySnapshot(twin) },
    evidence: [
      { type: 'external_entry', id: entry.externalId, note: 'unlinked duplicate payment' },
      { type: 'external_entry', id: twin.externalId, note: 'the payment this ledger synced' },
    ],
  };
}

function unrecordedExternalSettlementFinding(
  input: SplitwisePairAuditInput,
  entry: ExternalEntryView,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'unrecorded_external_settlement',
    findingClass: 'discrepancy',
    scope: 'external_entry',
    summary:
      `Splitwise holds payment entry ${entry.externalId} for ${entry.totalAmount} paise that this ` +
      'ledger has no Settlement for, so Splitwise believes a debt was discharged that the local ' +
      'ledger still shows open. Recording a real repayment is a deliberate act with its own ' +
      'Payment evidence; no Settlement is fabricated from an external entry.',
    confidence: 'high',
    amount: absolute(entry.pairNetBalance),
    balanceImpact: entry.pairNetBalance,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    localSnapshot: { matchingSettlement: null },
    externalSnapshot: externalEntrySnapshot(entry),
    evidence: [{ type: 'external_entry', id: entry.externalId }],
  };
}

function ghostDebtEntryFinding(
  input: SplitwisePairAuditInput,
  entry: ExternalEntryView,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'unsupported_ghost_debt',
    findingClass: 'discrepancy',
    scope: 'external_entry',
    summary:
      `Splitwise holds expense entry ${entry.externalId} for ${entry.totalAmount} paise that this ` +
      'ledger never synced and holds no record of. It contributes ' +
      `${entry.pairNetBalance} paise to the pair balance with nothing in the canonical local ` +
      'ledger supporting it — apparent debt without local support.',
    confidence: 'high',
    amount: absolute(entry.pairNetBalance),
    balanceImpact: entry.pairNetBalance,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    localSnapshot: { matchingSplitwiseExpense: null },
    externalSnapshot: externalEntrySnapshot(entry),
    evidence: [{ type: 'external_entry', id: entry.externalId }],
  };
}

function ghostDebtPairFinding(
  input: SplitwisePairAuditInput,
  residual: Paise,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'unsupported_ghost_debt',
    findingClass: 'discrepancy',
    scope: 'pair',
    summary:
      `Splitwise reports ${input.theirNetBalance} paise between this pair while the local ledger ` +
      'holds no expense, no settlement and a zero balance for them — the whole external figure ' +
      'is debt nothing here supports. Which external record carries it cannot be said from a ' +
      `${input.external.status} read, so this stays at pair scope with no culprit named.`,
    confidence: 'low',
    amount: absolute(residual),
    balanceImpact: residual,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    localSnapshot: {
      ourNetBalance: input.ourNetBalance.toString(),
      syncedExpenseCount: 0,
      settlementCount: 0,
    },
    externalSnapshot: {
      theirNetBalance: input.theirNetBalance === null ? null : input.theirNetBalance.toString(),
      readStatus: input.external.status,
      entriesReturned: input.external.entries.length,
    },
    evidence: [{ type: 'external_balance', id: input.friendSplitwiseUserId }],
  };
}

function unattributedMismatchFinding(
  input: SplitwisePairAuditInput,
  residual: Paise,
  attributed: bigint,
): SplitwiseAuditFindingDraft {
  return {
    kind: 'unattributed_balance_mismatch',
    findingClass: 'discrepancy',
    scope: 'pair',
    summary:
      `This ledger computes ${input.ourNetBalance} paise for the pair and Splitwise reports ` +
      `${input.theirNetBalance}. Attribution accounted for ${attributed} paise of the ` +
      `${(input.theirNetBalance ?? 0n) - input.ourNetBalance} paise gap; ${residual} paise is ` +
      'left over that no record in evidence explains. It is reported as an unattributed ' +
      'aggregate mismatch rather than assigned to whichever expense or settlement would have ' +
      'balanced the totals.',
    confidence: 'unknown',
    amount: absolute(residual),
    balanceImpact: residual,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    localSnapshot: {
      ourNetBalance: input.ourNetBalance.toString(),
      syncedExpenseCount: input.expenses.length,
      settlementCount: input.settlements.length,
      attributedImpact: attributed.toString(),
    },
    externalSnapshot: {
      theirNetBalance: input.theirNetBalance === null ? null : input.theirNetBalance.toString(),
      readStatus: input.external.status,
      entriesReturned: input.external.entries.length,
    },
    evidence: [{ type: 'external_balance', id: input.friendSplitwiseUserId }],
  };
}

function crossPayerLimitationFinding(input: SplitwisePairAuditInput): SplitwiseAuditFindingDraft {
  return {
    kind: 'cross_payer_attribution_unavailable',
    findingClass: 'limitation',
    scope: 'pair',
    summary:
      `${input.crossPayerExpenseCount} expense(s) contributing ${input.crossPayerObligationTotal} ` +
      'paise to this pair were fronted by someone other than the user. This ledger only syncs ' +
      'and attributes expenses it recorded the user paying (ADR-0041 §4), so drift caused by ' +
      'one of those cannot be traced to a particular record here. Named rather than left to ' +
      'read as agreement.',
    confidence: 'unknown',
    amount: absolute(input.crossPayerObligationTotal),
    balanceImpact: 0n as Paise,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    localSnapshot: {
      crossPayerExpenseCount: input.crossPayerExpenseCount,
      crossPayerObligationTotal: input.crossPayerObligationTotal.toString(),
    },
    externalSnapshot: null,
    evidence: [],
  };
}

/* ------------------------------------------------------------------------- internals */

/** A settlement's own contribution to `NetBalance(user, friend)` (ADR-0007's subtraction). */
function settlementEffect(settlement: LocalSettlementView): Paise {
  return settlement.direction === 'debit' ? negatePaise(settlement.amount) : settlement.amount;
}

/** Two external entries are the same shape when amount, description and calendar date match. */
function isSameEntryShape(a: ExternalEntryView, b: ExternalEntryView): boolean {
  return (
    a.totalAmount === b.totalAmount &&
    normalizeDescription(a.description) === normalizeDescription(b.description) &&
    calendarDay(a.occurredAt) === calendarDay(b.occurredAt)
  );
}

function normalizeDescription(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function calendarDay(value: Date | null): string {
  return value === null ? '' : value.toISOString().slice(0, 10);
}

function externalEntrySnapshot(entry: ExternalEntryView | null): Record<string, unknown> | null {
  if (entry === null) return null;
  return {
    externalId: entry.externalId,
    kind: entry.kind,
    description: entry.description,
    totalAmount: entry.totalAmount.toString(),
    pairNetBalance: entry.pairNetBalance.toString(),
    deleted: entry.deleted,
    occurredAt: entry.occurredAt === null ? null : entry.occurredAt.toISOString(),
  };
}

function absolute(value: Paise): Paise {
  return value < 0n ? negatePaise(value) : value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDate(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}
