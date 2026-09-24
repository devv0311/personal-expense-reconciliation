/**
 * What one real-world financial event *is*, in the words a person uses for it.
 *
 * Every fact this reads is a decision somebody already recorded: what the counterparty was
 * (`Payment.counterparty_type`), what role the movement plays (`Payment.cash_flow_category`),
 * whether a settlement or an expense link exists, whether a reviewer marked the row a
 * restatement of another. **Nothing here infers anything.** It is a mapping from stored
 * decisions onto plain language, and where no decision has been recorded it says so
 * (`not_yet_known`) rather than guessing — which is the only reason it is allowed to live in
 * `domain` at all.
 *
 * Two of the eight values exist to keep a specific wrong screen from being drawn:
 *
 *  - **`transfer`** covers a credit-card bill payment and every other movement between the
 *    user's own accounts. It is not spending and must never be presented as spending
 *    (`invariants.md` #7, ADR-0011). The same holds for `investment`.
 *  - **`money_in`** is reached *only* through an explicit `EXTERNAL_INFLOW` classification. An
 *    unclassified credit stays `not_yet_known`, because `invariants.md` #11 is exactly that an
 *    unknown credit is unexplained rather than automatic income.
 */

import { DEBT_CREATING_RELATIONSHIP_TYPES, NON_SPEND_COUNTERPARTY_TYPES } from './enums.js';
import type { CashFlowCategory, PaymentCounterpartyType, PaymentDirection } from './enums.js';

/**
 * The plain-language kinds of event this product shows, most specific first.
 *
 * Ordered by how much is known, not alphabetically: the list doubles as the precedence
 * {@link paymentNature} applies, so a reader can check the rule by reading the array.
 */
export const PAYMENT_NATURES = [
  'duplicate',
  'transfer',
  'investment',
  'settlement',
  'refund',
  'spending',
  'money_in',
  'not_yet_known',
] as const;
export type PaymentNature = (typeof PAYMENT_NATURES)[number];

/** Only the recorded decisions. No amounts, because nothing here does arithmetic. */
export interface PaymentNatureInput {
  readonly direction: PaymentDirection;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly cashFlowCategory: CashFlowCategory | null;
  /** `domain.isDuplicateRepresentation`'s answer, passed in rather than re-derived. */
  readonly isDuplicateRepresentation: boolean;
  /** How many expenses this movement funds (`PaymentExpenseLink` rows). */
  readonly expenseLinkCount: number;
  /** How many debts it discharges (`Settlement` rows). */
  readonly settlementCount: number;
  /** How many `ExpenseAdjustment`s name it as the money coming back. */
  readonly adjustmentCount: number;
}

/**
 * The one kind of event this movement is.
 *
 * A confirmed duplicate answers first, before anything else can be said about it: the money it
 * represents was already counted once, so describing it as spending or as a transfer would be
 * describing a second movement that never happened (`invariants.md` #10).
 */
export function paymentNature(input: PaymentNatureInput): PaymentNature {
  if (input.isDuplicateRepresentation) return 'duplicate';

  // The counterparty decision outranks the cash-flow one because it is the stronger claim:
  // `internal_account` and `investment_instrument` put a payment outside spending by
  // classification alone, whatever else is recorded about it (`invariants.md` #7).
  if ((NON_SPEND_COUNTERPARTY_TYPES as readonly string[]).includes(input.counterpartyType)) {
    return input.counterpartyType === 'internal_account' ? 'transfer' : 'investment';
  }
  if (input.cashFlowCategory === 'INTERNAL_TRANSFER') return 'transfer';

  // A recorded `Settlement` or `ExpenseAdjustment` is a fact about this movement; the
  // cash-flow category beside it is the same fact stated by classification. Either is enough.
  if (input.settlementCount > 0 || input.cashFlowCategory === 'PEER_SETTLEMENT') {
    return 'settlement';
  }
  if (input.adjustmentCount > 0 || input.cashFlowCategory === 'REFUND') return 'refund';
  if (input.expenseLinkCount > 0) return 'spending';

  if (input.direction === 'credit') {
    return input.cashFlowCategory === 'EXTERNAL_INFLOW' ? 'money_in' : 'not_yet_known';
  }
  return 'not_yet_known';
}

/** True when this movement is one a spending total may ever count (`invariants.md` #7, #10). */
export function natureCountsAsSpending(nature: PaymentNature): boolean {
  return nature === 'spending';
}

/**
 * Why this movement is not spending, in one sentence — or `null` when it is.
 *
 * The sentence matters as much as the boolean. A screen that simply omits a credit-card bill
 * payment from a spending total teaches nobody anything; one that says "this moved money
 * between your own accounts, so it is not spending" is the product explaining itself.
 */
export function whyNotSpending(nature: PaymentNature): string | null {
  switch (nature) {
    case 'spending':
      return null;
    case 'transfer':
      return 'This moved money between your own accounts, so it is not spending.';
    case 'investment':
      return 'This bought an investment, so it is not counted as spending.';
    case 'settlement':
      return 'This settled up with somebody rather than buying anything, so it is not spending.';
    case 'refund':
      return 'This is money coming back against something already bought, not new spending.';
    case 'money_in':
      return 'This is money arriving, not money spent.';
    case 'duplicate':
      return 'This is the same money recorded twice. It is counted once, on the other record.';
    case 'not_yet_known':
      return 'Nothing on record says what this was for yet, so it is not counted as spending.';
  }
}

/* ------------------------------------------------------------- plain words for a split */

/**
 * Why an expense of this kind never creates a debt — or `null` when it can.
 *
 * `personal` and `gift` are outside {@link DEBT_CREATING_RELATIONSHIP_TYPES} by construction,
 * so dividing one among several people records who benefited and leaves nobody owing anything
 * (`invariants.md` #2a, `domain-model.md`'s Obligation section). Two surfaces need to say that
 * — the split preview before anything is written, and the event screen afterwards — and they
 * say it from here so they can never say it differently.
 */
export function nonDebtRelationshipWords(relationshipType: string): string | null {
  if ((DEBT_CREATING_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
    return null;
  }
  return relationshipType === 'gift'
    ? 'This is recorded as a gift, so nobody owes anything for it however it is divided. ' +
        'Change what it was on the expense itself if that is not right.'
    : 'This is recorded as something bought for one person, so naming anybody else divides ' +
        'it without creating a debt. Change what it was on the expense itself if it was shared.';
}

/**
 * What a set of shares means for who owes whom, in one sentence.
 *
 * Decided here rather than on a screen because it is a rule about obligations, not a caption:
 * a screen that assumed "everybody else owes the payer" would assert a debt for a `personal`
 * expense that the ledger's own balances correctly refuse to carry, and the two would disagree
 * in the reader's face. The direction follows who actually paid (ADR-0006), never the reader.
 */
export function shareObligationWords(input: {
  readonly relationshipType: string;
  readonly payerIsUser: boolean;
  readonly payerName: string;
}): string {
  const nothingOwed = nonDebtRelationshipWords(input.relationshipType);
  if (nothingOwed !== null) return nothingOwed;
  return input.payerIsUser
    ? 'Everybody other than you owes you their share.'
    : `Everybody other than ${input.payerName} owes them their share.`;
}

/* --------------------------------------------------------------- plain words for records */

/**
 * What a person calls a stored record.
 *
 * `receipt_image` and `email_receipt` collapse to one phrase on purpose: the reader holding
 * them calls both "the bill", and which file format it arrived in is a Details question.
 */
export function documentWords(evidenceType: string): string {
  switch (evidenceType) {
    case 'receipt_image':
    case 'email_receipt':
      return 'Bill or receipt';
    case 'screenshot':
      return 'Screenshot';
    case 'upi_notification':
    case 'bank_line':
      return 'Payment message';
    case 'manual_note':
      return 'Note you wrote';
    default:
      return 'Record';
  }
}

/**
 * Why a proposed connection looks related, one signal at a time.
 *
 * ADR-0044's six signals, said out loud. `agreed` is what `matchedSignals` carries and
 * `disagreed` is `conflictingSignals`; both are reported, because a candidate with a
 * disagreeing signal is still offered and the reader has to be told what disagrees.
 */
export function matchSignalWords(signal: string, verdict: 'agreed' | 'disagreed'): string {
  const agreed = verdict === 'agreed';
  switch (signal) {
    case 'reference':
      return agreed
        ? 'The transaction reference is the same on both.'
        : 'The transaction reference is different on each.';
    case 'amount':
      return agreed ? 'The amount is the same.' : 'The amounts do not match.';
    case 'direction':
      return agreed
        ? 'Both say the money went the same way.'
        : 'One says money went out and the other says it came in.';
    case 'account':
      return agreed
        ? 'It names the same account.'
        : 'It names a different account from this payment.';
    case 'time':
      return agreed ? 'They happened at about the same time.' : 'The times are far apart.';
    case 'merchant':
      return agreed ? 'The name on it matches this payment.' : 'The name on it is a different one.';
    default:
      return agreed ? `Something else agrees: ${signal}.` : `Something else disagrees: ${signal}.`;
  }
}
