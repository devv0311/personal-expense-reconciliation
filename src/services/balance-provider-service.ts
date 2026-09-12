/**
 * Live bank and card balances: mapping accounts to a provider, reading them, and comparing
 * what came back to what the ledger already believes (audit row 37, ADR-0054).
 *
 * The shape of this service is the decision. Three things it does:
 *
 *  1. **Maps, without holding a credential.** `linkAccountToProvider` records which provider
 *     ref belongs to which of this ledger's accounts. The token is the adapter's, from the
 *     environment; nothing written here could carry one.
 *  2. **Reads, and records what it read *including the failures*.** Every linked account gets
 *     a row from every refresh — an `ok` one with a balance and an instant, or an `unavailable`
 *     one with a reason. An account that produced no row would be an account that looked fine.
 *  3. **Compares, and never concludes.** `compareBalanceReading` says agrees / differs /
 *     not comparable, with the staleness of the reading attached. Nothing here writes a
 *     boundary, moves a snapshot, or makes a delta `verified`.
 *
 * Point 3 is the one worth defending. A `verified` ₹0 unaccounted delta means complete
 * evidence, zero cash delta and zero unexplained movements (ADR-0017 (cash balance), 17.6). A
 * figure fetched from an API is not evidence of what a statement said at a period boundary,
 * and letting it fill one in would manufacture verified closures out of HTTP calls. The
 * comparison is offered beside the waterfall as a second opinion, labelled as one.
 */

import {
  assertBoundaryIsNotAProviderReading,
  classifyBalanceReading,
  compareBalanceReading,
  summarizeReadCompleteness,
} from '../domain/index.js';
import type {
  AccountId,
  AccountProviderLinkId,
  BalanceComparison,
  BalanceReadCompleteness,
  Paise,
} from '../domain/index.js';
import {
  archiveAccountProviderLink,
  getAccountById,
  getAccountProviderLink,
  insertAccountProviderLink,
  insertBalanceReadings,
  listAccountProviderLinks,
  listBalanceReadingsForAccount,
  listLatestBalanceReadings,
} from '../db/index.js';
import type { AccountBalanceReadingRow, AccountProviderLinkRow, Database } from '../db/index.js';
import type {
  BalanceProviderCapabilities,
  BalanceProviderPort,
} from '../integrations/balance-provider/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/** What a screen reads to say whether live balances are available here, and from what. */
export interface BalanceProviderStatus extends BalanceProviderCapabilities {
  readonly linkedAccountCount: number;
  /** Restated for the screen, so the rule is the API's rather than the UI's to remember. */
  readonly readingsAreNeverBoundaries: true;
}

export function describeBalanceProvider(
  provider: BalanceProviderPort,
): BalanceProviderCapabilities {
  return provider.describe();
}

export async function getBalanceProviderStatus(
  db: Database,
  provider: BalanceProviderPort,
): Promise<BalanceProviderStatus> {
  const links = await listAccountProviderLinks(db);
  return {
    ...provider.describe(),
    linkedAccountCount: links.length,
    readingsAreNeverBoundaries: true,
  };
}

export interface LinkAccountInput {
  readonly accountId: AccountId;
  readonly providerId: string;
  readonly externalAccountRef: string;
  readonly providerLabel?: string | null;
  readonly audit: AuditMeta;
}

/**
 * Maps one ledger account to one provider account.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` for an unknown or archived account.
 * @throws ServiceError `PRECONDITION_FAILED` when this account already has a live link for
 *   that provider, or the ref is already claimed by another account — either would make every
 *   later reading ambiguous about which account it describes.
 */
export async function linkAccountToProvider(
  db: Database,
  input: LinkAccountInput,
): Promise<AccountProviderLinkRow> {
  const account = await getAccountById(db, input.accountId);
  if (account === null || account.archivedAt !== null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No active account with id ${input.accountId}.`, {
      accountId: input.accountId,
    });
  }

  const existing = await listAccountProviderLinks(db);
  const sameAccount = existing.find(
    (link) => link.accountId === input.accountId && link.providerId === input.providerId,
  );
  if (sameAccount !== undefined) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `${account.name} is already linked to ${input.providerId} as ` +
        `"${sameAccount.externalAccountRef}". Unlink that first if the mapping was wrong — a ` +
        'second link would make every reading ambiguous about which one it answers.',
      { accountId: input.accountId },
    );
  }
  const sameRef = existing.find(
    (link) =>
      link.providerId === input.providerId && link.externalAccountRef === input.externalAccountRef,
  );
  if (sameRef !== undefined) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `"${input.externalAccountRef}" is already mapped to ${sameRef.accountName}. One remote ` +
        'account cannot be two of yours.',
      { accountId: input.accountId },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const linkId = await insertAccountProviderLink(exec, {
      accountId: input.accountId,
      providerId: input.providerId,
      externalAccountRef: input.externalAccountRef,
      providerLabel: input.providerLabel ?? null,
    });
    await record({
      entityType: 'account',
      entityId: input.accountId,
      action: 'update',
      newValue: {
        providerLink: {
          providerId: input.providerId,
          externalAccountRef: input.externalAccountRef,
        },
      },
      reason: input.audit.reason ?? null,
    });
    const link = await getAccountProviderLink(exec, linkId);
    if (link === null) throw new Error('The provider link vanished mid-transaction.');
    return link;
  });
}

export interface UnlinkAccountInput {
  readonly linkId: AccountProviderLinkId;
  readonly audit: AuditMeta;
}

/**
 * Stops asking a provider about an account.
 *
 * An archive, not a delete: past readings name this link, and a reading whose link had
 * vanished could no longer say which account it was about.
 */
export async function unlinkAccountFromProvider(
  db: Database,
  input: UnlinkAccountInput,
): Promise<void> {
  const link = await getAccountProviderLink(db, input.linkId);
  if (link === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No provider link with id ${input.linkId}.`, {
      linkId: input.linkId,
    });
  }
  if (link.archivedAt !== null) return;

  await runAudited(db, input.audit, async ({ exec, record }) => {
    await archiveAccountProviderLink(exec, input.linkId, new Date());
    await record({
      entityType: 'account',
      entityId: link.accountId,
      action: 'update',
      oldValue: {
        providerLink: {
          providerId: link.providerId,
          externalAccountRef: link.externalAccountRef,
        },
      },
      newValue: { providerLink: null },
      reason: input.audit.reason ?? null,
    });
  });
}

export interface RefreshBalancesResult {
  readonly provider: BalanceProviderCapabilities;
  readonly completeness: BalanceReadCompleteness;
  readonly readings: readonly AccountBalanceReadingRow[];
  readonly fetchedAt: string;
}

export interface RefreshBalancesInput {
  readonly provider: BalanceProviderPort;
  /** Narrow the refresh to specific accounts. Omitted: every live link. */
  readonly accountIds?: readonly AccountId[];
  readonly audit: AuditMeta;
}

/**
 * Asks the provider about every linked account and records what came back — including silence.
 *
 * An account that was asked about and not answered gets an `unavailable` reading saying so,
 * rather than no row. The difference matters on the next screen: a missing row reads as "we
 * have not looked recently", while an `unavailable` one reads as "we looked and could not see
 * it", and only one of those is true.
 *
 * Never throws for a provider-side failure. An unreachable provider produces a complete set of
 * `unavailable` readings and an incomplete read, which is the fact a person needs.
 */
export async function refreshAccountBalances(
  db: Database,
  input: RefreshBalancesInput,
): Promise<RefreshBalancesResult> {
  const capabilities = input.provider.describe();
  const allLinks = await listAccountProviderLinks(db);
  const links = allLinks.filter(
    (link) =>
      link.providerId === capabilities.providerId &&
      (input.accountIds === undefined || input.accountIds.includes(link.accountId)),
  );

  if (links.length === 0) {
    return {
      provider: capabilities,
      completeness: {
        requested: 0,
        answered: 0,
        complete: false,
        incompleteReason: capabilities.configured
          ? 'No account is linked to this provider yet, so nothing was read. That is not a ' +
            'statement about any account.'
          : (capabilities.unavailableReason ?? 'No balance provider is configured.'),
      },
      readings: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  const refs = links.map((link) => link.externalAccountRef);
  const result = await input.provider.fetchBalances({ externalAccountRefs: refs });
  const byRef = new Map(result.readings.map((reading) => [reading.externalAccountRef, reading]));
  const completeness = summarizeReadCompleteness(
    refs,
    result.readings.map((reading) => reading.externalAccountRef),
    result.complete,
    result.incompleteReason,
  );

  const fetchedAt = new Date();
  const drafts = links.map((link) => {
    const reading = byRef.get(link.externalAccountRef);
    if (reading === undefined) {
      return {
        accountId: link.accountId,
        accountProviderLinkId: link.id,
        providerId: capabilities.providerId,
        balance: null,
        currency: 'INR',
        asOf: null,
        fetchedAt,
        status: 'unavailable' as const,
        failureReason:
          result.incompleteReason ??
          'The provider did not answer for this account. Silence is not a balance.',
        readComplete: completeness.complete,
        readIncompleteReason: completeness.incompleteReason ?? null,
      };
    }
    return {
      accountId: link.accountId,
      accountProviderLinkId: link.id,
      providerId: capabilities.providerId,
      balance: reading.status === 'ok' ? reading.balance : null,
      currency: reading.currency,
      asOf: reading.status === 'ok' ? reading.asOf : null,
      fetchedAt,
      status: reading.status,
      failureReason:
        reading.status === 'ok'
          ? null
          : (reading.failureReason ?? 'The provider could not state a balance.'),
      readComplete: completeness.complete,
      readIncompleteReason: completeness.incompleteReason ?? null,
    };
  });

  await runAudited(db, input.audit, async ({ exec, record }) => {
    await insertBalanceReadings(exec, drafts);
    await record({
      entityType: 'account',
      entityId: links[0]!.accountId,
      action: 'create',
      newValue: {
        providerId: capabilities.providerId,
        accountsAsked: refs.length,
        accountsAnswered: completeness.answered,
        complete: completeness.complete,
        fetchedAt: fetchedAt.toISOString(),
      },
      reason:
        input.audit.reason ??
        'A live balance read. Readings are compared against the ledger and never written into ' +
          'a reconciliation boundary (ADR-0054).',
    });
  });

  return {
    provider: capabilities,
    completeness,
    readings: await listLatestBalanceReadings(
      db,
      links.map((link) => link.accountId),
    ),
    fetchedAt: fetchedAt.toISOString(),
  };
}

/** One account's latest reading, with what it says about a figure the ledger derived. */
export interface AccountBalanceComparison {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly reading: AccountBalanceReadingRow | null;
  /** `null` when this account has no provider link at all — a different fact from no reading. */
  readonly linked: boolean;
  readonly comparison: BalanceComparison | null;
  /** The ledger figure the comparison used, echoed so a screen never has to pick one. */
  readonly ledgerFigure: Paise | null;
}

export interface CompareBalancesInput {
  /** The ledger's own evidenced closing balance per account, from the run's snapshots. */
  readonly ledgerFigures: ReadonlyMap<AccountId, Paise | null>;
  /** The instant the comparison is against — a period end, usually. */
  readonly comparedTo: Date;
}

/**
 * Compares the latest reading for each account against a figure the ledger derived.
 *
 * A read. It writes nothing, and its output is never persisted onto a snapshot: a snapshot
 * records what the evidence said when the run happened, and a comparison made later against a
 * reading is a different kind of claim (ADR-0017 (cash balance), 17.7).
 */
export async function compareAccountBalances(
  db: Database,
  input: CompareBalancesInput,
): Promise<readonly AccountBalanceComparison[]> {
  const links = await listAccountProviderLinks(db);
  const linkedAccountIds = new Set(links.map((link) => link.accountId));
  const accountIds = [...new Set([...input.ledgerFigures.keys(), ...linkedAccountIds])];
  const readings = await listLatestBalanceReadings(db, accountIds);
  const readingByAccount = new Map(readings.map((reading) => [reading.accountId, reading]));

  const comparisons: AccountBalanceComparison[] = [];
  for (const accountId of accountIds) {
    const account = await getAccountById(db, accountId);
    const reading = readingByAccount.get(accountId) ?? null;
    const ledgerFigure = input.ledgerFigures.get(accountId) ?? null;
    comparisons.push({
      accountId,
      accountName: account?.name ?? 'Unknown account',
      reading,
      linked: linkedAccountIds.has(accountId),
      ledgerFigure,
      comparison:
        reading === null
          ? null
          : withReadCompleteness(
              reading,
              compareBalanceReading(
                {
                  balance: reading.balance,
                  asOf: reading.asOf,
                  fetchedAt: reading.fetchedAt,
                  status: reading.status,
                },
                ledgerFigure,
                input.comparedTo,
              ),
            ),
    });
  }
  return comparisons;
}

export async function listProviderLinks(db: Database): Promise<readonly AccountProviderLinkRow[]> {
  return listAccountProviderLinks(db);
}

export async function listAccountReadingHistory(
  db: Database,
  accountId: AccountId,
  limit?: number,
): Promise<readonly AccountBalanceReadingRow[]> {
  return listBalanceReadingsForAccount(db, accountId, limit);
}

/** Re-exported so a caller can state the rule without reaching past this layer. */
export { assertBoundaryIsNotAProviderReading, classifyBalanceReading };

/* ------------------------------------------------------------------------- internals */

/**
 * Carries the *read's* completeness into the comparison's caveat.
 *
 * A reading from a partial read can still be `ok` in itself — the provider answered for this
 * account — while the read as a whole missed others. Agreement on one account under a read
 * that could not see the rest is not agreement about the account set, and the caveat is where
 * that gets said.
 */
function withReadCompleteness(
  reading: AccountBalanceReadingRow,
  comparison: BalanceComparison,
): BalanceComparison {
  if (reading.readComplete) return comparison;
  const note =
    reading.readIncompleteReason ??
    'The read this reading came from was incomplete, so it says nothing about the accounts it ' +
      'did not answer for.';
  return {
    ...comparison,
    caveat: comparison.caveat === undefined ? note : `${comparison.caveat} ${note}`,
  };
}
