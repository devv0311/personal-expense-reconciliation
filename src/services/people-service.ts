/**
 * The people roster — a read `web/` needs (names, Splitwise linkage, who "the user" is) that no
 * phase before 15 exposed over HTTP, because no phase before 15 had a UI rendering anything
 * other than a raw id. `db.listPeople` and `db.getPrimaryUserPerson` are both unchanged,
 * foundation-pass reads; this is their first `src/api` caller (`docs/roadmap.md` phase 15).
 */

import {
  getPersonById,
  getPrimaryUserPerson,
  listExpensePaymentIds,
  listPeople as dbListPeople,
} from '../db/index.js';
import type { Executor } from '../db/index.js';
import type {
  ExpenseId,
  ObligationEvidenceStatus,
  Paise,
  PaymentId,
  PersonId,
} from '../domain/index.js';

import { getBalance } from './balance-service.js';
import { ServiceError } from './errors.js';
import { getExpenseLedgerRow } from './expense-ledger-service.js';

export interface PersonSummary {
  readonly id: PersonId;
  readonly displayName: string;
  readonly splitwiseUserId: string | null;
  /** True for the single `Person` a `User` maps to (`domain-model.md`). */
  readonly isUser: boolean;
}

/** Everyone not archived, oldest first, each flagged with whether they're the ledger's user. */
export async function listPeople(db: Executor): Promise<readonly PersonSummary[]> {
  const [people, userPerson] = await Promise.all([dbListPeople(db), getPrimaryUserPerson(db)]);
  return people.map((person) => ({
    id: person.id,
    displayName: person.displayName,
    splitwiseUserId: person.splitwiseUserId,
    isUser: person.id === userPerson?.personId,
  }));
}

/* ================================================ one person, and why the balance is what it is */

/** One shared expense behind a balance, said as a sentence rather than as an id. */
export interface PersonContribution {
  readonly expenseId: ExpenseId;
  readonly whatItWas: string | null;
  readonly occurredAt: Date;
  /** What this expense adds to the balance, always positive; `direction` says which way. */
  readonly amount: Paise;
  /** `collect` when they owe the user for it, `pay` when the user owes them. */
  readonly direction: 'collect' | 'pay';
  readonly paidByName: string;
  readonly paidByIsYou: boolean;
  /** The payment that funded it, when one did — so a row can open the whole event. */
  readonly paymentId: PaymentId | null;
}

/** One repayment already netted into the balance. */
export interface PersonSettlement {
  readonly settlementId: string;
  readonly paymentId: PaymentId;
  readonly amount: Paise;
  readonly occurredAt: Date;
  /** 'You paid them back' / 'They paid you back'. */
  readonly label: string;
  readonly reason: string | null;
}

export interface PersonBalanceSummary {
  readonly personId: PersonId;
  readonly displayName: string;
  /** Always positive. `direction` says who owes whom; `settled` when it is zero. */
  readonly amount: Paise;
  readonly direction: 'collect' | 'pay' | 'settled';
  /**
   * Whether the ledger has evidence a cleared debt was actually cleared.
   *
   * Carried so a screen can say "believed settled, and this ledger has no settlement for it"
   * rather than presenting a zero as proof (ADR-0014, `invariants.md` #9b).
   */
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly contributions: readonly PersonContribution[];
  readonly settlements: readonly PersonSettlement[];
  /**
   * Expenses whose refund is recorded but has not reached the current allocation.
   *
   * A caveat, never a correction: the figure above is exactly what the allocations say, and
   * these are about to move it (audit row 25).
   */
  readonly pendingRefundExpenseIds: readonly ExpenseId[];
}

/**
 * Everything one person's balance is made of, in plain terms.
 *
 * `getBalance` already computes the figure, the obligations behind it, the repayments netted
 * into it and its evidence status — for **any** two people, in either direction, with no
 * assumption that the user is the creditor (ADR-0006). What it returns are expense ids, which
 * is the right answer for a service and an unreadable one for a person, so this joins the
 * descriptions, dates, payers and funding payments a sentence needs and states the direction
 * in the reader's own words.
 *
 * No arithmetic of its own. The figure, the signs and the netting are all `getBalance`'s.
 */
export async function getPersonBalanceSummary(
  db: Executor,
  input: { readonly userPersonId: PersonId; readonly personId: PersonId },
): Promise<PersonBalanceSummary> {
  const person = await getPersonById(db, input.personId);
  if (person === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { personId: input.personId });
  }

  // `netBalance` is signed A→B: positive means A owes B. Asking with the user as A makes a
  // positive figure "you owe them", so the direction below reads it that way round once.
  const balance = await getBalance(db, input.userPersonId, input.userPersonId, input.personId);
  const owedByUser = balance.netBalance > 0n;
  const amount = (balance.netBalance < 0n ? 0n - balance.netBalance : balance.netBalance) as Paise;

  const people = await dbListPeople(db);
  const names = new Map<string, string>(
    people.map((entry): [string, string] => [entry.id, entry.displayName]),
  );
  const nameFor = (id: string): string => names.get(id) ?? 'Somebody not on the roster';

  const expenseIds = [...new Set(balance.contributions.map((entry) => entry.expenseId))];
  const rows = await Promise.all(expenseIds.map((id) => getExpenseLedgerRow(db, id)));
  const byId = new Map(
    rows.filter((row): row is NonNullable<typeof row> => row !== null).map((row) => [row.id, row]),
  );
  const funding = await Promise.all(
    expenseIds.map(async (id) => [id, await listExpensePaymentIds(db, id)] as const),
  );
  const fundedBy = new Map(funding);

  const contributions: PersonContribution[] = balance.contributions.map((entry) => {
    const row = byId.get(entry.expenseId);
    const payerId = row?.paidByPersonId ?? null;
    return {
      expenseId: entry.expenseId,
      whatItWas: row?.description ?? null,
      occurredAt: row?.occurredAt ?? new Date(0),
      amount: entry.amount,
      // The debtor is who owes. When that is the user, the user pays; otherwise they collect.
      direction: entry.debtorId === input.userPersonId ? 'pay' : 'collect',
      paidByName: payerId === null ? 'Somebody not on the roster' : nameFor(payerId),
      paidByIsYou: payerId === input.userPersonId,
      // The first payment that funded it, so a row can open the whole event. An expense
      // somebody else paid has none, and `null` is the honest answer there (ADR-0006).
      paymentId: fundedBy.get(entry.expenseId)?.[0] ?? null,
    };
  });

  return {
    personId: input.personId,
    displayName: person.displayName,
    amount,
    direction: balance.netBalance === 0n ? 'settled' : owedByUser ? 'pay' : 'collect',
    evidenceStatus: balance.evidenceStatus,
    contributions,
    settlements: balance.settlements.map((line) => ({
      settlementId: line.settlementId,
      paymentId: line.paymentId,
      amount: line.amount,
      occurredAt: line.occurredAt,
      label:
        line.fromPersonId === input.userPersonId
          ? `You paid ${person.displayName} back`
          : `${person.displayName} paid you back`,
      reason: line.reason,
    })),
    pendingRefundExpenseIds: balance.pendingRefundExpenseIds,
  };
}
