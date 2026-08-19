/**
 * Transaction normalization — the second step of the pipeline (`data-flow.md`, step 2).
 *
 * ```
 * api ─▶ services.normalizePayments ─▶ domain.refineChannel / domain.merchantAliasKey
 *                                   ─▶ db.findMerchantByAliasKey / db.applyPaymentNormalization
 * ```
 *
 * Gives an imported payment the meaning that can be established **deterministically from
 * evidence already in the row**, and nothing more. It does not decide what the payment *is*:
 * no expense/settlement/transfer/investment classification, no person resolution, no AI call.
 * Those are `data-flow.md` step 3 and have no code path from here.
 *
 * The deterministic leg only (ADR-0022). `data-flow.md` step 2 also describes an
 * `ai.normalizeMerchant()` leg producing a pending `AIInference` for anything unresolved;
 * that arrives with the rest of the AI boundary in phase 8, and until then an unresolved
 * counterparty simply stays `unknown` — a recorded outcome, not a gap.
 */

import { merchantAliasKey, refineChannel } from '../domain/index.js';
import { assertPaymentTransition } from '../domain/index.js';
import type {
  ImportBatchId,
  MerchantId,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentId,
  PaymentReferenceType,
} from '../domain/index.js';
import {
  applyPaymentNormalization,
  findMerchantByAliasKey,
  listPaymentsAwaitingNormalization,
} from '../db/index.js';
import type { Database } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';

export interface NormalizePaymentsInput {
  /** Scope to one import batch. Omitted means every payment still awaiting normalization. */
  readonly importBatchId?: ImportBatchId;
  readonly audit: AuditMeta;
}

export interface NormalizePaymentsResult {
  /** Every payment moved `imported → normalized`, in the order processed. */
  readonly normalizedPaymentIds: readonly PaymentId[];
  /** Payments whose stored `channel` actually changed — not those the rule merely ran on. */
  readonly channelRefinedCount: number;
  /** Payments whose counterparty was resolved to a merchant. */
  readonly merchantResolvedCount: number;
}

/**
 * Normalizes every eligible payment in one audited transaction.
 *
 * Eligibility is read **before** the transaction opens, and an empty result returns without
 * opening one at all. That is deliberate: `runAudited` refuses to commit a unit of work that
 * recorded no audit event, so entering it with nothing to do would throw `AUDIT_EVENT_MISSING`
 * rather than answer "there was nothing to normalize". Every eligible payment does produce an
 * event — its `state` changes even when neither channel nor counterparty does — so "no
 * eligible payments" is the only case that needs the early return.
 */
export async function normalizePayments(
  db: Database,
  input: NormalizePaymentsInput,
): Promise<NormalizePaymentsResult> {
  const awaiting = await listPaymentsAwaitingNormalization(db, input.importBatchId);
  if (awaiting.length === 0) {
    return { normalizedPaymentIds: [], channelRefinedCount: 0, merchantResolvedCount: 0 };
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const normalizedPaymentIds: PaymentId[] = [];
    let channelRefinedCount = 0;
    let merchantResolvedCount = 0;

    for (const payment of awaiting) {
      // PaymentRow types these as plain strings (the columns are `text` with CHECK
      // constraints, not enums), so the narrowing happens here, at the one place the
      // domain rule is called.
      const channel = refineChannel(
        payment.referenceType as PaymentReferenceType | null,
        payment.channel as PaymentChannel,
      );
      // Exact match on the canonical key — never a prefix or a similarity. A miss leaves the
      // counterparty `unknown`, which is a recorded outcome rather than a failure to retry.
      const merchantId = await findMerchantByAliasKey(
        exec,
        merchantAliasKey(payment.rawDescription),
      );
      // `merchant` is the only counterparty type this phase ever writes. A payment that is
      // plainly a self-transfer stays `unknown`: recognising that is classification (phase 8).
      const counterpartyType: PaymentCounterpartyType =
        merchantId === null ? 'unknown' : 'merchant';
      const counterpartyId: MerchantId | null = merchantId;

      assertPaymentTransition('imported', 'normalized');
      await applyPaymentNormalization(exec, payment.id, {
        channel,
        counterpartyType,
        counterpartyId,
      });

      await record({
        entityType: 'payment',
        entityId: payment.id,
        action: 'update',
        oldValue: {
          state: 'imported',
          channel: payment.channel,
          counterpartyType: payment.counterpartyType,
        },
        newValue: { state: 'normalized', channel, counterpartyType, counterpartyId },
      });

      normalizedPaymentIds.push(payment.id);
      if (channel !== payment.channel) channelRefinedCount += 1;
      if (merchantId !== null) merchantResolvedCount += 1;
    }

    return { normalizedPaymentIds, channelRefinedCount, merchantResolvedCount };
  });
}
