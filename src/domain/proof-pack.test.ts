import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { paise } from './money.js';
import {
  buildProofPack,
  collectProofPackExportableStrings,
  formatDate,
  formatInr,
  renderProofPackText,
} from './proof-pack.js';
import type {
  BuildProofPackInput,
  ProofPackAuditFindingFact,
  ProofPackExpenseFact,
  ProofPackSettlementFact,
} from './proof-pack.js';

const USER = { personId: 'person_dev', displayName: 'Dev' } as const;
const RECIPIENT = { personId: 'person_friend_a', displayName: 'Friend A' } as const;

function expenseFact(overrides: Partial<ProofPackExpenseFact> = {}): ProofPackExpenseFact {
  return {
    expenseId: 'expense_1',
    description: 'Dinner at the pier',
    occurredAt: new Date('2026-08-10T18:00:00.000Z'),
    state: 'approved',
    paidByPersonId: USER.personId,
    grossAmount: paise(1_00_000n),
    netAmount: paise(1_00_000n),
    attributedReduction: paise(0n),
    unattributedReduction: paise(0n),
    refundBasis: 'none',
    pendingDistribution: false,
    reviewRequired: null,
    conflictingEvidence: false,
    evidence: [
      {
        evidenceId: 'evidence_1',
        type: 'receipt',
        capturedAt: new Date('2026-08-10T18:05:00.000Z'),
        label: 'PIER CAFE total 1000.00',
      },
    ],
    recipientShare: paise(50_000n),
    shareDirection: 'recipient_owes_user',
    ...overrides,
  };
}

function input(overrides: Partial<BuildProofPackInput> = {}): BuildProofPackInput {
  return {
    user: { ...USER },
    recipient: { ...RECIPIENT },
    asOf: new Date('2026-09-06T09:00:00.000Z'),
    // Negative: computeNetBalance(user, recipient) is negative when the recipient owes the user.
    netBalance: paise(-50_000n),
    evidenceStatus: 'open_unconfirmed',
    expenses: [expenseFact()],
    settlements: [],
    openAuditFindings: [],
    ...overrides,
  };
}

describe('buildProofPack — a normal shared expense', () => {
  it('quotes the balance and the recipient share without recomputing anything', () => {
    const pack = buildProofPack(input());

    expect(pack.netDirection).toBe('recipient_owes_user');
    expect(pack.amountOwed).toBe(50_000n);
    expect(pack.netBalance).toBe(-50_000n);
    expect(pack.expenseLines).toHaveLength(1);
    expect(pack.expenseLines[0]?.recipientShare).toBe(50_000n);
    expect(pack.expenseLines[0]?.payer).toBe('you');
    expect(pack.generatedText).toContain('Friend A owes me ₹500.00');
    expect(pack.generatedText).toContain('Dinner at the pier — 10 Aug 2026');
    expect(pack.generatedText).toContain(
      'Evidence: receipt (10 Aug 2026) — PIER CAFE total 1000.00',
    );
  });

  it('phrases the other direction when the user owes the recipient', () => {
    const pack = buildProofPack(
      input({
        netBalance: paise(50_000n),
        expenses: [
          expenseFact({
            shareDirection: 'user_owes_recipient',
            paidByPersonId: RECIPIENT.personId,
          }),
        ],
      }),
    );
    expect(pack.netDirection).toBe('user_owes_recipient');
    expect(pack.amountOwed).toBe(50_000n);
    expect(pack.generatedText).toContain('I owe Friend A ₹500.00');
    expect(pack.expenseLines[0]?.payer).toBe('recipient');
    expect(pack.generatedText).toContain('Friend A paid ₹1,000.00');
  });

  it('reports a zero balance as settled', () => {
    const pack = buildProofPack(
      input({ netBalance: paise(0n), evidenceStatus: 'settled_confirmed' }),
    );
    expect(pack.netDirection).toBe('settled');
    expect(pack.generatedText).toContain('settled up — nothing is owed either way');
  });
});

describe('buildProofPack — determinism', () => {
  it('produces byte-identical output, generatedText included, for identical input', () => {
    const a = buildProofPack(input());
    const b = buildProofPack(input());
    expect(JSON.stringify(a, jsonReplacer)).toBe(JSON.stringify(b, jsonReplacer));
    expect(a.generatedText).toBe(b.generatedText);
  });

  it('orders expenses, settlements and findings by a total order regardless of input order', () => {
    const early = expenseFact({
      expenseId: 'expense_early',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const late = expenseFact({
      expenseId: 'expense_late',
      occurredAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    const forward = buildProofPack(input({ expenses: [early, late] }));
    const reversed = buildProofPack(input({ expenses: [late, early] }));
    expect(forward.expenseLines.map((line) => line.expenseId)).toEqual([
      'expense_early',
      'expense_late',
    ]);
    expect(forward.generatedText).toBe(reversed.generatedText);
  });
});

describe('buildProofPack — recipient isolation', () => {
  it('names only the two parties in the rendered text', () => {
    const pack = buildProofPack(input());
    // "Flatmate A" is a real person in the cast but is not a party here; it must not appear.
    expect(pack.generatedText).not.toContain('Flatmate');
    const mentions = pack.generatedText.match(/Friend A|Dev/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    // No allocation line, no beneficiary set, no other share is exposed on an expense line.
    expect(Object.keys(pack.expenseLines[0] ?? {})).not.toContain('beneficiaries');
    expect(Object.keys(pack.expenseLines[0] ?? {})).not.toContain('allocationLines');
  });

  it('rejects a pack whose user and recipient are the same person', () => {
    try {
      buildProofPack(input({ recipient: { ...USER } }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('UNKNOWN_REFERENCE');
    }
  });
});

describe('buildProofPack — refunds', () => {
  it('shows an item refund and the resulting net cost', () => {
    const pack = buildProofPack(
      input({
        expenses: [
          expenseFact({
            grossAmount: paise(1_00_000n),
            attributedReduction: paise(15_000n),
            netAmount: paise(85_000n),
            refundBasis: 'item_attributed',
            recipientShare: paise(25_000n),
          }),
        ],
        netBalance: paise(-25_000n),
      }),
    );
    expect(pack.generatedText).toContain('Item refund: ₹150.00  →  net ₹850.00');
    expect(pack.expenseLines[0]?.attributedItemRefunds).toBe(15_000n);
    expect(pack.expenseLines[0]?.netAmount).toBe(85_000n);
  });

  it('flags a pending refund distribution as a caution warning and a line note', () => {
    const pack = buildProofPack(
      input({
        expenses: [expenseFact({ pendingDistribution: true, refundBasis: 'whole_expense' })],
      }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('PENDING_REFUND_DISTRIBUTION');
    expect(pack.generatedText).toContain('not yet reflected in the share above');
  });

  it('flags a refund that needs a manual allocation decision', () => {
    const pack = buildProofPack(
      input({
        expenses: [
          expenseFact({
            reviewRequired: {
              code: 'REFUND_ITEM_OWNERSHIP_REQUIRED',
              message: 'approve an item mapping',
            },
          }),
        ],
      }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('REFUND_ALLOCATION_REVIEW_REQUIRED');
    expect(pack.generatedText).toContain('still needs a manual allocation decision');
  });

  it('notes a mixed legacy + item adjustment basis', () => {
    const pack = buildProofPack(
      input({
        expenses: [
          expenseFact({
            refundBasis: 'mixed',
            attributedReduction: paise(10_000n),
            unattributedReduction: paise(5_000n),
            netAmount: paise(85_000n),
          }),
        ],
      }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('MIXED_LEGACY_AND_ITEM_ADJUSTMENTS');
    expect(pack.generatedText).toContain('Refunds (item + whole-expense): ₹150.00  →  net ₹850.00');
  });
});

describe('buildProofPack — settlements and reverse balances', () => {
  const settlement = (
    overrides: Partial<ProofPackSettlementFact> = {},
  ): ProofPackSettlementFact => ({
    settlementId: 'settlement_1',
    occurredAt: new Date('2026-08-20T10:00:00.000Z'),
    direction: 'credit',
    amount: paise(40_000n),
    ...overrides,
  });

  it('lists prior settlements as history without re-subtracting them', () => {
    const pack = buildProofPack(input({ settlements: [settlement()], netBalance: paise(10_000n) }));
    expect(pack.generatedText).toContain('SETTLEMENTS ALREADY RECORDED');
    expect(pack.generatedText).toContain('Friend A paid me ₹400.00 on 20 Aug 2026');
    expect(pack.netBalance).toBe(10_000n);
  });

  it('warns when a refund left a reverse balance after a settlement', () => {
    // Recipient already paid ₹400 (credit); a later refund leaves ₹150 owed back to them.
    const pack = buildProofPack(
      input({
        settlements: [settlement({ direction: 'credit', amount: paise(40_000n) })],
        netBalance: paise(15_000n),
      }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('REVERSE_BALANCE_AFTER_SETTLEMENT');
    expect(pack.generatedText).toContain('money owed back the other way');
  });

  it('does not warn about a reverse balance when the settlement and balance point the same way', () => {
    const pack = buildProofPack(
      input({
        settlements: [settlement({ direction: 'credit', amount: paise(40_000n) })],
        netBalance: paise(-15_000n),
      }),
    );
    expect(pack.warnings.map((w) => w.code)).not.toContain('REVERSE_BALANCE_AFTER_SETTLEMENT');
  });
});

describe('buildProofPack — uncertainty is preserved', () => {
  it('surfaces unresolved Phase 19 audit findings with a count', () => {
    const finding: ProofPackAuditFindingFact = {
      findingId: 'finding_1',
      kind: 'unattributed_balance_mismatch',
      findingClass: 'discrepancy',
      summary: 'Splitwise reports ₹200 more than this ledger for this pair',
      confidence: 'unknown',
      reviewStatus: 'open',
    };
    const pack = buildProofPack(input({ openAuditFindings: [finding] }));
    expect(pack.warnings.map((w) => w.code)).toContain('UNRESOLVED_AUDIT_FINDINGS');
    expect(pack.generatedText).toContain('1 Splitwise audit finding is still open');
    expect(pack.openAuditFindings).toHaveLength(1);
  });

  it('surfaces a believed-settled-but-unconfirmed status', () => {
    const pack = buildProofPack(
      input({ evidenceStatus: 'believed_settled_unconfirmed_by_ledger' }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('BELIEVED_SETTLED_UNCONFIRMED');
    expect(pack.generatedText).toContain('may already be settled');
  });

  it('notes conflicting evidence on a contributing payment', () => {
    const pack = buildProofPack(input({ expenses: [expenseFact({ conflictingEvidence: true })] }));
    expect(pack.warnings.map((w) => w.code)).toContain('CONFLICTING_EVIDENCE');
    expect(pack.generatedText).toContain('disagrees on a detail');
  });

  it('notes a contributing expense with no supporting evidence', () => {
    const pack = buildProofPack(input({ expenses: [expenseFact({ evidence: [] })] }));
    expect(pack.warnings.map((w) => w.code)).toContain('MISSING_SUPPORTING_EVIDENCE');
  });

  it('reports an empty history plainly rather than as an error', () => {
    const pack = buildProofPack(
      input({
        expenses: [],
        settlements: [],
        netBalance: paise(0n),
        evidenceStatus: 'settled_confirmed',
      }),
    );
    expect(pack.warnings.map((w) => w.code)).toContain('NO_SHARED_HISTORY');
    expect(pack.generatedText).toContain('no shared expenses or settlements');
  });

  it('always states the figures are unconfirmed by the recipient', () => {
    const pack = buildProofPack(input());
    expect(pack.generatedText).toContain('Derived from my records — not yet confirmed by you');
  });
});

describe('renderProofPackText / collectProofPackExportableStrings', () => {
  it('renders the same text buildProofPack embeds', () => {
    const built = buildProofPack(input());
    const { generatedText, ...rest } = built;
    expect(renderProofPackText(rest)).toBe(generatedText);
  });

  it('collects every string that would be exported', () => {
    const pack = buildProofPack(
      input({
        expenses: [
          expenseFact({
            description: 'Groceries',
            evidence: [
              {
                evidenceId: 'e',
                type: 'sms',
                capturedAt: new Date('2026-08-10T00:00:00.000Z'),
                label: 'HDFC alert',
              },
            ],
          }),
        ],
        openAuditFindings: [
          {
            findingId: 'f',
            kind: 'stale_refund_partial',
            findingClass: 'discrepancy',
            summary: 'a stale refund',
            confidence: 'medium',
            reviewStatus: 'acknowledged',
          },
        ],
      }),
    );
    const strings = collectProofPackExportableStrings(pack);
    expect(strings).toContain(pack.generatedText);
    expect(strings).toContain('Groceries');
    expect(strings).toContain('HDFC alert');
    expect(strings).toContain('a stale refund');
    expect(strings).toContain('Friend A');
  });
});

describe('formatInr', () => {
  it('groups thousands and always shows two decimals', () => {
    expect(formatInr(paise(0n))).toBe('₹0.00');
    expect(formatInr(paise(5n))).toBe('₹0.05');
    expect(formatInr(paise(70n))).toBe('₹0.70');
    expect(formatInr(paise(1_00_000n))).toBe('₹1,000.00');
    expect(formatInr(paise(123_456_789n))).toBe('₹1,234,567.89');
    expect(formatInr(paise(-45_000n))).toBe('-₹450.00');
  });
});

describe('formatDate', () => {
  it('formats in UTC, locale-independent', () => {
    expect(formatDate('2026-09-06T23:30:00.000Z')).toBe('6 Sep 2026');
    expect(formatDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan 2026');
  });
});

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}
