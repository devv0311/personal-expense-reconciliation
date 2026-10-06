/**
 * An imported dinner can be approved as a shared expense and become a real obligation.
 *
 * The category card on Needs attention used to approve every statement line as `personal`, and
 * nothing could change that afterwards, so a restaurant bill imported from a statement could
 * never produce a debt. What this pins is the supported path: the person chooses the kind
 * **before** approval (the existing `modify` decision, which has always carried a
 * `relationshipType`), sees the split the ledger would compute for it first, and approving it
 * allocates through the existing allocation route.
 *
 * It also pins what is deliberately not offered here: previewing "as if approved" for an expense
 * that is already approved. Correcting an approved personal expense afterwards is a separate,
 * explicit decision with its own preview (ADR-0073, `expense-kind-correction.test.ts`).
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

/**
 * No model configured, as on an installation with no provider: the local reader writes the
 * proposals (ADR-0060), which is the path every statement import on such an installation takes.
 */
const NO_MODEL: ModelTransport = {
  modelInfo: { provider: 'none', model: 'unconfigured' },
  availability: { configured: false, unavailableReason: 'No model in this test.' },
  complete: () => Promise.reject(new Error('No AI provider is configured.')),
};

/** Closing balances are consistent: 100,000.00 opening, less 3,000.00, then 1,250.50. */
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

interface Suggestion {
  readonly inferenceId: string | null;
  readonly expenseId: string | null;
  readonly category: string | null;
}
interface AttentionBody {
  readonly items: readonly {
    readonly kind: string;
    readonly facts: readonly { readonly label: string; readonly value: string | null }[];
    readonly suggestion: Suggestion | null;
  }[];
}

/** Imports the statement and finds the question about one line, by the words on it. */
async function importAndFind(words: string): Promise<Suggestion> {
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
      candidate.facts.some((fact) => fact.value?.includes(words) === true),
  );
  expect(item?.suggestion).toBeTruthy();
  return item!.suggestion!;
}

interface PreviewBody {
  readonly refusal: { readonly code: string } | null;
  readonly shares: readonly { readonly name: string; readonly amount: string }[];
  readonly obligations: readonly {
    readonly name: string;
    readonly amount: string;
    readonly direction: string;
  }[];
  readonly noObligationsBecause: string | null;
}

describe('previewing what sharing an imported expense would mean, before approving it', () => {
  it('names the derived expense on the question, so the screen can ask the ledger', async () => {
    const suggestion = await importAndFind('QA CAFE DINNER');
    expect(suggestion.expenseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(suggestion.inferenceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('computes the split as if approved as shared, with the ledger doing the dividing', async () => {
    const { expenseId } = await importAndFind('QA CAFE DINNER');
    const alex = cast.person['person_flatmate_a']!;

    const preview = await call<PreviewBody>(
      'POST',
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: alex },
        ],
        ifApprovedAs: { relationshipType: 'shared' },
      },
    );

    expect(preview.status).toBe(200);
    expect(preview.body.refusal).toBeNull();
    // ₹3,000.00 between two people: ₹1,500.00 each, and Alex owes the person who paid.
    expect(preview.body.shares.map((share) => share.amount)).toEqual(['150000', '150000']);
    expect(preview.body.obligations).toEqual([
      expect.objectContaining({ amount: '150000', direction: 'collect' }),
    ]);
    expect(preview.body.noObligationsBecause).toBeNull();
  });

  it('says plainly that a personal expense creates no debt, however many people are named', async () => {
    const { expenseId } = await importAndFind('QA CAFE DINNER');
    const alex = cast.person['person_flatmate_a']!;

    const preview = await call<PreviewBody>(
      'POST',
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: alex },
        ],
        ifApprovedAs: { relationshipType: 'personal' },
      },
    );

    expect(preview.body.obligations).toEqual([]);
    expect(preview.body.noObligationsBecause).toMatch(/bought for one person/);
  });

  it('refuses a kind outside the expense vocabulary', async () => {
    const { expenseId } = await importAndFind('QA CAFE DINNER');
    const preview = await call('POST', `/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      ifApprovedAs: { relationshipType: 'settlement' },
    });
    expect(preview.status).toBe(400);
  });

  it('is not offered for an expense that is already approved', async () => {
    const { expenseId, inferenceId } = await importAndFind('QA CAFE DINNER');
    const approved = await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
      actor: 'user',
      decision: 'accept',
    });
    expect(approved.status).toBe(200);

    const preview = await call('POST', `/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      ifApprovedAs: { relationshipType: 'shared' },
    });
    // Not a preview of a change nobody can make: its kind was part of what was approved.
    expect(preview.status).toBe(409);
  });
});

describe('approving an imported dinner as shared, and allocating it', () => {
  it('produces the expected own share and the expected debt, from one expense and one payment', async () => {
    const { expenseId, inferenceId } = await importAndFind('QA CAFE DINNER');
    const alex = cast.person['person_flatmate_a']!;

    // The decision carries the kind. Same route, same audit, same approval — only the kind the
    // person chose, where it used to be fixed at `personal`.
    const decided = await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
      actor: 'user',
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'Dining',
        paidByPersonHint: null,
      },
    });
    expect(decided.status).toBe(200);

    const allocated = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      decidedBy: 'manual',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: alex },
      ],
    });
    expect(allocated.status).toBe(201);

    // Alex owes ₹1,500.00 of the ₹3,000.00 the user paid.
    const balance = await call<{ amount: string; direction: string }>(
      'GET',
      `/api/people/${alex}/balance`,
    );
    expect(balance.body.amount).toBe('150000');
    expect(balance.body.direction).toBe('collect');

    // The user's own share is half. The gross is the statement's, untouched.
    const spending = await call<{
      total: { amount: string };
      own: { share: string; paidByYou: string; frontedForOthers: string };
    }>('GET', '/api/spending?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z&months=1');
    expect(spending.body.total.amount).toBe('300000');
    expect(spending.body.own.share).toBe('150000');
    expect(spending.body.own.paidByYou).toBe('300000');
    expect(spending.body.own.frontedForOthers).toBe('150000');

    // One expense for the one payment: nothing was duplicated to make it shared.
    const expenses = await call<{
      expenses: {
        id: string;
        description: string;
        grossAmount: string;
        relationshipType: string;
      }[];
    }>('GET', '/api/expenses?limit=50');
    const dinners = expenses.body.expenses.filter((row) => row.description.includes('DINNER'));
    expect(dinners).toHaveLength(1);
    expect(dinners[0]).toMatchObject({ grossAmount: '300000', relationshipType: 'shared' });
  });

  it('leaves the other imported line personal, as it was, and the dinner as the only debt', async () => {
    const { inferenceId } = await importAndFind('QA CAFE DINNER');
    await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
      actor: 'user',
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'Dining',
        paidByPersonHint: null,
      },
    });
    const attention = await call<AttentionBody>('GET', '/api/attention?limit=50');
    const groceries = attention.body.items.find((candidate) =>
      candidate.facts.some((fact) => fact.value?.includes('QA GROCERS') === true),
    );
    const accepted = await call(
      'POST',
      `/api/review/inferences/${groceries!.suggestion!.inferenceId}/decision`,
      {
        actor: 'user',
        decision: 'accept',
      },
    );
    expect(accepted.status).toBe(200);

    const expenses = await call<{
      expenses: { description: string; relationshipType: string }[];
    }>('GET', '/api/expenses?limit=50');
    expect(
      expenses.body.expenses.find((row) => row.description.includes('GROCERS'))?.relationshipType,
    ).toBe('personal');
  });
});

/* ------------------------------------------------------------ the approve-then-allocate pair */

interface AttentionWithSubject {
  readonly items: readonly {
    readonly kind: string;
    readonly subject: { readonly kind: string; readonly expenseId?: string };
  }[];
}

describe('approving as shared and saving the split are two writes: a partial success is recoverable', () => {
  /** Approves the dinner as shared with nothing yet allocated — what a failed second step leaves. */
  async function approvedAsSharedWithoutSplit() {
    const { expenseId, inferenceId } = await importAndFind('QA CAFE DINNER');
    const decided = await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
      actor: 'user',
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'Dining',
        paidByPersonHint: null,
      },
    });
    expect(decided.status).toBe(200);
    return { expenseId: expenseId!, inferenceId: inferenceId! };
  }

  async function expenseRow(expenseId: string) {
    const [row] = await database.db
      .select({
        state: schema.expenses.state,
        amount: schema.expenses.amount,
        relationshipType: schema.expenses.relationshipType,
      })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    return row!;
  }

  async function currentAllocations(expenseId: string) {
    return database.db
      .select({ id: schema.allocations.id })
      .from(schema.allocations)
      .where(
        and(eq(schema.allocations.expenseId, expenseId), isNull(schema.allocations.supersededAt)),
      );
  }

  async function auditCount(): Promise<number> {
    return (await database.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents))
      .length;
  }

  it('leaves the approved expense unchanged and still askable when the split is refused', async () => {
    const { expenseId } = await approvedAsSharedWithoutSplit();
    const before = await expenseRow(expenseId);
    const audited = await auditCount();

    // A split that cannot be saved: the person named does not exist.
    const refused = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      decidedBy: 'manual',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: '00000000-0000-4000-8000-000000000000' },
      ],
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // Nothing moved: same state, kind and gross; no allocation; not one audit event more.
    expect(await expenseRow(expenseId)).toEqual(before);
    expect(before).toMatchObject({ state: 'approved', relationshipType: 'shared' });
    expect(before.amount).toBe(300_000n);
    expect(await currentAllocations(expenseId)).toHaveLength(0);
    expect(await auditCount()).toBe(audited);

    // And the unfinished split is reachable from the existing "who shared this?" question.
    const attention = await call<AttentionWithSubject>('GET', '/api/attention?limit=50');
    expect(
      attention.body.items.some(
        (item) =>
          item.kind === 'allocation_missing' &&
          item.subject.kind === 'expense' &&
          item.subject.expenseId === expenseId,
      ),
    ).toBe(true);
  });

  it('refuses to send the committed approval again, and writes nothing when it does', async () => {
    const { inferenceId, expenseId } = await approvedAsSharedWithoutSplit();
    const before = await expenseRow(expenseId);
    const audited = await auditCount();

    for (const decision of ['accept', 'modify'] as const) {
      const again = await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
        actor: 'user',
        decision,
        ...(decision === 'modify'
          ? {
              modifiedOutput: {
                proposedKind: 'expense',
                relationshipType: 'personal',
                category: 'Dining',
                paidByPersonHint: null,
              },
            }
          : {}),
      });
      expect(again.status).toBe(409);
    }
    // In particular the kind was not quietly changed back to personal by the second attempt.
    expect(await expenseRow(expenseId)).toEqual(before);
    expect(await auditCount()).toBe(audited);
  });

  it('completes with the split alone: the same approved amount and kind, one allocation, the expected debt', async () => {
    const { expenseId } = await approvedAsSharedWithoutSplit();
    const alex = cast.person['person_flatmate_a']!;
    await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [{ type: 'person', id: '00000000-0000-4000-8000-000000000000' }],
    });

    const saved = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      decidedBy: 'manual',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: alex },
      ],
    });
    expect(saved.status).toBe(201);

    expect(await expenseRow(expenseId)).toMatchObject({
      state: 'allocated',
      relationshipType: 'shared',
      amount: 300_000n,
    });
    expect(await currentAllocations(expenseId)).toHaveLength(1);
    const balance = await call<{ amount: string; direction: string }>(
      'GET',
      `/api/people/${alex}/balance`,
    );
    expect(balance.body).toMatchObject({ amount: '150000', direction: 'collect' });
  });

  it('a repeated save (its first answer lost) supersedes the same split and never doubles the debt', async () => {
    const { expenseId } = await approvedAsSharedWithoutSplit();
    const alex = cast.person['person_flatmate_a']!;
    const split = {
      actor: 'user',
      method: 'equal',
      decidedBy: 'manual',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: alex },
      ],
    };
    expect((await call('POST', `/api/expenses/${expenseId}/allocation`, split)).status).toBe(201);
    expect((await call('POST', `/api/expenses/${expenseId}/allocation`, split)).status).toBe(201);

    // Two versions on record, exactly one current, and the balance is still one dinner's worth.
    expect(await currentAllocations(expenseId)).toHaveLength(1);
    const versions = await database.db
      .select({ id: schema.allocations.id })
      .from(schema.allocations)
      .where(eq(schema.allocations.expenseId, expenseId));
    expect(versions).toHaveLength(2);
    const balance = await call<{ amount: string }>('GET', `/api/people/${alex}/balance`);
    expect(balance.body.amount).toBe('150000');
  });
});

describe('the server decides the split; a preview is only ever a question', () => {
  async function approvedShared() {
    const { expenseId, inferenceId } = await importAndFind('QA CAFE DINNER');
    await call('POST', `/api/review/inferences/${inferenceId}/decision`, {
      actor: 'user',
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'Dining',
        paidByPersonHint: null,
      },
    });
    return expenseId!;
  }

  async function lines(expenseId: string): Promise<string[]> {
    const rows = await database.db
      .select({ amount: schema.allocationLines.amount })
      .from(schema.allocationLines)
      .innerJoin(schema.allocations, eq(schema.allocations.id, schema.allocationLines.allocationId))
      .where(
        and(eq(schema.allocations.expenseId, expenseId), isNull(schema.allocations.supersededAt)),
      );
    return rows.map((row) => row.amount.toString()).sort();
  }

  it('recomputes an equal split from the people named, ignoring any figure the caller adds', async () => {
    const expenseId = await approvedShared();
    const alex = cast.person['person_flatmate_a']!;

    const saved = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: alex },
      ],
      // What a tampered or stale client might add: none of it is read.
      shares: [{ name: 'Alex', amount: '1' }],
      obligations: [{ amount: '1', direction: 'collect' }],
      amount: '1',
    });
    expect(saved.status).toBe(201);
    expect(await lines(expenseId)).toEqual(['150000', '150000']);
  });

  it('is not bound by an earlier preview: naming different people gives that split, not the previewed one', async () => {
    const expenseId = await approvedShared();
    const alex = cast.person['person_flatmate_a']!;
    // Hypothetical previews are for an expense not yet approved; this one is approved, so ask the
    // plain preview as the dialog does once it is finishing, then save a *different* split.
    const preview = await call<PreviewBody>(
      'POST',
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: alex },
        ],
      },
    );
    expect(preview.body.shares.map((share) => share.amount)).toEqual(['150000', '150000']);

    const saved = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
    });
    expect(saved.status).toBe(201);
    expect(await lines(expenseId)).toEqual(['300000']);
  });

  it('refuses an exact split whose figures do not add up to the approved amount', async () => {
    const expenseId = await approvedShared();
    const alex = cast.person['person_flatmate_a']!;

    const refused = await call('POST', `/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'exact',
      lines: [
        { beneficiary: { type: 'person', id: cast.userPersonId }, amount: '100000' },
        { beneficiary: { type: 'person', id: alex }, amount: '100000' },
      ],
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await lines(expenseId)).toEqual([]);
  });
});
