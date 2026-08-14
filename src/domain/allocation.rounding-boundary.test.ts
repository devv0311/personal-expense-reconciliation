import { describe, expect, it, vi } from 'vitest';

import type * as RoundingModule from './rounding.js';

/**
 * Rounding matrix case 6: item/quantity-based allocation must **not** invoke the Largest
 * Remainder Method at all (`docs/testing/testing-strategy.md`; `invariants.md` #12,
 * "Where it explicitly does not apply"). Running it there would silently overwrite an
 * already-exact, receipt-sourced `ExpenseItem.amount`.
 *
 * This is a structural claim about which code path runs, not about a returned value, so
 * it is the one allocation test that needs a spy — kept in its own file so
 * `allocation.test.ts` stays mock-free, per `src/domain/README.md`.
 */
vi.mock('./rounding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RoundingModule>();
  return { ...actual, splitByLargestRemainder: vi.fn(actual.splitByLargestRemainder) };
});

const { buildAllocationLines } = await import('./allocation.js');
const { splitByLargestRemainder } = await import('./rounding.js');
const { asId } = await import('./ids.js');
const { paise } = await import('./money.js');

const spied = vi.mocked(splitByLargestRemainder);

const dev = asId<'person'>('person_dev');
const flat = asId<'group'>('group_flat');
const cheapItem = asId<'expense_item'>('item_milk');
const priceyItem = asId<'expense_item'>('item_chicken');

describe('matrix case 6: item-based allocation bypasses the rounding algorithm', () => {
  it('never calls splitByLargestRemainder for item_based lines', () => {
    spied.mockClear();

    const lines = buildAllocationLines({
      method: 'item_based',
      lines: [
        { beneficiary: { type: 'group', id: flat }, expenseItemId: cheapItem },
        { beneficiary: { type: 'person', id: dev }, expenseItemId: priceyItem },
      ],
      items: [
        { id: cheapItem, amount: paise(8000n) },
        { id: priceyItem, amount: paise(116000n) },
      ],
    });

    expect(spied).not.toHaveBeenCalled();
    // ...and the amounts are the items' own, copied verbatim.
    expect(lines.map((line) => line.amount)).toEqual([8000n, 116000n]);
  });

  it('never calls splitByLargestRemainder for quantity_based lines', () => {
    spied.mockClear();

    buildAllocationLines({
      method: 'quantity_based',
      lines: [{ beneficiary: { type: 'person', id: dev }, expenseItemId: cheapItem }],
      items: [{ id: cheapItem, amount: paise(8000n) }],
    });

    expect(spied).not.toHaveBeenCalled();
  });

  it('does call it for an equal split, proving the spy is wired to the real call site', () => {
    spied.mockClear();

    buildAllocationLines({
      method: 'equal',
      total: paise(90000n),
      beneficiaries: [{ type: 'person', id: dev }],
    });

    expect(spied).toHaveBeenCalledTimes(1);
  });
});
