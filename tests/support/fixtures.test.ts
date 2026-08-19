import { describe, expect, it } from 'vitest';

import { merchantAliasKey } from '../../src/domain/index.js';

import { fixturePaise, loadFixture, loadMerchants, loadPeopleAndGroups } from './fixtures.js';

describe('the fixture loader keeps rupee amounts exact', () => {
  it('loads every *_inr value as a string, never a number', () => {
    const fixture = loadFixture<{ original_expense: { amount_inr: unknown } }>(
      'refund-partial.json',
    );

    expect(typeof fixture.original_expense.amount_inr).toBe('string');
    expect(fixture.original_expense.amount_inr).toBe('900.0');
  });

  it('converts a fixture amount to exact paise', () => {
    const fixture = loadFixture<{ original_expense: { amount_inr: unknown } }>(
      'refund-partial.json',
    );

    expect(fixturePaise(fixture.original_expense.amount_inr)).toBe(90000n);
  });

  it('would preserve an amount a float round-trip corrupts', () => {
    // 8.29 * 100 === 828.9999999999999 in IEEE-754. Proven on the loader's own path,
    // because this is the guarantee that keeps the test harness itself honest.
    const parsed = JSON.parse(
      '{"amount_inr": 8.29}'.replace(/("amount_inr"\s*:\s*)(-?\d+(?:\.\d+)?)/, '$1"$2"'),
    ) as { amount_inr: string };

    expect(fixturePaise(parsed.amount_inr)).toBe(829n);
    expect(Math.round(8.29 * 100)).toBe(829); // rounding hides it; truncation would not
    expect(Math.trunc(8.29 * 100)).toBe(828); // ...and this is the bug being avoided
  });

  it('refuses an amount that reached it as a number', () => {
    expect(() => fixturePaise(900)).toThrow(/never passes through a float/);
  });

  it('leaves non-monetary numbers alone', () => {
    const fixture = loadFixture<{ payments: Array<Record<string, unknown>> }>(
      'duplicate-transaction.json',
    );

    expect(typeof fixture.payments[0]?.amount_inr).toBe('string');
    expect(fixture.payments[0]?.external_reference).toBe('UPI/2607121234/BLINKIT');
  });
});

describe('the synthetic cast is loadable and internally consistent', () => {
  const cast = loadPeopleAndGroups();

  it('names the seven synthetic people', () => {
    expect(cast.people.map((person) => person.id)).toEqual([
      'person_dev',
      'person_flatmate_a',
      'person_flatmate_b',
      'person_flatmate_c',
      'person_flatmate_d',
      'person_friend_a',
      'person_friend_b',
    ]);
  });

  it('marks exactly one person as the system user', () => {
    expect(cast.people.filter((person) => person.linked_user_id !== undefined)).toHaveLength(1);
  });

  it('carries the flat membership timeline scenario §33 depends on', () => {
    const flat = cast.group_memberships.filter(
      (membership) => membership.group_id === 'group_flat',
    );

    expect(flat.find((m) => m.person_id === 'person_flatmate_b')?.left_at).toBe(
      '2026-06-30T00:00:00Z',
    );
    expect(flat.find((m) => m.person_id === 'person_flatmate_c')?.joined_at).toBe(
      '2026-07-01T00:00:00Z',
    );
    expect(flat.find((m) => m.person_id === 'person_flatmate_d')?.joined_at).toBe(
      '2026-09-01T00:00:00Z',
    );
  });

  it('contains no real account identifiers', () => {
    for (const account of cast.accounts) {
      expect(account.last4 === undefined || /^[0-9]{1,4}$/.test(account.last4)).toBe(true);
    }
  });
});

describe('fixtures/merchants.json', () => {
  it('covers every merchant description in the bank-statement fixture', () => {
    const fixture = loadMerchants();
    const aliasKeys = new Set(
      fixture.merchants.flatMap((merchant) => merchant.aliases.map(merchantAliasKey)),
    );

    // The five statement rows that name a merchant. The two self-transfers and the
    // person-to-person UPI row are deliberately absent: neither is a merchant, and
    // resolving them is not this phase's job.
    expect(aliasKeys).toContain(merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD'));
    expect(aliasKeys).toContain(merchantAliasKey('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD'));
    expect(aliasKeys).toContain(merchantAliasKey('ACH REFUND SAMPLE ELECTRONICS STORE'));
    expect(aliasKeys).toContain(merchantAliasKey('ELECTRICITY BOARD BBPS BILLPAY'));
    expect(aliasKeys).not.toContain(merchantAliasKey('NEFT TRANSFER TO SELF A/C X4821'));
    expect(aliasKeys).not.toContain(merchantAliasKey('UPI-FRIENDA-TRANSFER'));
  });

  it('gives every merchant a distinct id and every alias a distinct key', () => {
    const fixture = loadMerchants();
    const ids = fixture.merchants.map((merchant) => merchant.id);
    const aliasKeys = fixture.merchants.flatMap((merchant) =>
      merchant.aliases.map(merchantAliasKey),
    );

    // merchant_aliases.raw_pattern is UNIQUE — a duplicate here would fail at insert,
    // and would mean two merchants claiming one description.
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(aliasKeys).size).toBe(aliasKeys.length);
  });
});
