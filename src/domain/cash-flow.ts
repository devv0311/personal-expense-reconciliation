/**
 * Cash-flow classification rules (ADR-0017 (cash balance), 17.1–17.2).
 *
 * `Payment.cash_flow_category` answers *what role this movement plays*;
 * `Payment.counterparty_type` answers *who was on the other side*. The two are orthogonal,
 * and neither replaces an `Expense`, a `Settlement` or an `ExpenseAdjustment` — a category
 * label alone never creates any of them (17.1).
 *
 * There are two gates here, and keeping them apart is the whole design:
 *
 *  - {@link validateCashFlowDirection} is **absolute**. A debit refund is not a borderline
 *    call, it is arithmetically impossible, so the rule holds at every stage and is also a
 *    row-local database `CHECK`.
 *  - {@link validateCashFlowApproval} is a gate at **approval only**. ADR-0017's category
 *    table is headed "Required interpretation *before approval*", and it says explicitly
 *    that "an unresolved counterparty is allowed during normalization". Enforcing the
 *    counterparty and evidence requirements at proposal time would make it impossible to
 *    ever propose a classification for the rows that most need one.
 */

import {
  isCreditOnlyCashFlowCategory,
  requiredCounterpartyTypeForCashFlow,
  type CashFlowCategory,
  type CashFlowState,
  type PaymentCounterpartyType,
  type PaymentDirection,
} from './enums.js';
import { DomainError } from './errors.js';

/**
 * Whether a category can describe a movement in this direction (17.2).
 *
 * `REFUND` and `EXTERNAL_INFLOW` are credits by definition — money coming back and money
 * arriving. `PEER_SETTLEMENT` and `INTERNAL_TRANSFER` run either way: the user repays a
 * friend (debit) or is repaid (credit); money leaves one owned account (debit) and arrives in
 * another (credit).
 */
export function cashFlowCategoryAllowsDirection(
  category: CashFlowCategory,
  direction: PaymentDirection,
): boolean {
  return !isCreditOnlyCashFlowCategory(category) || direction === 'credit';
}

/** Throws unless the category can describe a movement in this direction (17.2). */
export function validateCashFlowDirection(
  category: CashFlowCategory,
  direction: PaymentDirection,
): void {
  if (cashFlowCategoryAllowsDirection(category, direction)) return;
  throw new DomainError(
    'CASH_FLOW_DIRECTION_INVALID',
    `A ${direction} payment cannot be classified ${category}. ${category} describes money ` +
      'arriving, so it is only ever a credit (ADR-0017 (cash balance), 17.2).',
    { category, direction },
  );
}

/**
 * What the ledger can actually show for one payment, as approval sees it.
 *
 * Every field is a count or a fact read from other rows, never a confidence or a model
 * output: "high confidence does not waive" the approval requirement, and approval "requires
 * enough evidence to validate the chosen role" (ADR-0017 (cash balance)).
 */
export interface CashFlowApprovalEvidence {
  /** `Settlement` rows carried by this payment. */
  readonly settlementCount: number;
  /** `ExpenseAdjustment` rows naming this payment as the credit money came back on. */
  readonly expenseAdjustmentCount: number;
  /** `Evidence` rows attached to this payment. */
  readonly linkedEvidenceCount: number;
  /** The counter-leg of a transfer, when this run can see one (ADR-0023's pairing). */
  readonly counterLegPaymentId: string | null;
  /** Whether the account this payment moved through belongs to the user. */
  readonly ownedAccount: boolean;
}

export interface CashFlowApprovalInput {
  readonly direction: PaymentDirection;
  readonly counterpartyType: PaymentCounterpartyType;
  /** `null` is valid for an ordinary purchase or investment debit, never for a credit. */
  readonly category: CashFlowCategory | null;
  readonly evidence: CashFlowApprovalEvidence;
}

/**
 * The approval gate: enough evidence to validate the chosen role, or no approval.
 *
 * Each branch encodes one row of ADR-0017's category table:
 *
 *  - **`PEER_SETTLEMENT`** needs a resolved `person` counterparty *and* real `Settlement`
 *    attribution — "a person counterparty alone is insufficient". This is what stops a
 *    payment being reclassified into a settlement without the record that discharges a debt.
 *  - **`REFUND`** needs the `ExpenseAdjustment` it is a refund *of*. Without one there is no
 *    expense whose cost came down, and the credit explains nothing.
 *  - **`INTERNAL_TRANSFER`** needs an owned account, the `internal_account` counterparty, and
 *    transfer evidence — the counter-leg, or a document. A missing counter-leg alone does not
 *    block approval, because the far leg may genuinely post in another period; it surfaces as
 *    an `unpaired_internal_transfer` discrepancy instead (17.3).
 *  - **`EXTERNAL_INFLOW`** needs evidence of its own *and* the absence of a settlement or
 *    adjustment explanation — it is the residual category, and 17.2 forbids it becoming the
 *    automatic catch-all that closes a discrepancy.
 *  - **`null`** is fine on a debit, whose existing spend/investment explanation is unchanged
 *    by this ADR, and is refused on a credit: an unclassified credit is unexplained.
 */
export function validateCashFlowApproval(input: CashFlowApprovalInput): void {
  const { category, direction, counterpartyType, evidence } = input;

  if (category === null) {
    if (direction === 'credit') {
      throw new DomainError(
        'CASH_FLOW_CATEGORY_REQUIRED',
        'A credit cannot be approved with no cash-flow category. An unclassified credit is ' +
          'unexplained, and EXTERNAL_INFLOW is never the automatic catch-all that closes a ' +
          'discrepancy (ADR-0017 (cash balance), 17.2).',
        { direction },
      );
    }
    return;
  }

  validateCashFlowDirection(category, direction);

  const requiredCounterparty = requiredCounterpartyTypeForCashFlow(category);
  if (requiredCounterparty !== null && counterpartyType !== requiredCounterparty) {
    throw new DomainError(
      'CASH_FLOW_EVIDENCE_INSUFFICIENT',
      `${category} requires counterparty_type "${requiredCounterparty}", but this payment is ` +
        `"${counterpartyType}". Approval requires enough evidence to validate the chosen ` +
        'role (ADR-0017 (cash balance), 17.2).',
      { category, counterpartyType, requiredCounterparty },
    );
  }

  switch (category) {
    case 'PEER_SETTLEMENT':
      if (evidence.settlementCount === 0) {
        throw insufficient(
          category,
          'it references no approved Settlement attribution. A person counterparty alone is ' +
            'insufficient, and a category label never creates the record that discharges a debt.',
        );
      }
      return;
    case 'REFUND':
      if (evidence.expenseAdjustmentCount === 0) {
        throw insufficient(
          category,
          'no ExpenseAdjustment names this credit. A refund is money returned against an ' +
            'existing expense; with no adjustment there is no expense whose cost came down.',
        );
      }
      return;
    case 'INTERNAL_TRANSFER':
      if (!evidence.ownedAccount) {
        throw insufficient(
          category,
          'the account it moved through is not one the user owns, so this is not a movement ' +
            'between accounts the user owns.',
        );
      }
      if (evidence.counterLegPaymentId === null && evidence.linkedEvidenceCount === 0) {
        throw insufficient(
          category,
          'there is neither a counter-leg nor attached transfer evidence. A leg that posts in ' +
            'another period is surfaced as an unpaired transfer (17.3), but a leg with no ' +
            'evidence at all is an assertion, not a transfer.',
        );
      }
      return;
    case 'EXTERNAL_INFLOW':
      if (evidence.settlementCount > 0 || evidence.expenseAdjustmentCount > 0) {
        throw insufficient(
          category,
          'a Settlement or ExpenseAdjustment already explains this credit, so it is not an ' +
            'inflow that nothing else accounts for.',
        );
      }
      if (evidence.linkedEvidenceCount === 0) {
        throw insufficient(
          category,
          'it carries no evidence of its own. EXTERNAL_INFLOW must never be the automatic ' +
            'catch-all used to close a discrepancy.',
        );
      }
      return;
  }
}

/**
 * True when this payment's cash movement counts as explained by its cash-flow role alone.
 *
 * Two categories explain their own whole amount once approved, because the movement *is* the
 * explanation and there is no other record to point at: an internal transfer moved the user's
 * own money, and an approved external inflow is, by definition, a credit nothing else accounts
 * for. Every other category is explained by the rows it references — a `Settlement`, an
 * `ExpenseAdjustment`, a `PaymentExpenseLink` — so that each attributed paise is explained
 * exactly once (17.1).
 */
export function categoryExplainsWholeMovement(
  category: CashFlowCategory | null,
  cashFlowState: CashFlowState,
): boolean {
  if (cashFlowState !== 'approved') return false;
  return category === 'INTERNAL_TRANSFER' || category === 'EXTERNAL_INFLOW';
}

/* ------------------------------------------------------------------------- internals */

function insufficient(category: CashFlowCategory, why: string): DomainError {
  return new DomainError(
    'CASH_FLOW_EVIDENCE_INSUFFICIENT',
    `${category} cannot be approved: ${why} (ADR-0017 (cash balance), 17.2).`,
    { category },
  );
}
