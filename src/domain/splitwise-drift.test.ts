import { describe, expect, it } from 'vitest';

import { asId } from './ids.js';
import type { PersonId } from './ids.js';
import { paise } from './money.js';
import { compareSplitwiseBalance } from './splitwise-drift.js';

const USER = asId<'person'>('11111111-1111-1111-1111-111111111111') as PersonId;
const FRIEND = asId<'person'>('22222222-2222-2222-2222-222222222222') as PersonId;

describe('compareSplitwiseBalance', () => {
  it('returns null when the two balances agree exactly', () => {
    expect(
      compareSplitwiseBalance({
        ourNetBalance: paise(5_000n),
        theirNetBalance: paise(5_000n),
        userPersonId: USER,
        friendPersonId: FRIEND,
      }),
    ).toBeNull();
  });

  it('returns null when both sides are zero', () => {
    expect(
      compareSplitwiseBalance({
        ourNetBalance: paise(0n),
        theirNetBalance: paise(0n),
        userPersonId: USER,
        friendPersonId: FRIEND,
      }),
    ).toBeNull();
  });

  it('surfaces a discrepancy when Splitwise reports a lower balance', () => {
    const discrepancy = compareSplitwiseBalance({
      ourNetBalance: paise(5_000n),
      theirNetBalance: paise(3_000n),
      userPersonId: USER,
      friendPersonId: FRIEND,
    });

    expect(discrepancy).toMatchObject({
      kind: 'splitwise_balance_mismatch',
      personAId: USER,
      personBId: FRIEND,
      externalNetBalance: 3_000n,
    });
    expect(discrepancy?.detail).toContain('5000');
    expect(discrepancy?.detail).toContain('3000');
  });

  it('surfaces a discrepancy when Splitwise reports the opposite direction', () => {
    const discrepancy = compareSplitwiseBalance({
      ourNetBalance: paise(5_000n),
      theirNetBalance: paise(-5_000n),
      userPersonId: USER,
      friendPersonId: FRIEND,
    });

    expect(discrepancy).not.toBeNull();
    expect(discrepancy?.externalNetBalance).toBe(-5_000n);
  });

  it('surfaces a discrepancy when we show zero but Splitwise shows a balance', () => {
    const discrepancy = compareSplitwiseBalance({
      ourNetBalance: paise(0n),
      theirNetBalance: paise(1_000n),
      userPersonId: USER,
      friendPersonId: FRIEND,
    });

    expect(discrepancy).not.toBeNull();
  });

  it('never treats a one-paise gap as tolerable', () => {
    const discrepancy = compareSplitwiseBalance({
      ourNetBalance: paise(10_000n),
      theirNetBalance: paise(10_001n),
      userPersonId: USER,
      friendPersonId: FRIEND,
    });

    expect(discrepancy).not.toBeNull();
  });
});
