/**
 * Learning from confirmations, end to end over a real database.
 *
 * The domain tests fix which patterns may be offered. This fixes the parts only a database can
 * show: that a proposal is inert until somebody approves it, that approving records the right
 * origin and effect, that an approved rule leads a suggestion **and names itself**, and — the one
 * that matters most — that none of it ever approves a transaction.
 *
 * Every row is invented. The merchant names are made up and the amounts are round numbers no
 * real statement would carry.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  approveRuleProposal,
  dismissRuleProposal,
  restoreRuleProposal,
  updateRule,
  classifyPayments,
  decideInference,
  listAttentionQuestions,
  listRuleProposals,
  listRules,
  normalizePayments,
} from '../../src/services/index.js';
import { unconfiguredTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user:dev', source: 'test' } as const;
const NO_MODEL = createAiService(unconfiguredTransport());

let database: TestDatabase;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
});

async function statementRow(rawDescription: string, day: number): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(40_000n),
    direction: 'debit',
    occurredAt: new Date(Date.UTC(2026, 7, day)),
    rawDescription,
    channel: 'card',
    state: 'imported',
  });
}

/** Reads the rows, proposes categories locally, and confirms one — a person's whole loop. */
async function confirm(paymentId: PaymentId, category: string): Promise<void> {
  const questions = await listAttentionQuestions(database.db, { limit: 'all' });
  const question = questions.items.find(
    (item) => item.subject.kind === 'payment' && item.subject.paymentId === paymentId,
  );
  const inferenceId = question?.suggestion?.inferenceId;
  if (inferenceId === undefined || inferenceId === null) {
    throw new Error('no proposal to confirm for that payment');
  }
  await decideInference(database.db, {
    inferenceId: inferenceId as never,
    decision: 'modify',
    modifiedOutput: {
      proposedKind: 'expense',
      relationshipType: 'personal',
      category,
      paidByPersonHint: null,
    },
    audit: AS_USER,
  });
}

async function readAndPropose(): Promise<void> {
  await normalizePayments(database.db, { audit: AS_USER });
  await classifyPayments(database.db, { ai: NO_MODEL, audit: AS_USER, deterministicOnly: true });
}

/** Two confirmed purchases at one invented merchant — the smallest thing that is a pattern. */
async function confirmTwice(): Promise<void> {
  const first = await statementRow('HARBOUR CAFE BANDRA', 5);
  const second = await statementRow('HARBOUR CAFE BANDRA', 9);
  await readAndPropose();
  await confirm(first, 'Dining');
  await confirm(second, 'Dining');
}

describe('a confirmation becomes a proposal, and nothing more', () => {
  it('offers a pattern once two payments have been confirmed the same way', async () => {
    await confirmTwice();

    const { proposals } = await listRuleProposals(database.db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.category).toBe('Dining');
    expect(proposals[0]?.examples).toHaveLength(2);
  });

  it('offers nothing after a single confirmation', async () => {
    const only = await statementRow('HARBOUR CAFE BANDRA', 5);
    await readAndPropose();
    await confirm(only, 'Dining');

    expect((await listRuleProposals(database.db)).proposals).toEqual([]);
  });

  it('creates no rule by listing proposals', async () => {
    await confirmTwice();
    await listRuleProposals(database.db);
    await listRuleProposals(database.db);

    // The whole promise of a proposal: it is inert until somebody approves it.
    expect(await listRules(database.db)).toEqual([]);
  });

  it('never learns from a proposal nobody confirmed', async () => {
    // Two payments read and proposed for, neither agreed to. A system that counted its own
    // suggestions as evidence would harden a guess into a standing rule.
    await statementRow('HARBOUR CAFE BANDRA', 5);
    await statementRow('HARBOUR CAFE BANDRA', 9);
    await readAndPropose();

    expect((await listRuleProposals(database.db)).proposals).toEqual([]);
  });
});

describe('approving one', () => {
  it('records it as promoted, and as a rule that only ever proposes', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);

    await approveRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      audit: AS_USER,
    });

    const rules = await listRules(database.db);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.origin).toBe('promoted_from_repeated_ai_suggestion');
    // Not a default that happened to hold — there is no argument that would make this `apply`.
    expect(rules[0]?.effect).toBe('propose');
    expect(rules[0]?.assertion).toEqual({ action: 'set_expense_category', category: 'Dining' });
  });

  it('stores exactly the wording that was on screen', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    const shown = proposals[0]!.wording;

    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const rules = await listRules(database.db);
    expect(rules[0]?.match.description).toBe(shown);
    expect(rules[0]?.match.descriptionOperator).toBe('contains');
  });

  it('audits the approval with the wording and the category', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const events = await database.db.select().from(schema.auditEvents);
    const created = events.filter((event) => event.entityType === 'rule');
    expect(created).toHaveLength(1);
    expect(created[0]?.actor).toBe('user:dev');
    expect(String(created[0]?.reason)).toContain('Dining');
  });

  it('stops offering a pattern an active rule already covers', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    expect((await listRuleProposals(database.db)).proposals).toEqual([]);
  });

  it('refuses a proposal id the confirmations no longer support', async () => {
    await confirmTwice();

    await expect(
      approveRuleProposal(database.db, { proposalId: 'learned:NOTHING:Dining', audit: AS_USER }),
    ).rejects.toThrow(/no longer being suggested/);
  });
});

describe('what an approved rule then does — and does not do', () => {
  it('leads a new payment’s suggestion, and names the rule that did it', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const later = await statementRow('HARBOUR CAFE BANDRA', 20);
    await readAndPropose();

    const questions = await listAttentionQuestions(database.db, { limit: 'all' });
    const question = questions.items.find(
      (item) => item.subject.kind === 'payment' && item.subject.paymentId === later,
    );

    expect(question?.suggestion?.category).toBe('Dining');
    // The attribution a reader needs in order to correct it.
    expect(question?.suggestion?.appliedRule?.wording).toBe(proposals[0]!.wording);
    expect(question?.suggestion?.why.join(' ')).toContain('Your rule');
  });

  it('still leaves the payment waiting for a person', async () => {
    // The sentence this whole ADR exists for. A rule may write the suggestion; it may never
    // decide the money.
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const later = await statementRow('HARBOUR CAFE BANDRA', 20);
    await readAndPropose();

    const expenses = await database.db.select().from(schema.expenses);
    const forLater = expenses.filter((expense) => expense.state === 'approved');
    // Two approved expenses exist — the two the person confirmed. The rule added none.
    expect(forLater).toHaveLength(2);

    const questions = await listAttentionQuestions(database.db, { limit: 'all' });
    const stillAsking = questions.items.some(
      (item) => item.subject.kind === 'payment' && item.subject.paymentId === later,
    );
    expect(stillAsking).toBe(true);
  });

  it('leaves a payment its wording does not match alone', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const other = await statementRow('CITYFIELD GYM', 20);
    await readAndPropose();

    const questions = await listAttentionQuestions(database.db, { limit: 'all' });
    const question = questions.items.find(
      (item) => item.subject.kind === 'payment' && item.subject.paymentId === other,
    );
    expect(question?.suggestion?.appliedRule ?? null).toBeNull();
  });

  it('changes no original statement row', async () => {
    await confirmTwice();
    const before = await database.db.select().from(schema.payments);

    const { proposals } = await listRuleProposals(database.db);
    await approveRuleProposal(database.db, { proposalId: proposals[0]!.id, audit: AS_USER });

    const after = await database.db.select().from(schema.payments);
    expect(after.map((row) => row.rawDescription).sort()).toEqual(
      before.map((row) => row.rawDescription).sort(),
    );
    expect(after.map((row) => String(row.amount)).sort()).toEqual(
      before.map((row) => String(row.amount)).sort(),
    );
  });
});

describe('declining a pattern (ADR-0065)', () => {
  it('stops it being offered, and records who declined it and why', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);

    await dismissRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      reason: 'This café is sometimes groceries.',
      audit: AS_USER,
    });

    const after = await listRuleProposals(database.db);
    expect(after.proposals).toEqual([]);
    expect(after.dismissed).toHaveLength(1);
    expect(after.dismissed[0]?.reason).toBe('This café is sometimes groceries.');
    expect(after.dismissed[0]?.dismissedBy).toBe('user:dev');
  });

  it('refuses a dismissal with no reason', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);

    await expect(
      dismissRuleProposal(database.db, {
        proposalId: proposals[0]!.id,
        reason: '   ',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/needs a reason/);
  });

  it('keeps it declined as more confirmations accumulate', async () => {
    // The evidence growing is not new information about the decision to decline it.
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    await dismissRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      reason: 'Not worth a rule.',
      audit: AS_USER,
    });

    const third = await statementRow('HARBOUR CAFE BANDRA', 20);
    await readAndPropose();
    await confirm(third, 'Dining');

    expect((await listRuleProposals(database.db)).proposals).toEqual([]);
  });

  it('changes no payment, no expense and no prior decision', async () => {
    await confirmTwice();
    const beforePayments = await database.db.select().from(schema.payments);
    const beforeExpenses = await database.db.select().from(schema.expenses);

    const { proposals } = await listRuleProposals(database.db);
    await dismissRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      reason: 'Not worth a rule.',
      audit: AS_USER,
    });

    const afterPayments = await database.db.select().from(schema.payments);
    const afterExpenses = await database.db.select().from(schema.expenses);
    expect(afterPayments.map((r) => r.rawDescription).sort()).toEqual(
      beforePayments.map((r) => r.rawDescription).sort(),
    );
    expect(afterExpenses.map((r) => `${r.state}:${String(r.category)}`).sort()).toEqual(
      beforeExpenses.map((r) => `${r.state}:${String(r.category)}`).sort(),
    );
  });

  it('offers it again when restored, without deleting the record of declining it', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    const key = proposals[0]!.id;
    await dismissRuleProposal(database.db, {
      proposalId: key,
      reason: 'Changed my mind later.',
      audit: AS_USER,
    });

    await restoreRuleProposal(database.db, { proposalKey: key, audit: AS_USER });

    const after = await listRuleProposals(database.db);
    expect(after.proposals.map((p) => p.id)).toContain(key);
    expect(after.dismissed).toEqual([]);
    // The row survives, so "declined, then changed my mind" is legible afterwards.
    const rows = await database.db.select().from(schema.ruleProposalDismissals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.restoredAt).not.toBeNull();
  });

  it('refuses to restore something that is not declined', async () => {
    await expect(
      restoreRuleProposal(database.db, { proposalKey: 'learned:NOTHING:Dining', audit: AS_USER }),
    ).rejects.toThrow(/not currently declined/);
  });
});

describe('what a pattern would reach, before approving it (ADR-0065)', () => {
  it('separates what is already filed from what it would newly match', async () => {
    await confirmTwice();
    // A third payment the same wording would catch, which nobody has filed.
    await statementRow('HARBOUR CAFE BANDRA KIOSK', 20);
    await readAndPropose();

    const { proposals } = await listRuleProposals(database.db);
    expect(proposals[0]?.reach.alreadyFiled).toBe(2);
    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(1);
    expect(proposals[0]?.reach.examplesOfNewMatches).toHaveLength(1);
  });

  it('reports no new matches when the wording only covers what was filed', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);

    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(0);
  });
});

describe('deactivating an approved rule (ADR-0065)', () => {
  it('stops it leading new suggestions', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    const { ruleId } = await approveRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      audit: AS_USER,
    });

    await updateRule(database.db, { ruleId, active: false, audit: AS_USER });

    await statementRow('HARBOUR CAFE BANDRA', 20);
    await readAndPropose();
    const questions = await listAttentionQuestions(database.db, { limit: 'all' });
    expect(questions.items.some((item) => item.suggestion?.appliedRule != null)).toBe(false);
  });

  it('keeps the rule on file with what it did, and touches nothing else', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    const { ruleId } = await approveRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      audit: AS_USER,
    });

    const beforePayments = await database.db.select().from(schema.payments);
    const beforeExpenses = await database.db.select().from(schema.expenses);

    await updateRule(database.db, { ruleId, active: false, audit: AS_USER });

    const rules = await listRules(database.db);
    const rule = rules.find((candidate) => candidate.id === ruleId);
    expect(rule?.active).toBe(false);
    // Still on file, still carrying its own history and its origin.
    expect(rule?.origin).toBe('promoted_from_repeated_ai_suggestion');
    expect(rule?.effect).toBe('propose');

    const afterPayments = await database.db.select().from(schema.payments);
    const afterExpenses = await database.db.select().from(schema.expenses);
    expect(afterPayments.map((r) => r.rawDescription).sort()).toEqual(
      beforePayments.map((r) => r.rawDescription).sort(),
    );
    // The categories a person confirmed are exactly as they were.
    expect(afterExpenses.map((r) => `${r.state}:${String(r.category)}`).sort()).toEqual(
      beforeExpenses.map((r) => `${r.state}:${String(r.category)}`).sort(),
    );
  });

  it('can be switched back on, and leads again', async () => {
    await confirmTwice();
    const { proposals } = await listRuleProposals(database.db);
    const { ruleId } = await approveRuleProposal(database.db, {
      proposalId: proposals[0]!.id,
      audit: AS_USER,
    });
    await updateRule(database.db, { ruleId, active: false, audit: AS_USER });
    await updateRule(database.db, { ruleId, active: true, audit: AS_USER });

    await statementRow('HARBOUR CAFE BANDRA', 20);
    await readAndPropose();
    const questions = await listAttentionQuestions(database.db, { limit: 'all' });
    expect(questions.items.some((item) => item.suggestion?.appliedRule != null)).toBe(true);
  });
});
