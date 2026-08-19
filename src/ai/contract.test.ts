import { describe, expect, it } from 'vitest';

import { parseClassificationResponse, parseTransactionClassification } from './contract.js';
import { isAiContractError } from './errors.js';
import type { AiContractErrorCode } from './errors.js';

/** Runs the parser and returns the contract error's code and field, or fails loudly. */
function rejection(raw: unknown): { code: AiContractErrorCode; field: string | undefined } {
  try {
    parseClassificationResponse(raw);
  } catch (error) {
    if (!isAiContractError(error)) throw error;
    return { code: error.code, field: error.details['field'] };
  }
  throw new Error('Expected the response to be rejected, but it was accepted.');
}

const EXPENSE_RESPONSE = {
  confidence: 'high',
  proposedOutput: {
    proposedKind: 'expense',
    relationshipType: 'personal',
    category: 'groceries',
    paidByPersonHint: { type: 'person', id: 'person-dev' },
  },
};

const SETTLEMENT_RESPONSE = {
  confidence: 'medium',
  proposedOutput: {
    proposedKind: 'settlement',
    counterpartyPersonHint: { type: 'person', id: 'person-friend-a' },
  },
};

describe('parseClassificationResponse — the shapes the contract accepts', () => {
  it('accepts a well-formed expense proposal', () => {
    expect(parseClassificationResponse(EXPENSE_RESPONSE)).toEqual({
      confidence: 'high',
      proposedOutput: {
        proposedKind: 'expense',
        relationshipType: 'personal',
        category: 'groceries',
        paidByPersonHint: { type: 'person', id: 'person-dev' },
      },
    });
  });

  it('accepts a well-formed settlement proposal', () => {
    expect(parseClassificationResponse(SETTLEMENT_RESPONSE)).toEqual({
      confidence: 'medium',
      proposedOutput: {
        proposedKind: 'settlement',
        counterpartyPersonHint: { type: 'person', id: 'person-friend-a' },
      },
    });
  });

  it('accepts every confidence level, including the model declining to guess', () => {
    for (const confidence of ['high', 'medium', 'low', 'unknown'] as const) {
      expect(parseClassificationResponse({ ...EXPENSE_RESPONSE, confidence }).confidence).toBe(
        confidence,
      );
    }
  });

  it('normalises an absent category and payer hint to null rather than undefined', () => {
    const parsed = parseClassificationResponse({
      confidence: 'low',
      proposedOutput: { proposedKind: 'expense', relationshipType: 'shared' },
    });

    expect(parsed.proposedOutput).toEqual({
      proposedKind: 'expense',
      relationshipType: 'shared',
      category: null,
      paidByPersonHint: null,
    });
  });

  it('accepts an explicit null for the optional fields', () => {
    const parsed = parseClassificationResponse({
      confidence: 'low',
      proposedOutput: {
        proposedKind: 'expense',
        relationshipType: 'gift',
        category: null,
        paidByPersonHint: null,
      },
    });

    expect(parsed.proposedOutput).toMatchObject({ category: null, paidByPersonHint: null });
  });
});

describe('parseClassificationResponse — what it refuses', () => {
  it('refuses a response that is not an object at all', () => {
    for (const raw of [null, undefined, 'expense', 42, [EXPENSE_RESPONSE]]) {
      expect(rejection(raw).field).toBe('response');
    }
    expect(rejection('expense').code).toBe('MALFORMED_RESPONSE');
  });

  it('refuses a missing or unrecognised confidence', () => {
    expect(rejection({ proposedOutput: EXPENSE_RESPONSE.proposedOutput })).toEqual({
      code: 'FIELD_MISSING',
      field: 'confidence',
    });
    expect(rejection({ ...EXPENSE_RESPONSE, confidence: 'very high' })).toEqual({
      code: 'FIELD_INVALID',
      field: 'confidence',
    });
    // A number is not a confidence, however confident it looks.
    expect(rejection({ ...EXPENSE_RESPONSE, confidence: 0.98 })).toEqual({
      code: 'FIELD_INVALID',
      field: 'confidence',
    });
  });

  it('refuses a proposedKind outside expense | settlement', () => {
    // The specific case ai-boundary.md names: "a proposedKind that isn't expense/settlement".
    for (const proposedKind of ['transfer', 'investment', 'refund', 'EXPENSE']) {
      expect(rejection({ confidence: 'high', proposedOutput: { proposedKind } })).toEqual({
        code: 'FIELD_INVALID',
        field: 'proposedOutput.proposedKind',
      });
    }
  });

  it('refuses a missing proposedOutput or proposedKind', () => {
    expect(rejection({ confidence: 'high' })).toEqual({
      code: 'FIELD_MISSING',
      field: 'proposedOutput',
    });
    expect(rejection({ confidence: 'high', proposedOutput: {} })).toEqual({
      code: 'FIELD_MISSING',
      field: 'proposedOutput.proposedKind',
    });
  });

  it('refuses an expense proposal with no relationship type', () => {
    expect(rejection({ confidence: 'high', proposedOutput: { proposedKind: 'expense' } })).toEqual({
      code: 'FIELD_MISSING',
      field: 'proposedOutput.relationshipType',
    });
  });

  it('refuses the relationship types ADR-0007 and ADR-0008 removed', () => {
    // A model trained on an older shape of this domain would propose exactly these.
    for (const relationshipType of ['settlement', 'reimbursement']) {
      expect(
        rejection({
          confidence: 'high',
          proposedOutput: { proposedKind: 'expense', relationshipType },
        }),
      ).toEqual({ code: 'FIELD_INVALID', field: 'proposedOutput.relationshipType' });
    }
  });

  it('refuses a settlement proposal with no counterparty — the other case ai-boundary.md names', () => {
    expect(
      rejection({ confidence: 'high', proposedOutput: { proposedKind: 'settlement' } }),
    ).toEqual({ code: 'FIELD_MISSING', field: 'proposedOutput.counterpartyPersonHint' });
  });

  it('refuses a person reference that is not one', () => {
    const withHint = (counterpartyPersonHint: unknown) => ({
      confidence: 'high',
      proposedOutput: { proposedKind: 'settlement', counterpartyPersonHint },
    });

    expect(rejection(withHint({ type: 'group', id: 'group-flat' })).field).toBe(
      'proposedOutput.counterpartyPersonHint.type',
    );
    expect(rejection(withHint({ type: 'person', id: '' })).field).toBe(
      'proposedOutput.counterpartyPersonHint.id',
    );
    expect(rejection(withHint({ type: 'person' })).field).toBe(
      'proposedOutput.counterpartyPersonHint.id',
    );
    expect(rejection(withHint('person-friend-a')).field).toBe(
      'proposedOutput.counterpartyPersonHint',
    );
  });

  it('refuses a field belonging to the other kind', () => {
    // A settlement has no relationship type, and an expense has no counterparty person: the
    // two paths "diverge here and never re-converge" (data-flow.md step 3).
    expect(
      rejection({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'settlement',
          counterpartyPersonHint: { type: 'person', id: 'person-friend-a' },
          relationshipType: 'shared',
        },
      }),
    ).toEqual({ code: 'FIELD_UNEXPECTED', field: 'proposedOutput' });

    expect(
      rejection({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'expense',
          relationshipType: 'shared',
          counterpartyPersonHint: { type: 'person', id: 'person-friend-a' },
        },
      }),
    ).toEqual({ code: 'FIELD_UNEXPECTED', field: 'proposedOutput' });
  });

  it('refuses a field no key defines, at every level', () => {
    expect(rejection({ ...EXPENSE_RESPONSE, note: 'here is my reasoning' })).toEqual({
      code: 'FIELD_UNEXPECTED',
      field: 'response',
    });
    expect(
      rejection({
        confidence: 'high',
        proposedOutput: { ...EXPENSE_RESPONSE.proposedOutput, amount: 124000 },
      }),
    ).toEqual({ code: 'FIELD_UNEXPECTED', field: 'proposedOutput' });
    expect(
      rejection({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'settlement',
          counterpartyPersonHint: { type: 'person', id: 'p1', displayName: 'Friend A' },
        },
      }),
    ).toEqual({ code: 'FIELD_UNEXPECTED', field: 'proposedOutput.counterpartyPersonHint' });
  });

  it('refuses a blank category rather than storing an empty label', () => {
    expect(
      rejection({
        confidence: 'high',
        proposedOutput: { proposedKind: 'expense', relationshipType: 'personal', category: '  ' },
      }),
    ).toEqual({ code: 'FIELD_INVALID', field: 'proposedOutput.category' });
  });

  it('never lets an amount, a beneficiary split or a balance in — there is no field for one', () => {
    // The proposal shape is the enforcement: arithmetic is domain's, not the model's
    // (ai-boundary.md, "What AI is explicitly not allowed to do").
    expect(
      rejection({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'expense',
          relationshipType: 'shared',
          allocation: [{ personId: 'p1', amount: 62000 }],
        },
      }).code,
    ).toBe('FIELD_UNEXPECTED');
  });
});

describe('parseTransactionClassification — the same gate for a human correction', () => {
  it('accepts a bare proposal without an envelope', () => {
    expect(parseTransactionClassification(EXPENSE_RESPONSE.proposedOutput)).toMatchObject({
      proposedKind: 'expense',
      relationshipType: 'personal',
    });
  });

  it('applies exactly the same rules a model response faces', () => {
    // decideInference's `modify` path runs a user's correction through this function, so a
    // human cannot enter by a laxer door than the model's.
    let code: string | undefined;
    try {
      parseTransactionClassification({ proposedKind: 'expense' });
    } catch (error) {
      if (isAiContractError(error)) code = error.code;
    }

    expect(code).toBe('FIELD_MISSING');
  });
});
