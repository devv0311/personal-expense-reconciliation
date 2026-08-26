import { describe, expect, it } from 'vitest';

import {
  parseClassificationResponse,
  parseExtractReceiptItemsResponse,
  parseParseReceiptResponse,
  parseReceiptDraft,
  parseReceiptItemDrafts,
  parseTransactionClassification,
} from './contract.js';
import { isAiContractError } from './errors.js';
import type { AiContractErrorCode } from './errors.js';

/** Runs a parser and returns the contract error's code and field, or fails loudly. */
function rejectionOf(
  parse: (raw: unknown) => unknown,
  raw: unknown,
): { code: AiContractErrorCode; field: string | undefined } {
  try {
    parse(raw);
  } catch (error) {
    if (!isAiContractError(error)) throw error;
    return { code: error.code, field: error.details['field'] };
  }
  throw new Error('Expected the response to be rejected, but it was accepted.');
}

/** Runs the parser and returns the contract error's code and field, or fails loudly. */
function rejection(raw: unknown): { code: AiContractErrorCode; field: string | undefined } {
  return rejectionOf(parseClassificationResponse, raw);
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

const RECEIPT_RESPONSE = {
  confidence: 'high',
  proposedOutput: {
    merchantHint: 'Sample Restaurant',
    subtotalMinorUnits: '250000',
    taxMinorUnits: '20000',
    totalMinorUnits: '270000',
    currency: 'INR',
  },
};

describe('parseParseReceiptResponse — the shapes the contract accepts', () => {
  it('accepts a well-formed draft', () => {
    expect(parseParseReceiptResponse(RECEIPT_RESPONSE)).toEqual({
      confidence: 'high',
      proposedOutput: {
        merchantHint: 'Sample Restaurant',
        subtotal: 250_000n,
        tax: 20_000n,
        total: 270_000n,
        currency: 'INR',
      },
    });
  });

  it('carries money as an exact bigint, never a float', () => {
    const { proposedOutput } = parseParseReceiptResponse(RECEIPT_RESPONSE);
    expect(typeof proposedOutput.total).toBe('bigint');
  });

  it('accepts a draft naming only one figure, with the rest null', () => {
    const parsed = parseParseReceiptResponse({
      confidence: 'low',
      proposedOutput: {
        merchantHint: null,
        subtotalMinorUnits: null,
        taxMinorUnits: null,
        totalMinorUnits: '285000',
        currency: 'INR',
      },
    });
    expect(parsed.proposedOutput).toEqual({
      merchantHint: null,
      subtotal: null,
      tax: null,
      total: 285_000n,
      currency: 'INR',
    });
  });
});

describe('parseParseReceiptResponse — what it refuses', () => {
  it('refuses a currency other than INR — V1 does arithmetic in one currency only', () => {
    expect(
      rejectionOf(parseParseReceiptResponse, {
        ...RECEIPT_RESPONSE,
        proposedOutput: { ...RECEIPT_RESPONSE.proposedOutput, currency: 'USD' },
      }),
    ).toEqual({ code: 'FIELD_INVALID', field: 'proposedOutput.currency' });
  });

  it('refuses a non-integer or negative minor-units string', () => {
    for (const totalMinorUnits of ['2700.00', '-1', '27_00', 'NaN', '']) {
      expect(
        rejectionOf(parseParseReceiptResponse, {
          ...RECEIPT_RESPONSE,
          proposedOutput: { ...RECEIPT_RESPONSE.proposedOutput, totalMinorUnits },
        }).code,
      ).toBe('FIELD_INVALID');
    }
  });

  it('refuses money sent as a JSON number rather than an exact string', () => {
    // Money crosses this boundary as a string precisely so it never passes through a float
    // (invariants.md #12) — a bare number is refused even when it looks exact.
    expect(
      rejectionOf(parseParseReceiptResponse, {
        ...RECEIPT_RESPONSE,
        proposedOutput: { ...RECEIPT_RESPONSE.proposedOutput, totalMinorUnits: 270000 },
      }).code,
    ).toBe('FIELD_INVALID');
  });

  it('refuses a field no key defines', () => {
    expect(
      rejectionOf(parseParseReceiptResponse, {
        ...RECEIPT_RESPONSE,
        proposedOutput: { ...RECEIPT_RESPONSE.proposedOutput, merchantId: 'merchant-1' },
      }),
    ).toEqual({ code: 'FIELD_UNEXPECTED', field: 'proposedOutput' });
  });
});

describe('parseReceiptDraft — the same gate for a human correction', () => {
  it('applies exactly the same rules a model response faces', () => {
    expect(
      rejectionOf(parseReceiptDraft, { ...RECEIPT_RESPONSE.proposedOutput, currency: 'USD' }),
    ).toEqual({ code: 'FIELD_INVALID', field: 'proposedOutput.currency' });
  });
});

const ITEMS_RESPONSE = {
  confidence: 'high',
  proposedOutput: [
    {
      description: 'Amul Milk 1L (x2)',
      quantity: '2',
      unitPriceMinorUnits: '4000',
      lineTotalMinorUnits: '8000',
      suggestedCategory: 'groceries',
    },
    {
      description: 'Chicken Breast 500g',
      quantity: '1',
      unitPriceMinorUnits: null,
      lineTotalMinorUnits: '31000',
      suggestedCategory: null,
    },
  ],
};

describe('parseExtractReceiptItemsResponse — the shapes the contract accepts', () => {
  it('accepts a well-formed item list', () => {
    expect(parseExtractReceiptItemsResponse(ITEMS_RESPONSE)).toEqual({
      confidence: 'high',
      proposedOutput: [
        {
          description: 'Amul Milk 1L (x2)',
          quantity: '2',
          unitPrice: 4_000n,
          lineTotal: 8_000n,
          suggestedCategory: 'groceries',
        },
        {
          description: 'Chicken Breast 500g',
          quantity: '1',
          unitPrice: null,
          lineTotal: 31_000n,
          suggestedCategory: null,
        },
      ],
    });
  });

  it('accepts an empty array — a total-only receipt with nothing itemized', () => {
    expect(
      parseExtractReceiptItemsResponse({ confidence: 'low', proposedOutput: [] }).proposedOutput,
    ).toEqual([]);
  });

  it('accepts a fractional quantity, up to three places', () => {
    const parsed = parseReceiptItemDrafts([
      {
        description: 'Rice (loose, by weight)',
        quantity: '1.250',
        unitPriceMinorUnits: null,
        lineTotalMinorUnits: '6000',
        suggestedCategory: null,
      },
    ]);
    expect(parsed[0]?.quantity).toBe('1.250');
  });
});

describe('parseExtractReceiptItemsResponse — what it refuses', () => {
  it('refuses a proposedOutput that is not an array', () => {
    expect(
      rejectionOf(parseExtractReceiptItemsResponse, {
        confidence: 'high',
        proposedOutput: ITEMS_RESPONSE.proposedOutput[0],
      }),
    ).toEqual({ code: 'MALFORMED_RESPONSE', field: 'proposedOutput' });
  });

  it('refuses an item with no description', () => {
    expect(
      rejectionOf(parseExtractReceiptItemsResponse, {
        confidence: 'high',
        proposedOutput: [{ ...ITEMS_RESPONSE.proposedOutput[0], description: undefined }],
      }),
    ).toEqual({ code: 'FIELD_MISSING', field: 'proposedOutput[0].description' });
  });

  it('refuses a zero or negative quantity', () => {
    for (const quantity of ['0', '-1', '0.000']) {
      expect(
        rejectionOf(parseExtractReceiptItemsResponse, {
          confidence: 'high',
          proposedOutput: [{ ...ITEMS_RESPONSE.proposedOutput[0], quantity }],
        }).field,
      ).toBe('proposedOutput[0].quantity');
    }
  });

  it('refuses a missing line total — an item with no total is not a line item', () => {
    expect(
      rejectionOf(parseExtractReceiptItemsResponse, {
        confidence: 'high',
        proposedOutput: [{ ...ITEMS_RESPONSE.proposedOutput[0], lineTotalMinorUnits: undefined }],
      }),
    ).toEqual({ code: 'FIELD_MISSING', field: 'proposedOutput[0].lineTotalMinorUnits' });
  });

  it('names the offending index when the second item is the malformed one', () => {
    expect(
      rejectionOf(parseExtractReceiptItemsResponse, {
        confidence: 'high',
        proposedOutput: [
          ITEMS_RESPONSE.proposedOutput[0],
          { ...ITEMS_RESPONSE.proposedOutput[1], lineTotalMinorUnits: 'not-a-number' },
        ],
      }).field,
    ).toBe('proposedOutput[1].lineTotalMinorUnits');
  });
});
