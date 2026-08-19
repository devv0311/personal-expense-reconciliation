/**
 * Recording a settlement — applying an observed payment against an existing obligation.
 *
 * A settlement **discharges** a debt; it never creates one. This module therefore has no
 * import of `insertAllocationWithLines` and no code path that could reach one: a
 * `Settlement` never has an `Allocation`, and `settlements` has no `allocation_id` column to
 * attach one to even if a caller wanted (`invariants.md` #9, #9a, ADR-0007).
 *
 * It also never creates a `Payment`. When neither party to a real settling transaction is
 * the user, no payment reaches this ledger and this function simply never gets called —
 * that is an input that never arrives, not one it mishandles (`invariants.md` #9b).
 */

import { assertPaymentTransition, validatePaymentExplanationBudget } from '../domain/index.js';
import type { PaymentId, Paise, PersonId } from '../domain/index.js';
import {
  insertSettlement,
  listPaymentExpenseLinksByPayment,
  listSettlementsByPayment,
  updatePaymentState,
} from '../db/index.js';
import type { Database } from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { requirePayment } from './loaders.js';

export interface RecordSettlementInput {
  /** The payment that carried the money. Always required (ADR-0007). */
  readonly paymentId: PaymentId;
  /** The other party to the obligation being discharged. */
  readonly counterpartyPersonId: PersonId;
  /** Usually the whole payment, but may be a portion of it. */
  readonly amount: Paise;
  readonly reason?: string | null;
  readonly audit: AuditMeta;
}

export interface RecordSettlementResult {
  readonly settlementId: string;
  /** What is left of the payment after every link and settlement drawn on it. */
  readonly unexplainedRemainder: Paise;
}

/**
 * Records that a payment settles part or all of an obligation.
 *
 * Validates the shared payment-explanation budget first: expense links plus settlements
 * against one payment can never exceed what that payment actually moved.
 */
export async function recordSettlement(
  db: Database,
  input: RecordSettlementInput,
): Promise<RecordSettlementResult> {
  return runAudited(db, input.audit, (ctx) => recordSettlementWithin(ctx, input));
}

/** {@link recordSettlement}'s input, minus the audit metadata the caller's unit of work owns. */
export type RecordSettlementWithinInput = Omit<RecordSettlementInput, 'audit'>;

/**
 * The same recording, inside a unit of work someone else opened.
 *
 * Exists because accepting a `classify_transaction` inference whose `proposedKind` is
 * `settlement` has to write the `Settlement`, the inference's decision, and the payment's
 * counterparty in **one** transaction (`services.decideInference`). Re-implementing the
 * budget validation there would be a second copy of a financial rule; nesting `runAudited`
 * would open a second transaction and a second "did this audit anything" count.
 */
export async function recordSettlementWithin(
  ctx: AuditContext,
  input: RecordSettlementWithinInput,
): Promise<RecordSettlementResult> {
  const { exec, record } = ctx;
  const payment = await requirePayment(exec, input.paymentId);

  const existingLinks = await listPaymentExpenseLinksByPayment(exec, payment.id);
  const existingSettlements = await listSettlementsByPayment(exec, payment.id);
  const explanation = validatePaymentExplanationBudget({
    paymentAmount: payment.amount,
    linkAmounts: existingLinks.map((link) => link.amount),
    settlementAmounts: [...existingSettlements.map((row) => row.amount), input.amount],
  });

  const settlementId = await insertSettlement(exec, {
    paymentId: payment.id,
    counterpartyPersonId: input.counterpartyPersonId,
    amount: input.amount,
    reason: input.reason ?? null,
  });

  await record({
    entityType: 'settlement',
    entityId: settlementId,
    action: 'create',
    newValue: {
      paymentId: payment.id,
      counterpartyPersonId: input.counterpartyPersonId,
      amount: input.amount.toString(),
      // Direction is read from the linked payment, never stored again here.
      direction: payment.direction,
    },
  });

  // `linked` now means "explained" in general — by an expense link and/or a settlement.
  if (payment.state === 'normalized') {
    assertPaymentTransition('normalized', 'linked');
    await updatePaymentState(exec, payment.id, 'linked');
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: { state: 'normalized' },
      newValue: { state: 'linked' },
    });
  }

  return { settlementId, unexplainedRemainder: explanation.unexplained };
}
