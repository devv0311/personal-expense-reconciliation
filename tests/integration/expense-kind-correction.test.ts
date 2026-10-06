/**
 * Correcting an expense that was approved as personal into one other people shared (ADR-0073).
 *
 * Pins the whole contract over HTTP, on synthetic data: the preview is the correction with the
 * write removed; the correction changes the kind and saves the split in one transaction, or
 * changes nothing; it is made against the kind the person saw, so a retry after a lost answer or
 * a second tab is told what the ledger holds instead of applying twice; and it never touches the
 * amount, the payment, the funding link, the category or the payer.
 *
 * Every figure is synthetic and worked out by hand in the assertions.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import type { ModelTransport } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import type { Api } from '../../src/api/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

const NO_MODEL: ModelTransport = {
  modelInfo: { provider: 'none', model: 'unconfigured' },
  availability: { configured: false, unavailableReason: 'No model in this test.' },
  complete: () => Promise.reject(new Error('No AI provider is configured.')),
};

/** ₹3,000.00 dinner and ₹1,250.50 groceries; balances consistent from ₹1,00,000.00. */
const STATEMENT = [
  'Account Statement (synthetic)',
  'Account No: XXXXXXXX0001',
  'Period: 01/08/26 to 31/08/26',
  '',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '03/08/26,UPI-QA CAFE DINNER,UPI/QA0001,03/08/26,"3,000.00",0.00,"97,000.00"',
  '05/08/26,UPI-QA GROCERS,UPI/QA0002,05/08/26,"1,250.50",0.00,"95,749.50"',
  '',
].join('\n');

let database: TestDatabase;
let api: Api;
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
  api = createApi({
    db: database.db,
    ai: createAiService(NO_MODEL),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await api.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as T };
}

interface AttentionBody {
  readonly items: readonly {
    readonly kind: string;
    readonly facts: readonly { readonly label: string; readonly value: string | null }[];
    readonly suggestion: { inferenceId: string | null; expenseId: string | null } | null;
  }[];
}

/** Imports the statement and approves the dinner exactly as the category card does: personal. */
async function approvedPersonalDinner(): Promise<string> {
  const imported = await call('POST', '/api/imports/statement', {
    actor: 'user',
    accountId: cast.account['account_hdfc_savings'],
    sourceSystem: 'synthetic',
    formatId: 'auto',
    contentBase64: Buffer.from(STATEMENT).toString('base64'),
    filename: 'statement.csv',
    fileReference: 'statement.csv',
    statementKind: 'bank',
  });
  expect(imported.status).toBe(201);
  const attention = await call<AttentionBody>('GET', '/api/attention?limit=50');
  const item = attention.body.items.find(
    (candidate) =>
      candidate.kind === 'classification_decision' &&
      candidate.facts.some((fact) => fact.value?.includes('QA CAFE DINNER') === true),
  );
  const { inferenceId, expenseId } = item!.suggestion!;
  const decided = await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
    actor: 'user',
    decision: 'modify',
    modifiedOutput: {
      proposedKind: 'expense',
      relationshipType: 'personal',
      category: 'Dining',
      paidByPersonHint: null,
    },
  });
  expect(decided.status).toBe(200);
  return expenseId!;
}

function correction(expenseId: string, overrides: Record<string, unknown> = {}) {
  return call('POST', `/api/expenses/${expenseId}/relationship`, {
    actor: 'user',
    expectedRelationshipType: 'personal',
    relationshipType: 'shared',
    reason: 'It was dinner with Alex, not just mine.',
    method: 'equal',
    beneficiaries: [
      { type: 'person', id: cast.userPersonId },
      { type: 'person', id: cast.person['person_flatmate_a'] },
    ],
    ...overrides,
  });
}

async function expenseRow(expenseId: string) {
  const [row] = await database.db
    .select({
      state: schema.expenses.state,
      amount: schema.expenses.amount,
      relationshipType: schema.expenses.relationshipType,
      category: schema.expenses.category,
      paidByPersonId: schema.expenses.paidByPersonId,
    })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, expenseId));
  return row!;
}

async function allocationVersions(expenseId: string) {
  return database.db
    .select({ id: schema.allocations.id, supersededAt: schema.allocations.supersededAt })
    .from(schema.allocations)
    .where(eq(schema.allocations.expenseId, expenseId));
}

async function currentLines(expenseId: string): Promise<string[]> {
  const rows = await database.db
    .select({ amount: schema.allocationLines.amount })
    .from(schema.allocationLines)
    .innerJoin(schema.allocations, eq(schema.allocations.id, schema.allocationLines.allocationId))
    .where(
      and(eq(schema.allocations.expenseId, expenseId), isNull(schema.allocations.supersededAt)),
    );
  return rows.map((row) => row.amount.toString()).sort();
}

async function fundingLinks(expenseId: string) {
  return database.db
    .select({
      paymentId: schema.paymentExpenseLinks.paymentId,
      amount: schema.paymentExpenseLinks.amount,
    })
    .from(schema.paymentExpenseLinks)
    .where(eq(schema.paymentExpenseLinks.expenseId, expenseId));
}

async function auditCount(): Promise<number> {
  return (await database.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents)).length;
}

async function alexBalance() {
  return (
    await call<{ amount: string; direction: string }>(
      'GET',
      `/api/people/${cast.person['person_flatmate_a']}/balance`,
    )
  ).body;
}

describe('what the read offers', () => {
  it('offers the three shared kinds for an expense approved as personal, and nothing once corrected', async () => {
    const expenseId = await approvedPersonalDinner();
    const before = await call<{ kindCorrection: { targets: string[] } }>(
      'GET',
      `/api/expenses/${expenseId}`,
    );
    expect(before.body.kindCorrection.targets).toEqual([
      'shared',
      'paid_on_behalf',
      'household_shared_flat',
    ]);
    expect((await correction(expenseId)).status).toBe(201);
    const after = await call<{ kindCorrection: { targets: string[] } }>(
      'GET',
      `/api/expenses/${expenseId}`,
    );
    expect(after.body.kindCorrection.targets).toEqual([]);
  });
});

describe('previewing the correction', () => {
  it('computes the split as if corrected, and writes nothing', async () => {
    const expenseId = await approvedPersonalDinner();
    const before = await expenseRow(expenseId);
    const audited = await auditCount();

    const preview = await call<{
      refusal: unknown;
      shares: { amount: string }[];
      obligations: { amount: string; direction: string }[];
    }>('POST', `/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_flatmate_a'] },
      ],
      ifCorrectedTo: { relationshipType: 'shared' },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.refusal).toBeNull();
    expect(preview.body.shares.map((share) => share.amount)).toEqual(['150000', '150000']);
    expect(preview.body.obligations).toEqual([
      expect.objectContaining({ amount: '150000', direction: 'collect' }),
    ]);

    expect(await expenseRow(expenseId)).toEqual(before);
    expect(await auditCount()).toBe(audited);
  });

  it('refuses a preview the correction would refuse, with the same reason', async () => {
    const expenseId = await approvedPersonalDinner();
    expect((await correction(expenseId)).status).toBe(201);
    const preview = await call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'equal',
        beneficiaries: [{ type: 'person', id: cast.userPersonId }],
        ifCorrectedTo: { relationshipType: 'shared' },
      },
    );
    expect(preview.status).toBe(409);
    expect(preview.body.error.message).toMatch(/recorded as shared/);
  });

  it('refuses a kind nobody owes for, and asking both hypotheticals at once', async () => {
    const expenseId = await approvedPersonalDinner();
    const gift = await call('POST', `/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      ifCorrectedTo: { relationshipType: 'gift' },
    });
    expect(gift.status).toBe(400);
    const both = await call('POST', `/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      ifCorrectedTo: { relationshipType: 'shared' },
      ifApprovedAs: { relationshipType: 'shared' },
    });
    expect(both.status).toBe(409);
  });
});

describe('correcting it', () => {
  it('changes the kind and saves the split together, and creates exactly the expected debt', async () => {
    const expenseId = await approvedPersonalDinner();
    const before = await expenseRow(expenseId);
    const linksBefore = await fundingLinks(expenseId);
    expect(before).toMatchObject({ state: 'approved', relationshipType: 'personal' });
    expect(await alexBalance()).toMatchObject({ amount: '0' });

    const corrected = await correction(expenseId);
    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({ from: 'personal', to: 'shared' });

    // The kind and the state moved; the amount, category, payer and funding did not.
    expect(await expenseRow(expenseId)).toEqual({
      ...before,
      state: 'allocated',
      relationshipType: 'shared',
    });
    expect(await fundingLinks(expenseId)).toEqual(linksBefore);
    expect(await currentLines(expenseId)).toEqual(['150000', '150000']);
    expect(await alexBalance()).toMatchObject({ amount: '150000', direction: 'collect' });

    // The user's own share halves; the gross spend is the statement's, untouched. (The groceries
    // line is still waiting for its question, so it counts for nothing yet.)
    const spending = await call<{ total: { amount: string }; own: { share: string } }>(
      'GET',
      '/api/spending?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z&months=1',
    );
    expect(spending.body.total.amount).toBe('300000');
    expect(spending.body.own.share).toBe('150000');
  });

  it('records the decision: old and new kind, with the reason, on the expense’s history', async () => {
    const expenseId = await approvedPersonalDinner();
    expect((await correction(expenseId)).status).toBe(201);
    const history = await call<{
      events: {
        entityType: string;
        action: string;
        oldValue: unknown;
        newValue: unknown;
        reason: string | null;
        actor: string;
      }[];
      allocationVersions: unknown[];
    }>('GET', `/api/expenses/${expenseId}/history`);
    const kindEvent = history.body.events.find(
      (event) =>
        event.entityType === 'expense' &&
        (event.newValue as { correction?: string } | null)?.correction === 'kind_after_approval',
    );
    expect(kindEvent).toMatchObject({
      action: 'update',
      actor: 'user',
      oldValue: { relationshipType: 'personal', state: 'approved' },
      newValue: { relationshipType: 'shared' },
    });
    expect(kindEvent!.reason).toMatch(/dinner with Alex/);
    expect(history.body.allocationVersions).toHaveLength(1);
  });

  it('a repeat of the same request (its answer lost) changes nothing and says what the ledger holds', async () => {
    const expenseId = await approvedPersonalDinner();
    expect((await correction(expenseId)).status).toBe(201);
    const after = await expenseRow(expenseId);
    const audited = await auditCount();

    const again = await correction(expenseId);
    expect(again.status).toBe(409);
    expect((again.body as { error: { message: string } }).error.message).toMatch(
      /now recorded as shared/,
    );
    expect(await expenseRow(expenseId)).toEqual(after);
    expect(await auditCount()).toBe(audited);
    expect((await allocationVersions(expenseId)).length).toBe(1);
    expect(await alexBalance()).toMatchObject({ amount: '150000' });
  });

  it('two corrections racing: exactly one wins, one split, one debt', async () => {
    const expenseId = await approvedPersonalDinner();
    const results = await Promise.all([
      correction(expenseId),
      correction(expenseId, { relationshipType: 'household_shared_flat' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const versions = await allocationVersions(expenseId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.supersededAt).toBeNull();
    expect(await alexBalance()).toMatchObject({ amount: '150000' });
  });

  it('supersedes an existing split of a personal expense rather than editing it', async () => {
    const expenseId = await approvedPersonalDinner();
    const own = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
    });
    expect(own.status).toBe(201);
    expect((await expenseRow(expenseId)).state).toBe('allocated');

    expect((await correction(expenseId)).status).toBe(201);
    const versions = await allocationVersions(expenseId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.supersededAt === null)).toHaveLength(1);
    expect(await currentLines(expenseId)).toEqual(['150000', '150000']);
  });

  it('divides the net amount after a refund, never the gross', async () => {
    const expenseId = await approvedPersonalDinner();
    const refund = await call('POST', `/api/expenses/${expenseId}/adjustments`, {
      actor: 'user',
      kind: 'merchant_refund',
      amount: '50000',
      occurredAt: '2026-08-06T10:00:00.000Z',
    });
    expect(refund.status).toBe(201);
    expect((await correction(expenseId)).status).toBe(201);
    // ₹3,000.00 less ₹500.00 refunded is ₹2,500.00: ₹1,250.00 each.
    expect(await currentLines(expenseId)).toEqual(['125000', '125000']);
    expect((await expenseRow(expenseId)).amount).toBe(300_000n);
  });
});

describe('what it refuses, and that a refusal changes nothing', () => {
  async function unchangedAfter<T extends { status: number }>(
    expenseId: string,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const before = await expenseRow(expenseId);
    const audited = await auditCount();
    const versions = (await allocationVersions(expenseId)).length;
    const result = await attempt();
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await expenseRow(expenseId)).toEqual(before);
    expect(await auditCount()).toBe(audited);
    expect((await allocationVersions(expenseId)).length).toBe(versions);
    return result;
  }

  it('rolls the kind back when the split cannot be saved: never shared with nobody named', async () => {
    const expenseId = await approvedPersonalDinner();
    await unchangedAfter(expenseId, () =>
      correction(expenseId, {
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: '00000000-0000-4000-8000-000000000000' },
        ],
      }),
    );
    await unchangedAfter(expenseId, () =>
      correction(expenseId, {
        method: 'exact',
        beneficiaries: undefined,
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: '100000' },
          {
            beneficiary: { type: 'person', id: cast.person['person_flatmate_a'] },
            amount: '100000',
          },
        ],
      }),
    );
    expect((await expenseRow(expenseId)).relationshipType).toBe('personal');
  });

  it('refuses a "shared" correction that names only the person who paid', async () => {
    const expenseId = await approvedPersonalDinner();
    const refused = await unchangedAfter(expenseId, () =>
      correction(expenseId, { beneficiaries: [{ type: 'person', id: cast.userPersonId }] }),
    );
    expect(refused.status).toBe(409);
    expect((await expenseRow(expenseId)).relationshipType).toBe('personal');
  });

  it('requires a reason, a debt-creating kind, and "personal" as the kind seen', async () => {
    const expenseId = await approvedPersonalDinner();
    for (const overrides of [
      { reason: '   ' },
      { reason: undefined },
      { relationshipType: 'gift' },
      { relationshipType: 'personal' },
      { expectedRelationshipType: 'shared' },
      { actor: 'ai' },
    ]) {
      const result = await unchangedAfter(expenseId, () => correction(expenseId, overrides));
      expect(result.status).toBe(400);
    }
  });

  it('refuses an expense not yet approved, and one approved as shared from the start', async () => {
    const imported = await call('POST', '/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'synthetic',
      formatId: 'auto',
      contentBase64: Buffer.from(STATEMENT).toString('base64'),
      filename: 'statement.csv',
      fileReference: 'statement.csv',
      statementKind: 'bank',
    });
    expect(imported.status).toBe(201);
    const attention = await call<AttentionBody>('GET', '/api/attention?limit=50');
    const pending = attention.body.items.find((candidate) =>
      candidate.facts.some((fact) => fact.value?.includes('QA GROCERS') === true),
    )!.suggestion!;
    const notYet = await unchangedAfter(pending.expenseId!, () => correction(pending.expenseId!));
    expect(notYet.status).toBe(409);
    expect((notYet.body as { error: { message: string } }).error.message).toMatch(
      /not been approved yet/,
    );
  });

  it('refuses when a payment behind it was set aside as a duplicate', async () => {
    const expenseId = await approvedPersonalDinner();
    const [link] = await fundingLinks(expenseId);
    await database.db
      .update(schema.payments)
      .set({ state: 'ignored' })
      .where(eq(schema.payments.id, link!.paymentId));
    const refused = await unchangedAfter(expenseId, () => correction(expenseId));
    expect(refused.status).toBe(409);
  });
});
