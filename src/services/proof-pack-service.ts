/**
 * Derived proof packs — the read that assembles one (`docs/roadmap.md` Phase 20, ADR-0047).
 *
 * `domain.buildProofPack` arranges already-derived facts into prose; this service is what
 * loads those facts and hands them over. It is a **pure read**, exactly like `getBalance` or
 * `getRefundAllocationState`: no `runAudited`, no transaction, no `AuditEvent`, no write to any
 * table, and no call to `SplitwisePort`. Generating a pack changes nothing (ADR-0047).
 *
 * Two jobs are genuinely this layer's rather than the domain's:
 *
 *  - **Reuse the canonical figures, never a second copy.** Every number in a pack comes back
 *    from a function that already owns it — `getBalance` for the pair's `NetBalance` and
 *    `ObligationEvidenceStatus`, its `contributions` for each expense's recipient share,
 *    `getRefundAllocationState` for the refund picture, `getPaymentContext` for whether the
 *    evidence conflicts. This service arranges them; it does not recompute one.
 *  - **Redact before it can leave, and fail closed if redaction did not work.** Every free-text
 *    field that would be pasted into a message is put through Phase 17's `redactReceiptText`,
 *    and the finished pack is walked through `findResidualIdentifiers` — the same residual
 *    check `assertPayloadSanitized` runs before an AI call. A UPI handle, phone number or
 *    account number still present throws `SanitizationError` and the pack is not returned
 *    (ADR-0044's fail-closed boundary, applied to an export).
 */

import { buildProofPack, collectProofPackExportableStrings } from '../domain/index.js';
import type {
  ExpenseId,
  ObligationContribution,
  Paise,
  PersonId,
  ProofPack,
  ProofPackAuditFindingFact,
  ProofPackEvidenceFact,
  ProofPackEvidenceRef,
  ProofPackExpenseFact,
  ProofPackSettlementFact,
  ProofPackWarning,
} from '../domain/index.js';
import {
  createLocalRedactionMap,
  findResidualIdentifiers,
  redactReceiptText,
  SanitizationError,
} from '../ai/index.js';
import type { LocalRedactionMap } from '../ai/index.js';
import {
  getExpenseById,
  getPersonById,
  listEvidenceContextSourcesForPayment,
  listEvidenceLinkedToExpense,
  listExpensePaymentIds,
  listSettlementsForAudit,
  listSplitwiseAuditFindings,
} from '../db/index.js';
import type { Database, EvidenceRow } from '../db/index.js';

import { getBalance } from './balance-service.js';
import { getRefundAllocationState } from './adjustment-service.js';
import { getPaymentContext } from './evidence-enrichment-service.js';
import { ServiceError } from './errors.js';

/** How many supporting evidence records a single expense line cites, at most. */
const DEFAULT_MAX_EVIDENCE_PER_EXPENSE = 6;

export interface BuildProofPackInput {
  /** The system's own `Person`. Resolved by the route from the single `User` row, not the caller. */
  readonly userPersonId: PersonId;
  /** Whose position this pack explains. Must not be the user. */
  readonly recipientPersonId: PersonId;
  /**
   * The explicit snapshot instant the pack speaks for. Defaults to now.
   *
   * It is a **label**, not a historical filter: the figures are always the ledger as it
   * currently stands. Filtering the balance to a past instant would need a second balance
   * engine, which ADR-0047 forbids. Given a fixed `asOf` and an unchanged ledger the output
   * is byte-identical.
   */
  readonly asOf?: Date;
  readonly maxEvidencePerExpense?: number;
}

export interface ProofPackPreview {
  /** The one recipient this pack is for — the "intended recipient" the preview must show. */
  readonly intendedRecipient: { readonly id: string; readonly displayName: string };
  /** ISO-8601 — the explicit as-of timestamp. */
  readonly asOf: string;
  /** The WhatsApp-ready text. Deterministic for a fixed `asOf` and ledger state. */
  readonly generatedText: string;
  /** Every supporting evidence record the pack cites, de-duplicated across expenses. */
  readonly evidenceReferences: readonly ProofPackEvidenceRef[];
  /** Uncertainty and pending-state notes — nothing here is smoothed away. */
  readonly warnings: readonly ProofPackWarning[];
  /** The full structured pack behind the text. */
  readonly pack: ProofPack;
}

/**
 * Builds the proof-pack preview for one (user, recipient) pair.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when the recipient does not exist or is archived.
 * @throws ServiceError `PRECONDITION_FAILED` when the recipient is the user.
 * @throws SanitizationError when the finished pack still carries an identifier that should
 *   never be exported — nothing is returned in that case (fail closed).
 */
export async function buildProofPackPreview(
  db: Database,
  input: BuildProofPackInput,
): Promise<ProofPackPreview> {
  if (input.userPersonId === input.recipientPersonId) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A proof pack explains what another person owes or is owed; it cannot be generated for ' +
        'the user themselves.',
      { personId: input.userPersonId },
    );
  }

  const recipient = await getPersonById(db, input.recipientPersonId);
  if (recipient === null || recipient.archivedAt !== null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No active person with id ${input.recipientPersonId}.`,
      { recipientPersonId: input.recipientPersonId },
    );
  }
  const user = await getPersonById(db, input.userPersonId);
  if (user === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No person with id ${input.userPersonId}.`, {
      userPersonId: input.userPersonId,
    });
  }

  const asOf = input.asOf ?? new Date();
  const maxEvidence = input.maxEvidencePerExpense ?? DEFAULT_MAX_EVIDENCE_PER_EXPENSE;
  const redaction = createLocalRedactionMap();

  // The canonical pair balance, its evidence status, and every per-expense obligation between
  // these two people. Quoted straight through — this service never divides a share.
  const balance = await getBalance(db, input.userPersonId, input.userPersonId, recipient.id);

  const shareByExpense = groupContributions(
    balance.contributions,
    input.userPersonId,
    recipient.id,
  );
  const expenses: ProofPackExpenseFact[] = [];
  for (const [expenseId, share] of shareByExpense) {
    expenses.push(
      await loadExpenseFact(db, {
        expenseId,
        share,
        maxEvidence,
        redaction,
      }),
    );
  }

  const settlements: ProofPackSettlementFact[] = (
    await listSettlementsForAudit(db, recipient.id)
  ).map((row) => ({
    settlementId: row.settlementId,
    occurredAt: row.occurredAt,
    direction: row.direction,
    amount: row.amount,
  }));

  const openAuditFindings: ProofPackAuditFindingFact[] = (
    await listSplitwiseAuditFindings(db, { personId: recipient.id, limit: 200 })
  )
    .filter(
      (finding) =>
        finding.supersededAt === null &&
        (finding.reviewStatus === 'open' || finding.reviewStatus === 'acknowledged'),
    )
    .map((finding) => ({
      findingId: finding.id,
      kind: finding.kind,
      findingClass: finding.findingClass,
      summary: redactReceiptText(finding.summary, redaction),
      confidence: finding.confidence,
      reviewStatus: finding.reviewStatus,
    }));

  const pack = buildProofPack({
    user: { personId: user.id, displayName: user.displayName },
    recipient: { personId: recipient.id, displayName: recipient.displayName },
    asOf,
    netBalance: balance.netBalance,
    evidenceStatus: balance.evidenceStatus,
    expenses,
    settlements,
    openAuditFindings,
  });

  assertProofPackExportable(pack);

  return {
    intendedRecipient: { id: recipient.id, displayName: recipient.displayName },
    asOf: pack.asOf,
    generatedText: pack.generatedText,
    evidenceReferences: dedupeEvidenceRefs(pack),
    warnings: pack.warnings,
    pack,
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * The fail-closed export guard.
 *
 * Independent of the redactors, exactly like `assertPayloadSanitized`: they are substitutions
 * over free text and a rule that did not fire is a silent leak. This walks every string a pack
 * would export and refuses the whole pack — it does not trim or drop a field — if a UPI
 * handle, phone number, card/account number or labelled identifier survived. The `receipt_text`
 * profile is used because a pack legitimately carries amounts and dates, which the strict
 * profile's bare-digit-run rule would reject.
 */
export function assertProofPackExportable(pack: ProofPack): void {
  for (const value of collectProofPackExportableStrings(pack)) {
    const residual = findResidualIdentifiers(value, 'receipt_text');
    if (residual.length > 0) {
      throw new SanitizationError(
        `A proof pack still contains ${residual.join(', ')} after redaction. Nothing was ` +
          'returned: an exported pack that reaches this point unredacted is a rule that did ' +
          'not fire, not a field to quietly drop (security-model.md, ADR-0047).',
        { context: 'proofPack', kinds: residual.join(',') },
      );
    }
  }
}

/** Folds `getBalance`'s per-obligation contributions into one recipient share per expense. */
function groupContributions(
  contributions: readonly ObligationContribution[],
  userPersonId: PersonId,
  recipientPersonId: PersonId,
): Map<
  ExpenseId,
  { readonly amount: Paise; readonly shareDirection: ProofPackExpenseFact['shareDirection'] }
> {
  const byExpense = new Map<
    ExpenseId,
    { amount: Paise; shareDirection: ProofPackExpenseFact['shareDirection'] }
  >();
  for (const contribution of contributions) {
    const shareDirection: ProofPackExpenseFact['shareDirection'] =
      contribution.debtorId === recipientPersonId ? 'recipient_owes_user' : 'user_owes_recipient';
    // Only the two directions that involve this pair reach here — getBalance already filtered.
    if (contribution.debtorId !== userPersonId && contribution.debtorId !== recipientPersonId) {
      continue;
    }
    const existing = byExpense.get(contribution.expenseId);
    byExpense.set(contribution.expenseId, {
      amount: ((existing?.amount ?? 0n) + contribution.amount) as Paise,
      shareDirection: existing?.shareDirection ?? shareDirection,
    });
  }
  return byExpense;
}

async function loadExpenseFact(
  db: Database,
  args: {
    readonly expenseId: ExpenseId;
    readonly share: {
      readonly amount: Paise;
      readonly shareDirection: ProofPackExpenseFact['shareDirection'];
    };
    readonly maxEvidence: number;
    readonly redaction: LocalRedactionMap;
  },
): Promise<ProofPackExpenseFact> {
  const { expenseId, share, maxEvidence, redaction } = args;
  const expense = await getExpenseById(db, expenseId);
  if (expense === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `Balance for this pair references expense ${expenseId}, which no longer exists.`,
      { expenseId },
    );
  }

  const refund = await getRefundAllocationState(db, expenseId);
  const paymentIds = await listExpensePaymentIds(db, expenseId);

  let conflictingEvidence = false;
  const evidenceRows: EvidenceRow[] = [...(await listEvidenceLinkedToExpense(db, expenseId))];
  for (const paymentId of paymentIds) {
    const context = await getPaymentContext(db, paymentId);
    if (context.context.conflicts.length > 0) conflictingEvidence = true;
    for (const source of await listEvidenceContextSourcesForPayment(db, paymentId)) {
      evidenceRows.push(source.evidence);
    }
  }

  return {
    expenseId,
    description: redactReceiptText(expense.description ?? '(no description)', redaction),
    occurredAt: expense.occurredAt,
    state: expense.state,
    paidByPersonId: expense.paidByPersonId,
    grossAmount: refund.grossAmount,
    netAmount: refund.netAmount,
    attributedReduction: refund.attributedReduction,
    unattributedReduction: refund.unattributedReduction,
    refundBasis: refund.basis,
    pendingDistribution: refund.pendingDistribution,
    reviewRequired:
      refund.reviewRequired === null
        ? null
        : {
            code: refund.reviewRequired.code,
            message: redactReceiptText(refund.reviewRequired.message, redaction),
          },
    conflictingEvidence,
    evidence: selectEvidence(evidenceRows, maxEvidence, redaction),
    recipientShare: share.amount,
    shareDirection: share.shareDirection,
  };
}

/**
 * The "selected supporting evidence references" the roadmap asks for: de-duplicated by id,
 * oldest capture first, capped, with a short redacted label taken from the record's own text.
 */
function selectEvidence(
  rows: readonly EvidenceRow[],
  cap: number,
  redaction: LocalRedactionMap,
): readonly ProofPackEvidenceFact[] {
  const seen = new Set<string>();
  const unique: EvidenceRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }
  unique.sort((a, b) => {
    const byDate = a.capturedAt.getTime() - b.capturedAt.getTime();
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return unique.slice(0, cap).map((row) => ({
    evidenceId: row.id,
    type: row.type,
    capturedAt: row.capturedAt,
    label: evidenceLabel(row, redaction),
  }));
}

function evidenceLabel(row: EvidenceRow, redaction: LocalRedactionMap): string | null {
  const raw = row.rawText?.split('\n')[0]?.trim();
  if (raw === undefined || raw.length === 0) return null;
  const clipped = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  return redactReceiptText(clipped, redaction);
}

function dedupeEvidenceRefs(pack: ProofPack): readonly ProofPackEvidenceRef[] {
  const seen = new Set<string>();
  const refs: ProofPackEvidenceRef[] = [];
  for (const line of pack.expenseLines) {
    for (const ref of line.evidence) {
      if (seen.has(ref.evidenceId)) continue;
      seen.add(ref.evidenceId);
      refs.push(ref);
    }
  }
  return refs;
}
