/**
 * The Splitwise adapter, against a stub `fetch`.
 *
 * The assertions that matter are about **money and honesty**, not about HTTP: that paise
 * survive the trip through Splitwise's major-unit decimal strings exactly, that their sign
 * convention is flipped once and in one place, and that a failure or a truncated read is
 * reported as such rather than as agreement (ADR-0046).
 */

import { describe, expect, it, vi } from 'vitest';

import { paise } from '../../domain/index.js';

import { createSplitwiseAdapter, SplitwiseTransportError } from './adapter.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OPTIONS = { apiKey: 'k', connectedSplitwiseUserId: '1' };

/** A `fetch` stub answering with one response — the adapter's only outside dependency. */
function respondWith(response: Response): typeof fetch {
  return () => Promise.resolve(response);
}

/** The JSON body of the one request a stubbed `fetch` received. */
function requestBody(fetchImpl: { mock: { calls: unknown[][] } }): string {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') {
    throw new Error('The adapter made no request, or sent no body.');
  }
  return init.body;
}

describe('fetchBalances', () => {
  it('converts Splitwise decimal strings to exact paise', async () => {
    const fetchImpl = vi.fn(
      respondWith(
        jsonResponse({
          friends: [
            { id: 42, balance: [{ currency_code: 'INR', amount: '1234.56' }] },
            { id: 43, balance: [{ currency_code: 'INR', amount: '-900.00' }] },
          ],
        }),
      ),
    );
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });

    const balances = await adapter.fetchBalances();
    // Their sign is "what the friend owes us"; ours is the opposite, flipped once here.
    expect(balances).toEqual([
      { splitwiseUserId: '42', netBalance: paise(-123456n) },
      { splitwiseUserId: '43', netBalance: paise(90000n) },
    ]);
  });

  it('skips a currency this system does not do arithmetic in', async () => {
    const fetchImpl = vi.fn(
      respondWith(
        jsonResponse({
          friends: [
            {
              id: 42,
              balance: [
                { currency_code: 'USD', amount: '10.00' },
                { currency_code: 'INR', amount: '500.00' },
              ],
            },
          ],
        }),
      ),
    );
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });
    // ADR-0012 is INR-only; summing a USD figure into an INR total would be a silent lie.
    expect(await adapter.fetchBalances()).toEqual([
      { splitwiseUserId: '42', netBalance: paise(-50000n) },
    ]);
  });

  it('throws rather than resolving empty when Splitwise cannot be read', async () => {
    const fetchImpl = vi.fn(respondWith(jsonResponse({}, 503)));
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });
    // Resolving `[]` here would report "connected, nothing owed" for an unreadable account.
    await expect(adapter.fetchBalances()).rejects.toThrow(SplitwiseTransportError);
  });

  it('throws on a 200 that carries an errors object', async () => {
    const fetchImpl = vi.fn(
      respondWith(jsonResponse({ errors: { base: ['Invalid API request'] } })),
    );
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });
    await expect(adapter.fetchBalances()).rejects.toThrow(/Invalid API request/);
  });
});

describe('fetchLedgerEntries', () => {
  it('reads each entry, its kind, and its own contribution to the pair balance', async () => {
    const fetchImpl = vi.fn(
      respondWith(
        jsonResponse({
          expenses: [
            {
              id: 900,
              description: 'Dinner',
              cost: '2400.00',
              currency_code: 'INR',
              date: '2026-07-04T00:00:00Z',
              users: [{ user: { id: 42 }, net_balance: '1200.00' }],
            },
            {
              id: 901,
              payment: true,
              description: 'Settle up',
              cost: '1200.00',
              currency_code: 'INR',
              deleted_at: '2026-07-09T00:00:00Z',
              users: [{ user: { id: 42 }, net_balance: '-1200.00' }],
            },
          ],
        }),
      ),
    );
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });

    const result = await adapter.fetchLedgerEntries!({ friendSplitwiseUserId: '42' });
    expect(result.complete).toBe(true);
    expect(result.entries).toEqual([
      expect.objectContaining({
        splitwiseEntryId: '900',
        kind: 'expense',
        totalAmount: paise(240000n),
        deleted: false,
        pairNetBalance: paise(-120000n),
      }),
      expect.objectContaining({
        splitwiseEntryId: '901',
        kind: 'payment',
        deleted: true,
        pairNetBalance: paise(120000n),
      }),
    ]);
  });

  it('reports a truncated read as incomplete, so nothing absent is called missing', async () => {
    const expenses = Array.from({ length: 500 }, (_unused, index) => ({
      id: index + 1,
      cost: '100.00',
      currency_code: 'INR',
      users: [{ user: { id: 42 }, net_balance: '50.00' }],
    }));
    const fetchImpl = vi.fn(respondWith(jsonResponse({ expenses })));
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });

    const result = await adapter.fetchLedgerEntries!({ friendSplitwiseUserId: '42' });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('page');
  });
});

describe('writes', () => {
  it('sends exact major units and returns the id Splitwise assigned', async () => {
    const fetchImpl = vi.fn(respondWith(jsonResponse({ expenses: [{ id: 555 }] })));
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });

    const result = await adapter.createExpense({
      description: 'Groceries',
      amount: paise(124005n),
      currency: 'INR',
      paidBySplitwiseUserId: '1',
      shares: [
        { splitwiseUserId: '1', owedAmount: paise(62003n) },
        { splitwiseUserId: '42', owedAmount: paise(62002n) },
      ],
    });

    expect(result.splitwiseExpenseId).toBe('555');
    const body = JSON.parse(requestBody(fetchImpl)) as Record<string, unknown>;
    // ₹1,240.05 — exact, never 1240.0499999999997.
    expect(body['cost']).toBe('1240.05');
    expect(body['users__0__owed_share']).toBe('620.03');
    expect(body['users__1__owed_share']).toBe('620.02');
    expect(body['users__0__paid_share']).toBe('1240.05');
    expect(body['users__1__paid_share']).toBe('0.00');
  });

  it('refuses to report success when Splitwise returns no id to audit against later', async () => {
    const fetchImpl = vi.fn(respondWith(jsonResponse({ expenses: [{}] })));
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });
    await expect(
      adapter.createExpense({
        description: null,
        amount: paise(100n),
        currency: 'INR',
        paidBySplitwiseUserId: '1',
        shares: [{ splitwiseUserId: '42', owedAmount: paise(100n) }],
      }),
    ).rejects.toThrow(/no id/);
  });

  it('records a settlement as a payment between the two people', async () => {
    const fetchImpl = vi.fn(respondWith(jsonResponse({ expenses: [{ id: 777 }] })));
    const adapter = createSplitwiseAdapter({ ...OPTIONS, fetchImpl });

    const result = await adapter.recordPayment({
      amount: paise(90000n),
      fromSplitwiseUserId: '42',
      toSplitwiseUserId: '1',
    });
    expect(result.splitwiseTransactionId).toBe('777');
    const body = JSON.parse(requestBody(fetchImpl)) as Record<string, unknown>;
    expect(body['payment']).toBe(true);
    expect(body['cost']).toBe('900.00');
  });
});
