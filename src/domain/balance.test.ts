import { describe, expect, it } from 'vitest';

import {
  computeGrossObligation,
  computeNetBalance,
  computeObligations,
  obligationEvidenceStatus,
  settlementParties,
} from './balance.js';
import type { BalanceAllocationLine, BalanceInput, BalanceSettlement } from './balance.js';
import type { DomainError } from './errors.js';
import type { ExpenseRelationshipType } from './enums.js';
import { asId } from './ids.js';
import type { ExpenseId, GroupId, PersonId } from './ids.js';
import { paise } from './money.js';

const dev = asId<'person'>('person_dev');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateC = asId<'person'>('person_flatmate_c');
const friendA = asId<'person'>('person_friend_a');
const friendB = asId<'person'>('person_friend_b');
const flat = asId<'group'>('group_flat');

function expenseId(text: string): ExpenseId {
  return asId<'expense'>(text);
}

function personLine(
  expense: ExpenseId,
  beneficiaryId: PersonId,
  amount: bigint,
): BalanceAllocationLine {
  return { expenseId: expense, beneficiaryType: 'person', beneficiaryId, amount: paise(amount) };
}

function groupLine(
  expense: ExpenseId,
  beneficiaryId: GroupId,
  amount: bigint,
  expansion: ReadonlyArray<readonly [PersonId, bigint]>,
): BalanceAllocationLine {
  return {
    expenseId: expense,
    beneficiaryType: 'group',
    beneficiaryId,
    amount: paise(amount),
    groupExpansion: expansion.map(([personId, share]) => ({ personId, amount: paise(share) })),
  };
}

function ledger(params: {
  expenses: ReadonlyArray<{
    id: ExpenseId;
    relationshipType: ExpenseRelationshipType;
    paidByPersonId: PersonId;
  }>;
  lines: readonly BalanceAllocationLine[];
  settlements?: readonly BalanceSettlement[];
}): BalanceInput {
  return {
    userPersonId: dev,
    expenses: params.expenses,
    currentAllocationLines: params.lines,
    settlements: params.settlements ?? [],
  };
}

/* ------------------------------------------------------- the user fronted the money */

describe('obligations when the user paid (scenario §2)', () => {
  const dinner = expenseId('expense_dinner');
  const input = ledger({
    expenses: [{ id: dinner, relationshipType: 'shared', paidByPersonId: dev }],
    lines: [
      personLine(dinner, dev, 80000n),
      personLine(dinner, friendA, 80000n),
      personLine(dinner, friendB, 80000n),
    ],
  });

  it("creates no obligation from the payer's own line (invariant #2a)", () => {
    const obligations = computeObligations(input);

    expect(obligations.every((o) => o.debtorId !== dev)).toBe(true);
    expect(obligations).toHaveLength(2);
  });

  it('makes each other beneficiary owe the payer their line amount', () => {
    expect(computeGrossObligation(input, friendA, dev)).toBe(80000n);
    expect(computeGrossObligation(input, friendB, dev)).toBe(80000n);
  });

  it('shows the payer owing the beneficiaries nothing', () => {
    expect(computeGrossObligation(input, dev, friendA)).toBe(0n);
  });

  it('nets to Friend A owing Dev ₹800', () => {
    expect(computeNetBalance(input, friendA, dev)).toBe(80000n);
  });

  it('is antisymmetric: Dev owes Friend A minus ₹800', () => {
    expect(computeNetBalance(input, dev, friendA)).toBe(-80000n);
  });
});

describe('paid entirely on behalf of a friend (scenario §7)', () => {
  const gadget = expenseId('expense_gadget');
  const input = ledger({
    expenses: [{ id: gadget, relationshipType: 'paid_on_behalf', paidByPersonId: dev }],
    lines: [personLine(gadget, friendA, 150000n)],
  });

  it('makes the friend owe the full amount', () => {
    expect(computeNetBalance(input, friendA, dev)).toBe(150000n);
  });
});

/* ---------------------------------------------- someone else fronted the money (§26) */

describe('a flatmate paid the flat expense (scenario §26, ADR-0006)', () => {
  const electrician = expenseId('expense_electrician');
  const input = ledger({
    expenses: [
      { id: electrician, relationshipType: 'household_shared_flat', paidByPersonId: flatmateA },
    ],
    lines: [
      personLine(electrician, dev, 100000n),
      personLine(electrician, flatmateA, 100000n),
      personLine(electrician, flatmateC, 100000n),
    ],
  });

  it('makes the user owe the flatmate, not the other way round', () => {
    expect(computeNetBalance(input, dev, flatmateA)).toBe(100000n);
    expect(computeNetBalance(input, flatmateA, dev)).toBe(-100000n);
  });

  it("creates no obligation from the paying flatmate's own line", () => {
    expect(computeGrossObligation(input, flatmateA, flatmateA)).toBe(0n);
  });

  it('creates an obligation between two people, neither of whom is the user (§34)', () => {
    expect(computeNetBalance(input, flatmateC, flatmateA)).toBe(100000n);
  });

  it('does not route a non-user obligation through the user', () => {
    expect(computeNetBalance(input, flatmateC, dev)).toBe(0n);
  });

  it('names the creditor as the payer on every obligation it produces', () => {
    const obligations = computeObligations(input);

    expect(obligations).toHaveLength(2);
    expect(obligations.every((o) => o.creditorId === flatmateA)).toBe(true);
    expect(obligations.map((o) => o.debtorId).sort()).toEqual([dev, flatmateC].sort());
  });
});

describe('a friend paid the restaurant bill (scenario §27)', () => {
  const dinner = expenseId('expense_friend_dinner');
  const input = ledger({
    expenses: [{ id: dinner, relationshipType: 'shared', paidByPersonId: friendA }],
    lines: [personLine(dinner, dev, 90000n), personLine(dinner, friendA, 90000n)],
  });

  it('makes the user owe the friend ₹900, with no Group involved', () => {
    expect(computeNetBalance(input, dev, friendA)).toBe(90000n);
  });
});

describe('both directions at once', () => {
  const devPaid = expenseId('expense_dev_paid');
  const friendPaid = expenseId('expense_friend_paid');
  const input = ledger({
    expenses: [
      { id: devPaid, relationshipType: 'shared', paidByPersonId: dev },
      { id: friendPaid, relationshipType: 'shared', paidByPersonId: friendA },
    ],
    lines: [
      // Dev paid ₹3,000, split evenly: Friend A owes Dev ₹1,500.
      personLine(devPaid, dev, 150000n),
      personLine(devPaid, friendA, 150000n),
      // Friend A paid ₹1,000, split evenly: Dev owes Friend A ₹500.
      personLine(friendPaid, dev, 50000n),
      personLine(friendPaid, friendA, 50000n),
    ],
  });

  it('nets the two gross obligations against each other', () => {
    expect(computeGrossObligation(input, friendA, dev)).toBe(150000n);
    expect(computeGrossObligation(input, dev, friendA)).toBe(50000n);
    expect(computeNetBalance(input, friendA, dev)).toBe(100000n);
  });
});

/* ------------------------------------------------------------ non-debt-creating types */

describe('relationship types that never create a debt', () => {
  it('a gift creates no obligation, even with a non-payer beneficiary (§8)', () => {
    const gift = expenseId('expense_gift');
    const input = ledger({
      expenses: [{ id: gift, relationshipType: 'gift', paidByPersonId: dev }],
      lines: [personLine(gift, friendA, 250000n)],
    });

    expect(computeObligations(input)).toEqual([]);
    expect(computeNetBalance(input, friendA, dev)).toBe(0n);
  });

  it('a personal expense creates no obligation (§35)', () => {
    const solo = expenseId('expense_solo');
    const input = ledger({
      expenses: [{ id: solo, relationshipType: 'personal', paidByPersonId: dev }],
      lines: [personLine(solo, dev, 65000n)],
    });

    expect(computeObligations(input)).toEqual([]);
  });

  it('a personal expense whose beneficiary is somebody else still creates none', () => {
    // Defensive: `personal` is not in the debt-creating set at all, so the exclusion does
    // not depend on the beneficiary happening to be the payer.
    const odd = expenseId('expense_odd');
    const input = ledger({
      expenses: [{ id: odd, relationshipType: 'personal', paidByPersonId: dev }],
      lines: [personLine(odd, friendA, 65000n)],
    });

    expect(computeObligations(input)).toEqual([]);
  });
});

/* --------------------------------------------------------------- group beneficiaries */

describe('group-typed lines read the expansion, never the raw line (§33, ADR-0009)', () => {
  const july = expenseId('expense_electricity_july');
  const input = ledger({
    expenses: [{ id: july, relationshipType: 'household_shared_flat', paidByPersonId: dev }],
    lines: [
      groupLine(july, flat, 210000n, [
        [dev, 70000n],
        [flatmateA, 70000n],
        [flatmateC, 70000n],
      ]),
    ],
  });

  it('makes each resolved member individually owe the payer their share', () => {
    expect(computeNetBalance(input, flatmateA, dev)).toBe(70000n);
    expect(computeNetBalance(input, flatmateC, dev)).toBe(70000n);
  });

  it("creates no obligation from the payer's own expansion row", () => {
    expect(computeGrossObligation(input, dev, dev)).toBe(0n);
  });

  it('never treats the group itself as a debtor', () => {
    const obligations = computeObligations(input);

    expect(obligations.map((o) => o.debtorId)).not.toContain(flat as unknown as PersonId);
    expect(obligations).toHaveLength(2);
  });

  it('keeps a departed member owing their historical share', () => {
    // Flatmate C moved out on 2026-08-31; the July expansion is never recomputed.
    expect(computeNetBalance(input, flatmateC, dev)).toBe(70000n);
  });

  it('refuses to compute a balance from an unexpanded group line (invariant #2b)', () => {
    const unexpanded: BalanceInput = ledger({
      expenses: [{ id: july, relationshipType: 'household_shared_flat', paidByPersonId: dev }],
      lines: [
        { expenseId: july, beneficiaryType: 'group', beneficiaryId: flat, amount: paise(210000n) },
      ],
    });

    let raised: DomainError | undefined;
    try {
      computeObligations(unexpanded);
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('GROUP_EXPANSION_MISSING');
  });
});

/* -------------------------------------------------------------------- settlements */

describe('settlementParties — direction is read from the linked payment (§28, §29)', () => {
  it('a debit means the user paid the counterparty', () => {
    expect(
      settlementParties(
        { counterpartyPersonId: flatmateA, direction: 'debit', amount: paise(1n) },
        dev,
      ),
    ).toEqual({ fromPersonId: dev, toPersonId: flatmateA });
  });

  it('a credit means the counterparty paid the user', () => {
    expect(
      settlementParties(
        { counterpartyPersonId: flatmateA, direction: 'credit', amount: paise(1n) },
        dev,
      ),
    ).toEqual({ fromPersonId: flatmateA, toPersonId: dev });
  });
});

describe('a settlement discharges a balance without creating spend (§28)', () => {
  const electrician = expenseId('expense_electrician');
  const base = {
    expenses: [
      {
        id: electrician,
        relationshipType: 'household_shared_flat' as const,
        paidByPersonId: flatmateA,
      },
    ],
    lines: [
      personLine(electrician, dev, 100000n),
      personLine(electrician, flatmateA, 100000n),
      personLine(electrician, flatmateC, 100000n),
    ],
  };

  it('reduces the balance to zero when the user pays the flatmate in full', () => {
    const input = ledger({
      ...base,
      settlements: [
        { counterpartyPersonId: flatmateA, direction: 'debit', amount: paise(100000n) },
      ],
    });

    expect(computeNetBalance(input, dev, flatmateA)).toBe(0n);
  });

  it('leaves the gross obligation untouched — only the net balance moves', () => {
    const input = ledger({
      ...base,
      settlements: [
        { counterpartyPersonId: flatmateA, direction: 'debit', amount: paise(100000n) },
      ],
    });

    expect(computeGrossObligation(input, dev, flatmateA)).toBe(100000n);
  });

  it('handles a partial settlement', () => {
    const input = ledger({
      ...base,
      settlements: [{ counterpartyPersonId: flatmateA, direction: 'debit', amount: paise(40000n) }],
    });

    expect(computeNetBalance(input, dev, flatmateA)).toBe(60000n);
  });

  it('does not touch an unrelated pair', () => {
    const input = ledger({
      ...base,
      settlements: [
        { counterpartyPersonId: flatmateA, direction: 'debit', amount: paise(100000n) },
      ],
    });

    expect(computeNetBalance(input, flatmateC, flatmateA)).toBe(100000n);
  });
});

describe('a settlement received by the user (§29)', () => {
  const electrician = expenseId('expense_electrician_dev_paid');
  const input = ledger({
    expenses: [{ id: electrician, relationshipType: 'household_shared_flat', paidByPersonId: dev }],
    lines: [personLine(electrician, dev, 100000n), personLine(electrician, flatmateA, 100000n)],
    settlements: [{ counterpartyPersonId: flatmateA, direction: 'credit', amount: paise(100000n) }],
  });

  it('clears the flatmate’s debt to the user', () => {
    expect(computeNetBalance(input, flatmateA, dev)).toBe(0n);
  });

  it('is symmetric with the reverse direction — only payment direction differs', () => {
    expect(computeNetBalance(input, dev, flatmateA)).toBe(0n);
  });
});

describe('a settlement with no matching obligation still moves the balance', () => {
  it('leaves the counterparty in credit when they were owed nothing', () => {
    const input = ledger({
      expenses: [],
      lines: [],
      settlements: [{ counterpartyPersonId: friendA, direction: 'debit', amount: paise(50000n) }],
    });

    expect(computeNetBalance(input, dev, friendA)).toBe(-50000n);
  });
});

describe('the observability boundary (invariant #9b, §34)', () => {
  const electrician = expenseId('expense_electrician');
  const input = ledger({
    expenses: [
      { id: electrician, relationshipType: 'household_shared_flat', paidByPersonId: flatmateA },
    ],
    lines: [
      personLine(electrician, dev, 100000n),
      personLine(electrician, flatmateA, 100000n),
      personLine(electrician, flatmateC, 100000n),
    ],
  });

  it('keeps returning the pre-discharge amount when a settlement is unobservable', () => {
    // Flatmate C repays Flatmate A directly. No Payment reaches this ledger, so no
    // Settlement row exists — and none is fabricated.
    expect(computeNetBalance(input, flatmateC, flatmateA)).toBe(100000n);
  });

  it('does not throw or zero out for a pair the ledger cannot observe settlements for', () => {
    expect(() => computeNetBalance(input, flatmateC, flatmateA)).not.toThrow();
  });

  it('returns zero for two people with no shared history at all', () => {
    expect(computeNetBalance(input, friendA, friendB)).toBe(0n);
  });
});

/* -------------------------------------------------------- obligationEvidenceStatus */

describe('obligationEvidenceStatus — ADR-0014', () => {
  const electrician = expenseId('expense_electrician');

  it('is "open, unconfirmed" when a balance stands with no other evidence', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: null,
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('open_unconfirmed');
  });

  it('is "settled, confirmed" when the balance is zero', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(0n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: null,
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('settled_confirmed');
  });

  it('is "believed settled" when a settlement-claim note references a contributing expense', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [electrician],
        latestReconciliationRun: null,
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('believed_settled_unconfirmed_by_ledger');
  });

  it('ignores a settlement-claim note against an unrelated expense', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [expenseId('expense_unrelated')],
        latestReconciliationRun: null,
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('open_unconfirmed');
  });

  it('is "believed settled" when Splitwise reports a lower balance for the pair', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: {
          discrepancies: [
            {
              kind: 'balance_disagreement',
              detail: 'Splitwise shows this pair settled',
              personAId: flatmateC,
              personBId: flatmateA,
              externalNetBalance: paise(0n),
            },
          ],
        },
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('believed_settled_unconfirmed_by_ledger');
  });

  it('matches a discrepancy recorded for the pair in the opposite order', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: {
          discrepancies: [
            {
              kind: 'balance_disagreement',
              detail: 'reversed order',
              personAId: flatmateA,
              personBId: flatmateC,
              externalNetBalance: paise(0n),
            },
          ],
        },
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('believed_settled_unconfirmed_by_ledger');
  });

  it('ignores a discrepancy where Splitwise reports the same or a higher balance', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: {
          discrepancies: [
            {
              kind: 'balance_disagreement',
              detail: 'Splitwise agrees',
              personAId: flatmateC,
              personBId: flatmateA,
              externalNetBalance: paise(100000n),
            },
          ],
        },
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('open_unconfirmed');
  });

  it('ignores a discrepancy about a different pair', () => {
    expect(
      obligationEvidenceStatus({
        netBalance: paise(100000n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [],
        latestReconciliationRun: {
          discrepancies: [
            {
              kind: 'balance_disagreement',
              detail: 'other pair',
              personAId: dev,
              personBId: friendB,
              externalNetBalance: paise(0n),
            },
          ],
        },
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('open_unconfirmed');
  });

  it('is a read-only annotation — it never reports a settled balance as open', () => {
    // Even with "believed settled" signals present, a zero balance stays confirmed and
    // the status never rewrites NetBalance itself.
    expect(
      obligationEvidenceStatus({
        netBalance: paise(0n),
        contributingExpenseIds: [electrician],
        settlementClaimExpenseIds: [electrician],
        latestReconciliationRun: null,
        personAId: flatmateC,
        personBId: flatmateA,
      }),
    ).toBe('settled_confirmed');
  });
});
