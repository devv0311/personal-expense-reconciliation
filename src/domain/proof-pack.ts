/**
 * Derived proof packs — `CLAUDE.md` pillar 5, `docs/roadmap.md` Phase 20.
 *
 * A proof pack is a **recipient-specific derived view** of what one other person's position on
 * this ledger is: what was bought, what came back as a refund, what it now costs, the
 * recipient's share, what has already been settled, and what — if anything — is still owed, in
 * either direction. It is meant to be pasted into a WhatsApp message.
 *
 * The one rule that governs this whole module: **a proof pack quotes numbers, it does not
 * compute them.** Every figure it shows was already derived once by the canonical engine —
 * `domain.netAmount` for a net expense, `computeNetBalance` for the pair's balance,
 * `computeObligations` for a per-expense share, `obligationEvidenceStatus` for whether the
 * ledger has settlement evidence, `getRefundAllocationState` for the refund picture. This file
 * takes those already-computed values and arranges them into prose. A pack that re-divides a
 * share, re-nets an expense, or re-derives a balance is a bug (ADR-0047).
 *
 * Two more properties it is built around:
 *
 *  - **Recipient isolation.** The assembler only ever receives the recipient's own share of an
 *    expense and the settlements between the user and the recipient. Other beneficiaries are
 *    never named and their shares never appear — not redacted out afterwards, but never passed
 *    in. The rendered text names exactly two people: the user and the recipient.
 *  - **Uncertainty is preserved, never smoothed.** An unresolved Phase 19 audit finding, a
 *    refund recorded but not yet distributed, a balance the ledger believes is settled but
 *    cannot confirm, conflicting evidence on a contributing payment — each becomes a visible
 *    warning on the preview and a line in the text. The pack states its figures are derived
 *    from local records and "not yet confirmed by you", because an incomplete check is not
 *    agreement (ADR-0046, applied to a pack's own as-of boundary).
 *
 * Everything here is pure. Loading the facts, redacting free text, and running the fail-closed
 * export guard is `services.buildProofPackPreview`'s half of the same job.
 */

import type { ObligationEvidenceStatus } from './balance.js';
import type { PaymentDirection } from './enums.js';
import { DomainError } from './errors.js';
import { MINOR_UNITS_PER_MAJOR, negatePaise, sumPaise } from './money.js';
import type { Paise } from './money.js';

/* --------------------------------------------------------------------------- the pack */

/** One of the two — and only two — people a pack names. */
export interface ProofPackParty {
  readonly personId: string;
  readonly displayName: string;
}

/** Which way a single expense's share runs, stated from the recipient's point of view. */
export type ProofPackShareDirection = 'recipient_owes_user' | 'user_owes_recipient';

/** Which way the pair's whole balance runs, once settlements are netted in. */
export type ProofPackNetDirection = 'recipient_owes_user' | 'user_owes_recipient' | 'settled';

/** A pointer to one supporting `Evidence` record — an id, a kind, and a redacted label. */
export interface ProofPackEvidenceRef {
  readonly evidenceId: string;
  readonly type: string;
  /** ISO-8601. */
  readonly capturedAt: string;
  /** A short human label, already redacted by the caller. `null` when the record carries none. */
  readonly label: string | null;
}

/** One contributing expense, as the recipient's summary renders it. */
export interface ProofPackExpenseLine {
  readonly expenseId: string;
  /** Already redacted by the caller. */
  readonly description: string;
  /** ISO-8601. */
  readonly occurredAt: string;
  /** Who actually fronted the money for this expense. */
  readonly payer: 'you' | 'recipient';
  readonly shareDirection: ProofPackShareDirection;
  /** `Expense.amount` — the historical, immutable gross (invariants.md #6). */
  readonly grossAmount: Paise;
  /** Cumulative item-attributed refunds against this expense (ADR-0018). */
  readonly attributedItemRefunds: Paise;
  /** Cumulative whole-expense (legacy) reductions against this expense (ADR-0008). */
  readonly unattributedRefunds: Paise;
  /** `domain.netAmount` for this expense — gross less every recorded adjustment. */
  readonly netAmount: Paise;
  /** The recipient-relevant obligation for this expense, from `computeObligations`. */
  readonly recipientShare: Paise;
  readonly refundBasis: 'none' | 'whole_expense' | 'item_attributed' | 'mixed';
  /** True while a recorded adjustment has not yet reached the current allocation (ADR-0018). */
  readonly pendingDistribution: boolean;
  /** Set when the refund cannot be allocated without a human decision (ADR-0045). */
  readonly reviewRequired: { readonly code: string; readonly message: string } | null;
  /** True when two evidence records attached to this expense's payment disagree (ADR-0044). */
  readonly conflictingEvidence: boolean;
  readonly evidence: readonly ProofPackEvidenceRef[];
}

export type ProofPackSettlementDirection = 'you_paid_recipient' | 'recipient_paid_you';

/** One prior settlement between the user and the recipient — history, already netted in. */
export interface ProofPackSettlementLine {
  readonly settlementId: string;
  /** ISO-8601. */
  readonly occurredAt: string;
  readonly direction: ProofPackSettlementDirection;
  readonly amount: Paise;
}

/** A pointer to one unresolved Phase 19 audit finding touching this pair (ADR-0046). */
export interface ProofPackAuditFindingRef {
  readonly findingId: string;
  readonly kind: string;
  readonly findingClass: string;
  /** Already redacted by the caller. */
  readonly summary: string;
  readonly confidence: string;
  readonly reviewStatus: string;
}

export type ProofPackWarningCode =
  | 'NO_SHARED_HISTORY'
  | 'UNRESOLVED_AUDIT_FINDINGS'
  | 'PENDING_REFUND_DISTRIBUTION'
  | 'REFUND_ALLOCATION_REVIEW_REQUIRED'
  | 'BELIEVED_SETTLED_UNCONFIRMED'
  | 'REVERSE_BALANCE_AFTER_SETTLEMENT'
  | 'MIXED_LEGACY_AND_ITEM_ADJUSTMENTS'
  | 'CONTRIBUTING_EXPENSE_NOT_APPROVED'
  | 'CONFLICTING_EVIDENCE'
  | 'MISSING_SUPPORTING_EVIDENCE';

export interface ProofPackWarning {
  readonly code: ProofPackWarningCode;
  readonly message: string;
  readonly severity: 'info' | 'caution';
}

/** The whole structured pack. `generatedText` is the WhatsApp-ready rendering of the rest. */
export interface ProofPack {
  readonly user: ProofPackParty;
  readonly recipient: ProofPackParty;
  /** The explicit snapshot instant this pack speaks for (ISO-8601). */
  readonly asOf: string;
  /**
   * `computeNetBalance(user, recipient)`: positive means the **user owes the recipient**,
   * negative means the **recipient owes the user**. Quoted, never recomputed.
   */
  readonly netBalance: Paise;
  readonly netDirection: ProofPackNetDirection;
  /** `|netBalance|` — the figure the text leads with. */
  readonly amountOwed: Paise;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly expenseLines: readonly ProofPackExpenseLine[];
  readonly settlements: readonly ProofPackSettlementLine[];
  readonly openAuditFindings: readonly ProofPackAuditFindingRef[];
  readonly warnings: readonly ProofPackWarning[];
  readonly generatedText: string;
}

/* ------------------------------------------------------------------- the assembler input */

export interface ProofPackEvidenceFact {
  readonly evidenceId: string;
  readonly type: string;
  readonly capturedAt: Date;
  /** A short label, already redacted by the caller. */
  readonly label: string | null;
}

export interface ProofPackExpenseFact {
  readonly expenseId: string;
  /** Already redacted by the caller. */
  readonly description: string;
  readonly occurredAt: Date;
  /** `ExpenseState` — surfaced so a non-`approved` contributor becomes a warning. */
  readonly state: string;
  readonly paidByPersonId: string;
  readonly grossAmount: Paise;
  readonly netAmount: Paise;
  readonly attributedReduction: Paise;
  readonly unattributedReduction: Paise;
  readonly refundBasis: 'none' | 'whole_expense' | 'item_attributed' | 'mixed';
  readonly pendingDistribution: boolean;
  readonly reviewRequired: { readonly code: string; readonly message: string } | null;
  readonly conflictingEvidence: boolean;
  readonly evidence: readonly ProofPackEvidenceFact[];
  /** The recipient's own obligation for this expense — from `computeObligations`, never derived here. */
  readonly recipientShare: Paise;
  readonly shareDirection: ProofPackShareDirection;
}

export interface ProofPackSettlementFact {
  readonly settlementId: string;
  readonly occurredAt: Date;
  /** From the linked `Payment` — `debit` means the user paid the recipient (ADR-0007). */
  readonly direction: PaymentDirection;
  readonly amount: Paise;
}

export interface ProofPackAuditFindingFact {
  readonly findingId: string;
  readonly kind: string;
  readonly findingClass: string;
  /** Already redacted by the caller. */
  readonly summary: string;
  readonly confidence: string;
  readonly reviewStatus: string;
}

export interface BuildProofPackInput {
  readonly user: ProofPackParty;
  readonly recipient: ProofPackParty;
  readonly asOf: Date;
  /**
   * `computeNetBalance(user, recipient)`. Positive: user owes recipient. Negative: recipient
   * owes user. This is the whole balance already — settlements below are shown as history,
   * not subtracted again.
   */
  readonly netBalance: Paise;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly expenses: readonly ProofPackExpenseFact[];
  readonly settlements: readonly ProofPackSettlementFact[];
  readonly openAuditFindings: readonly ProofPackAuditFindingFact[];
}

/* --------------------------------------------------------------------------- assembling */

/**
 * Arranges already-derived facts about one pair into a structured, rendered proof pack.
 *
 * Pure and total: the same input always produces the same `ProofPack`, `generatedText`
 * included. It performs no arithmetic on money beyond adding up figures it was handed
 * (`sumPaise`) and taking an absolute value — every share, net and balance is quoted as
 * received.
 */
export function buildProofPack(input: BuildProofPackInput): ProofPack {
  if (input.user.personId === input.recipient.personId) {
    throw new DomainError(
      'UNKNOWN_REFERENCE',
      'A proof pack explains one other person’s position; the user and the recipient ' +
        'cannot be the same person.',
      { personId: input.user.personId },
    );
  }

  const asOf = input.asOf.toISOString();
  const netBalance = input.netBalance;
  const netDirection: ProofPackNetDirection =
    netBalance > 0n ? 'user_owes_recipient' : netBalance < 0n ? 'recipient_owes_user' : 'settled';
  const amountOwed = netBalance < 0n ? negatePaise(netBalance) : netBalance;

  const expenseLines = [...input.expenses]
    .sort(byOccurredThenId((expense) => [expense.occurredAt, expense.expenseId]))
    .map(toExpenseLine);

  const settlements = [...input.settlements]
    .sort(byOccurredThenId((settlement) => [settlement.occurredAt, settlement.settlementId]))
    .map(toSettlementLine);

  const openAuditFindings = [...input.openAuditFindings]
    .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0))
    .map((finding) => ({ ...finding }));

  const warnings = deriveWarnings({
    netBalance,
    netDirection,
    evidenceStatus: input.evidenceStatus,
    expenseLines,
    settlements,
    openAuditFindings,
  });

  const pack: Omit<ProofPack, 'generatedText'> = {
    user: { ...input.user },
    recipient: { ...input.recipient },
    asOf,
    netBalance,
    netDirection,
    amountOwed,
    evidenceStatus: input.evidenceStatus,
    expenseLines,
    settlements,
    openAuditFindings,
    warnings,
  };

  return { ...pack, generatedText: renderProofPackText(pack) };
}

/* ---------------------------------------------------------------------------- rendering */

/**
 * The WhatsApp-ready rendering of a pack.
 *
 * Deliberately plain text — no markdown, no table characters — because it is pasted into a
 * chat. Dates render in a fixed `D MMM YYYY` UTC form and amounts through {@link formatInr},
 * so the output is byte-identical for byte-identical input regardless of host locale or
 * timezone.
 */
export function renderProofPackText(pack: Omit<ProofPack, 'generatedText'>): string {
  const lines: string[] = [];
  const them = pack.recipient.displayName;

  lines.push(`Expense summary for ${them}`);
  lines.push(`As of ${formatDate(pack.asOf)}. Derived from my records — not yet confirmed by you.`);
  lines.push('');

  lines.push('WHERE THIS STANDS');
  lines.push(whereThisStandsLine(pack, them));
  const noHistory = pack.warnings.find((warning) => warning.code === 'NO_SHARED_HISTORY');
  if (noHistory !== undefined) {
    lines.push(noHistory.message);
  }
  if (pack.evidenceStatus === 'believed_settled_unconfirmed_by_ledger') {
    lines.push(
      'Note: my records suggest this may already be settled, but I have no confirmed ' +
        'settlement for it.',
    );
  }

  if (pack.expenseLines.length > 0) {
    lines.push('');
    lines.push('EXPENSES');
    pack.expenseLines.forEach((line, index) => {
      for (const text of renderExpenseLine(line, index + 1, them)) lines.push(text);
    });
  }

  if (pack.settlements.length > 0) {
    lines.push('');
    lines.push('SETTLEMENTS ALREADY RECORDED');
    for (const settlement of pack.settlements) {
      lines.push(`- ${renderSettlementLine(settlement, them)}`);
    }
  }

  const notes = pack.warnings.filter((warning) => warning.code !== 'NO_SHARED_HISTORY');
  if (notes.length > 0) {
    lines.push('');
    lines.push('PLEASE NOTE');
    for (const warning of notes) lines.push(`- ${warning.message}`);
  }

  return lines.join('\n');
}

/**
 * Every string in a pack that would leave this machine if it were shared.
 *
 * `services.buildProofPackPreview` walks this list through the Phase 17 residual-identifier
 * check and refuses to return the pack if any of it still carries a UPI handle, a phone
 * number or an account number (ADR-0044's fail-closed boundary, applied to an export rather
 * than an AI call).
 */
export function collectProofPackExportableStrings(pack: ProofPack): readonly string[] {
  const strings: string[] = [pack.generatedText, pack.recipient.displayName, pack.user.displayName];
  for (const line of pack.expenseLines) {
    strings.push(line.description);
    for (const ref of line.evidence) if (ref.label !== null) strings.push(ref.label);
    if (line.reviewRequired !== null) strings.push(line.reviewRequired.message);
  }
  for (const finding of pack.openAuditFindings) strings.push(finding.summary);
  for (const warning of pack.warnings) strings.push(warning.message);
  return strings;
}

/* ------------------------------------------------------------------------- money & date */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Renders {@link Paise} as `₹1,234.56` with plain three-digit grouping and always two
 * decimal places. Display only — never fed back into arithmetic (invariants.md #12).
 */
export function formatInr(value: Paise): string {
  const raw: bigint = value;
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const whole = (magnitude / MINOR_UNITS_PER_MAJOR).toString();
  const fraction = (magnitude % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** `2026-09-06T...` -> `6 Sep 2026`, in UTC, locale-independent. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/* ------------------------------------------------------------------------- internals */

function toExpenseLine(fact: ProofPackExpenseFact): ProofPackExpenseLine {
  return {
    expenseId: fact.expenseId,
    description: fact.description,
    occurredAt: fact.occurredAt.toISOString(),
    payer: fact.shareDirection === 'recipient_owes_user' ? 'you' : 'recipient',
    shareDirection: fact.shareDirection,
    grossAmount: fact.grossAmount,
    attributedItemRefunds: fact.attributedReduction,
    unattributedRefunds: fact.unattributedReduction,
    netAmount: fact.netAmount,
    recipientShare: fact.recipientShare,
    refundBasis: fact.refundBasis,
    pendingDistribution: fact.pendingDistribution,
    reviewRequired: fact.reviewRequired === null ? null : { ...fact.reviewRequired },
    conflictingEvidence: fact.conflictingEvidence,
    evidence: [...fact.evidence]
      .sort(byOccurredThenId((ref) => [ref.capturedAt, ref.evidenceId]))
      .map((ref) => ({
        evidenceId: ref.evidenceId,
        type: ref.type,
        capturedAt: ref.capturedAt.toISOString(),
        label: ref.label,
      })),
  };
}

function toSettlementLine(fact: ProofPackSettlementFact): ProofPackSettlementLine {
  return {
    settlementId: fact.settlementId,
    occurredAt: fact.occurredAt.toISOString(),
    direction: fact.direction === 'debit' ? 'you_paid_recipient' : 'recipient_paid_you',
    amount: fact.amount,
  };
}

function whereThisStandsLine(pack: Omit<ProofPack, 'generatedText'>, them: string): string {
  if (pack.netDirection === 'settled')
    return `You and ${them} are settled up — nothing is owed either way.`;
  if (pack.netDirection === 'user_owes_recipient')
    return `I owe ${them} ${formatInr(pack.amountOwed)}.`;
  return `${them} owes me ${formatInr(pack.amountOwed)}.`;
}

function renderExpenseLine(
  line: ProofPackExpenseLine,
  position: number,
  them: string,
): readonly string[] {
  const out: string[] = [];
  out.push(`${position}. ${line.description} — ${formatDate(line.occurredAt)}`);
  const payer = line.payer === 'you' ? 'I' : them;
  out.push(`   ${payer} paid ${formatInr(line.grossAmount)}`);

  const refundTotal = sumPaise([line.attributedItemRefunds, line.unattributedRefunds]);
  if (refundTotal > 0n) {
    const kind =
      line.refundBasis === 'item_attributed'
        ? 'Item refund'
        : line.refundBasis === 'mixed'
          ? 'Refunds (item + whole-expense)'
          : 'Refund';
    out.push(`   ${kind}: ${formatInr(refundTotal)}  →  net ${formatInr(line.netAmount)}`);
  }

  const share =
    line.shareDirection === 'recipient_owes_user'
      ? `${them}’s share: ${formatInr(line.recipientShare)}`
      : `My share: ${formatInr(line.recipientShare)}`;
  out.push(`   ${share}`);

  if (line.pendingDistribution) {
    out.push('   (a recorded refund on this expense is not yet reflected in the share above)');
  }
  if (line.reviewRequired !== null) {
    out.push('   (this refund still needs a manual allocation decision)');
  }
  if (line.conflictingEvidence) {
    out.push('   (the evidence attached to this payment disagrees on some detail)');
  }
  if (line.evidence.length > 0) {
    out.push(`   Evidence: ${line.evidence.map(describeEvidence).join('; ')}`);
  }
  return out;
}

function describeEvidence(ref: ProofPackEvidenceRef): string {
  const base = `${ref.type} (${formatDate(ref.capturedAt)})`;
  return ref.label === null ? base : `${base} — ${ref.label}`;
}

function renderSettlementLine(line: ProofPackSettlementLine, them: string): string {
  const when = formatDate(line.occurredAt);
  return line.direction === 'you_paid_recipient'
    ? `I paid ${them} ${formatInr(line.amount)} on ${when}`
    : `${them} paid me ${formatInr(line.amount)} on ${when}`;
}

interface WarningContext {
  readonly netBalance: Paise;
  readonly netDirection: ProofPackNetDirection;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly expenseLines: readonly ProofPackExpenseLine[];
  readonly settlements: readonly ProofPackSettlementLine[];
  readonly openAuditFindings: readonly ProofPackAuditFindingRef[];
}

function deriveWarnings(context: WarningContext): readonly ProofPackWarning[] {
  const warnings: ProofPackWarning[] = [];

  if (context.expenseLines.length === 0 && context.settlements.length === 0) {
    warnings.push({
      code: 'NO_SHARED_HISTORY',
      severity: 'info',
      message: 'There are no shared expenses or settlements between us on my records.',
    });
  }

  if (context.openAuditFindings.length > 0) {
    const n = context.openAuditFindings.length;
    warnings.push({
      code: 'UNRESOLVED_AUDIT_FINDINGS',
      severity: 'caution',
      message:
        `${n} Splitwise audit ${n === 1 ? 'finding is' : 'findings are'} still open for this ` +
        'balance, so the figures above may change once they are resolved.',
    });
  }

  if (context.expenseLines.some((line) => line.pendingDistribution)) {
    warnings.push({
      code: 'PENDING_REFUND_DISTRIBUTION',
      severity: 'caution',
      message:
        'A refund has been recorded against one of these expenses but not yet applied to the ' +
        'shares, so the amount owed does not reflect it yet.',
    });
  }

  if (context.expenseLines.some((line) => line.reviewRequired !== null)) {
    warnings.push({
      code: 'REFUND_ALLOCATION_REVIEW_REQUIRED',
      severity: 'caution',
      message:
        'A refund on one of these expenses cannot be split automatically and is waiting on a ' +
        'manual decision.',
    });
  }

  if (
    context.evidenceStatus === 'believed_settled_unconfirmed_by_ledger' &&
    context.netDirection !== 'settled'
  ) {
    warnings.push({
      code: 'BELIEVED_SETTLED_UNCONFIRMED',
      severity: 'caution',
      message:
        'My records hint this balance may already be settled, but there is no confirmed ' +
        'settlement backing that.',
    });
  }

  if (isReverseBalanceAfterSettlement(context)) {
    warnings.push({
      code: 'REVERSE_BALANCE_AFTER_SETTLEMENT',
      severity: 'caution',
      message:
        'A refund or adjustment landed after a settlement was already made, so part of this ' +
        'balance is now money owed back the other way.',
    });
  }

  if (context.expenseLines.some((line) => line.refundBasis === 'mixed')) {
    warnings.push({
      code: 'MIXED_LEGACY_AND_ITEM_ADJUSTMENTS',
      severity: 'info',
      message:
        'One of these expenses has both an item-level refund and a whole-expense adjustment; ' +
        'the net cost shown accounts for both.',
    });
  }

  if (context.expenseLines.some((line) => line.conflictingEvidence)) {
    warnings.push({
      code: 'CONFLICTING_EVIDENCE',
      severity: 'caution',
      message:
        'The evidence attached to one of these payments disagrees on a detail (amount, date or ' +
        'merchant); the figure above uses the ledger’s own record.',
    });
  }

  if (context.expenseLines.some((line) => line.evidence.length === 0)) {
    warnings.push({
      code: 'MISSING_SUPPORTING_EVIDENCE',
      severity: 'info',
      message: 'One or more of these expenses has no supporting evidence attached yet.',
    });
  }

  return warnings;
}

/**
 * True when a settlement has already moved money one way and the balance now points the
 * other — the shape ADR-0018's worked example produces when a refund follows a settlement.
 */
function isReverseBalanceAfterSettlement(context: WarningContext): boolean {
  if (context.settlements.length === 0 || context.netBalance === 0n) return false;
  let netUserToRecipient = 0n;
  for (const settlement of context.settlements) {
    const amount: bigint = settlement.amount;
    netUserToRecipient += settlement.direction === 'you_paid_recipient' ? amount : -amount;
  }
  if (netUserToRecipient === 0n) return false;
  // netBalance > 0 => user owes recipient. A reverse balance is the user having net-paid the
  // recipient yet still being owed (netBalance < 0), or vice versa.
  return netUserToRecipient > 0n ? context.netBalance < 0n : context.netBalance > 0n;
}

function byOccurredThenId<T>(key: (value: T) => readonly [Date, string]): (a: T, b: T) => number {
  return (a, b) => {
    const [dateA, idA] = key(a);
    const [dateB, idB] = key(b);
    const byDate = dateA.getTime() - dateB.getTime();
    if (byDate !== 0) return byDate;
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  };
}
