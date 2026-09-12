/**
 * Data access for `account_provider_links` and `account_balance_readings` (audit row 37).
 *
 * Two shapes worth naming:
 *
 *  - **A link is archived, never deleted.** Past readings reference it, and a reading whose
 *    link had vanished could no longer say which account it was about.
 *  - **`listLatestBalanceReadings` returns one row per account**, chosen by `fetched_at`. Not
 *    by `as_of`: a provider that re-reports a stale instant would otherwise be able to make an
 *    older read look like the current one.
 */

import { desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { AccountId, AccountBalanceReadingId, AccountProviderLinkId } from '../domain/ids.js';
import type { Paise } from '../domain/money.js';

import type { Executor } from './repositories.js';
import { accountBalanceReadings, accountProviderLinks, accounts } from './schema.js';

export interface AccountProviderLinkRow {
  readonly id: AccountProviderLinkId;
  readonly accountId: AccountId;
  readonly providerId: string;
  readonly externalAccountRef: string;
  readonly providerLabel: string | null;
  readonly linkedAt: Date;
  readonly archivedAt: Date | null;
  /** The ledger's own name for the account, so a screen never has to join for it. */
  readonly accountName: string;
  readonly accountType: string;
  readonly accountLast4: string | null;
}

export interface AccountBalanceReadingRow {
  readonly id: AccountBalanceReadingId;
  readonly accountId: AccountId;
  readonly accountProviderLinkId: AccountProviderLinkId;
  readonly providerId: string;
  readonly balance: Paise | null;
  readonly currency: string;
  readonly asOf: Date | null;
  readonly fetchedAt: Date;
  readonly status: 'ok' | 'unavailable';
  readonly failureReason: string | null;
  readonly readComplete: boolean;
  readonly readIncompleteReason: string | null;
}

export async function insertAccountProviderLink(
  exec: Executor,
  draft: {
    readonly accountId: AccountId;
    readonly providerId: string;
    readonly externalAccountRef: string;
    readonly providerLabel?: string | null;
  },
): Promise<AccountProviderLinkId> {
  const [row] = await exec
    .insert(accountProviderLinks)
    .values({
      accountId: draft.accountId,
      providerId: draft.providerId,
      externalAccountRef: draft.externalAccountRef,
      providerLabel: draft.providerLabel ?? null,
    })
    .returning({ id: accountProviderLinks.id });
  if (row === undefined) throw new Error('Insert into account_provider_links returned no row.');
  return row.id as AccountProviderLinkId;
}

export async function archiveAccountProviderLink(
  exec: Executor,
  linkId: AccountProviderLinkId,
  at: Date,
): Promise<void> {
  await exec
    .update(accountProviderLinks)
    .set({ archivedAt: at })
    .where(eq(accountProviderLinks.id, linkId));
}

export async function getAccountProviderLink(
  exec: Executor,
  linkId: AccountProviderLinkId,
): Promise<AccountProviderLinkRow | null> {
  const rows = await selectLinks(exec, eq(accountProviderLinks.id, linkId));
  return rows[0] ?? null;
}

/** Every live link, with the ledger account each one names. */
export async function listAccountProviderLinks(
  exec: Executor,
  filter: { readonly includeArchived?: boolean } = {},
): Promise<readonly AccountProviderLinkRow[]> {
  return selectLinks(
    exec,
    filter.includeArchived === true ? undefined : isNull(accountProviderLinks.archivedAt),
  );
}

export async function insertBalanceReadings(
  exec: Executor,
  drafts: readonly {
    readonly accountId: AccountId;
    readonly accountProviderLinkId: AccountProviderLinkId;
    readonly providerId: string;
    readonly balance: Paise | null;
    readonly currency: string;
    readonly asOf: Date | null;
    readonly fetchedAt: Date;
    readonly status: 'ok' | 'unavailable';
    readonly failureReason: string | null;
    readonly readComplete: boolean;
    readonly readIncompleteReason: string | null;
  }[],
): Promise<readonly AccountBalanceReadingId[]> {
  if (drafts.length === 0) return [];
  const rows = await exec
    .insert(accountBalanceReadings)
    .values(drafts.map((draft) => ({ ...draft })))
    .returning({ id: accountBalanceReadings.id });
  return rows.map((row) => row.id as AccountBalanceReadingId);
}

/**
 * The most recent reading per account, by `fetched_at`.
 *
 * `DISTINCT ON` rather than a window function: one row per account is exactly what the screen
 * needs, and a `GROUP BY` would lose every column that is not aggregated.
 */
export async function listLatestBalanceReadings(
  exec: Executor,
  accountIds?: readonly AccountId[],
): Promise<readonly AccountBalanceReadingRow[]> {
  if (accountIds !== undefined && accountIds.length === 0) return [];
  const rows = await exec
    .selectDistinctOn([accountBalanceReadings.accountId])
    .from(accountBalanceReadings)
    .where(
      accountIds === undefined
        ? undefined
        : inArray(accountBalanceReadings.accountId, [...accountIds]),
    )
    .orderBy(accountBalanceReadings.accountId, desc(accountBalanceReadings.fetchedAt));
  return rows.map(toReadingRow);
}

/** One account's reading history, newest first. */
export async function listBalanceReadingsForAccount(
  exec: Executor,
  accountId: AccountId,
  limit = 20,
): Promise<readonly AccountBalanceReadingRow[]> {
  const rows = await exec
    .select()
    .from(accountBalanceReadings)
    .where(eq(accountBalanceReadings.accountId, accountId))
    .orderBy(desc(accountBalanceReadings.fetchedAt))
    .limit(limit);
  return rows.map(toReadingRow);
}

/* ------------------------------------------------------------------------- internals */

async function selectLinks(
  exec: Executor,
  where: ReturnType<typeof eq> | undefined,
): Promise<AccountProviderLinkRow[]> {
  const query = exec
    .select({
      link: accountProviderLinks,
      accountName: accounts.name,
      accountType: accounts.type,
      accountLast4: accounts.last4,
    })
    .from(accountProviderLinks)
    .innerJoin(accounts, eq(accounts.id, accountProviderLinks.accountId));
  const rows = await (where === undefined ? query : query.where(where)).orderBy(
    sql`${accounts.name} asc`,
  );
  return rows.map((row) => ({
    id: row.link.id as AccountProviderLinkId,
    accountId: row.link.accountId as AccountId,
    providerId: row.link.providerId,
    externalAccountRef: row.link.externalAccountRef,
    providerLabel: row.link.providerLabel,
    linkedAt: row.link.linkedAt,
    archivedAt: row.link.archivedAt,
    accountName: row.accountName,
    accountType: row.accountType,
    accountLast4: row.accountLast4,
  }));
}

function toReadingRow(row: typeof accountBalanceReadings.$inferSelect): AccountBalanceReadingRow {
  return {
    id: row.id as AccountBalanceReadingId,
    accountId: row.accountId as AccountId,
    accountProviderLinkId: row.accountProviderLinkId as AccountProviderLinkId,
    providerId: row.providerId,
    balance: row.balance as Paise | null,
    currency: row.currency,
    asOf: row.asOf,
    fetchedAt: row.fetchedAt,
    status: row.status as 'ok' | 'unavailable',
    failureReason: row.failureReason,
    readComplete: row.readComplete,
    readIncompleteReason: row.readIncompleteReason,
  };
}
