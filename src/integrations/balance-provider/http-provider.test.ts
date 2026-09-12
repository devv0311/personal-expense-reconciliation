/**
 * The HTTP balance-provider adapter, against a scripted `fetch`.
 *
 * The properties under test are the ones that decide whether a wrong number can reach a
 * waterfall: exact minor units, no invented timestamps, and every failure arriving as an
 * incomplete read rather than an exception or an empty success.
 */

import { describe, expect, it } from 'vitest';

import { createHttpBalanceProvider } from './http-provider.js';
import { createUnconfiguredBalanceProvider } from './unconfigured.js';

/**
 * The request body as a string.
 *
 * `RequestInit['body']` is a union including `FormData`, whose default stringification is
 * `[object FormData]` — useless in an assertion, so this narrows and fails loudly instead.
 */
function bodyText(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new Error('This call did not send a string body.');
  return init.body;
}

function provider(response: Response | (() => Promise<never>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : Promise.resolve(response);
  }) as unknown as typeof fetch;
  return {
    calls,
    port: createHttpBalanceProvider({
      endpointUrl: 'https://balances.example.test/v1/balances',
      accessToken: 'secret-provider-token',
      fetchImpl: impl,
    }),
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createHttpBalanceProvider', () => {
  it('asks about the refs it was given and reads exact minor units back', async () => {
    const { port, calls } = provider(
      ok({
        complete: true,
        balances: [
          {
            accountRef: 'ref-1',
            balanceMinorUnits: '1234500',
            currency: 'INR',
            asOf: '2026-09-12T04:30:00Z',
          },
        ],
      }),
    );

    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });

    expect(JSON.parse(bodyText(calls[0]!.init))).toEqual({ accountRefs: ['ref-1'] });
    expect(result.complete).toBe(true);
    expect(result.readings).toEqual([
      {
        externalAccountRef: 'ref-1',
        balance: 1_234_500n,
        currency: 'INR',
        asOf: new Date('2026-09-12T04:30:00Z'),
        status: 'ok',
      },
    ]);
  });

  it('keeps an overdrawn balance as a real balance', async () => {
    const { port } = provider(
      ok({
        complete: true,
        balances: [
          { accountRef: 'ref-1', balanceMinorUnits: '-45000', asOf: '2026-09-12T04:30:00Z' },
        ],
      }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.readings[0]!.balance).toBe(-45_000n);
    expect(result.readings[0]!.status).toBe('ok');
  });

  it('refuses a non-integer balance rather than rounding it into the ledger', async () => {
    const { port } = provider(
      ok({
        complete: true,
        balances: [
          { accountRef: 'ref-1', balanceMinorUnits: '1234.50', asOf: '2026-09-12T04:30:00Z' },
        ],
      }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.readings[0]!.status).toBe('unavailable');
    expect(result.readings[0]!.balance).toBeNull();
    expect(result.readings[0]!.failureReason).toContain('never rounded');
  });

  it('never stamps a balance with the fetch time when the provider gave no instant', async () => {
    const { port } = provider(
      ok({ complete: true, balances: [{ accountRef: 'ref-1', balanceMinorUnits: '100' }] }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.readings[0]!.asOf).toBeNull();
    expect(result.readings[0]!.status).toBe('unavailable');
    expect(result.readings[0]!.failureReason).toContain('no instant');
  });

  it('carries a per-account error through as an unavailable reading', async () => {
    const { port } = provider(
      ok({ complete: true, balances: [{ accountRef: 'ref-1', error: 'consent expired' }] }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.readings[0]!.status).toBe('unavailable');
    expect(result.readings[0]!.failureReason).toBe('consent expired');
  });

  it('reports a read that skipped an account as incomplete', async () => {
    const { port } = provider(
      ok({
        complete: true,
        balances: [{ accountRef: 'ref-1', balanceMinorUnits: '1', asOf: '2026-09-12T04:30:00Z' }],
      }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1', 'ref-2'] });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('1 of 2 accounts were not answered');
  });

  it("honours the provider's own claim that a read was partial", async () => {
    const { port } = provider(
      ok({
        complete: false,
        incompleteReason: 'Consent covers one of your accounts.',
        balances: [{ accountRef: 'ref-1', balanceMinorUnits: '1', asOf: '2026-09-12T04:30:00Z' }],
      }),
    );
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('Consent covers one of your accounts.');
  });

  it('turns a 401 into an incomplete read rather than an exception', async () => {
    const { port } = provider(new Response('token expired', { status: 401 }));
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.complete).toBe(false);
    expect(result.readings).toEqual([]);
    expect(result.incompleteReason).toContain('401');
  });

  it('turns an unreachable host into an incomplete read too', async () => {
    const { port } = provider(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('could not be reached');
  });

  it('never contacts the provider when nothing is linked', async () => {
    const { port, calls } = provider(ok({}));
    const result = await port.fetchBalances({ externalAccountRefs: [] });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ readings: [], complete: true });
  });

  it('puts the token in the Authorization header and describes itself without it', async () => {
    const { port, calls } = provider(ok({ complete: true, balances: [] }));
    await port.fetchBalances({ externalAccountRefs: ['ref-1'] });
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer secret-provider-token',
    );
    expect(JSON.stringify(port.describe())).not.toContain('secret-provider-token');
    expect(port.describe().endpointHost).toBe('balances.example.test');
  });
});

describe('createUnconfiguredBalanceProvider', () => {
  it('reports every read as incomplete rather than as an empty success', async () => {
    // `{ readings: [], complete: true }` would say "we checked every account and there was
    // nothing to report", which a screen would be entitled to render as agreement.
    const result = await createUnconfiguredBalanceProvider().fetchBalances({
      externalAccountRefs: ['ref-1'],
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('BALANCE_PROVIDER_URL');
    expect(result.incompleteReason).toContain('BALANCE_PROVIDER_TOKEN');
  });

  it('says it is unconfigured, so a screen can say so before anything is linked', () => {
    const capabilities = createUnconfiguredBalanceProvider().describe();
    expect(capabilities.configured).toBe(false);
    expect(capabilities.unavailableReason).toContain('statement you evidenced');
  });
});
