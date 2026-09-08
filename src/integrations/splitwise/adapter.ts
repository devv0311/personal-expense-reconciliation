/**
 * A concrete {@link SplitwisePort} over Splitwise's v3 REST API.
 *
 * ADR-0040 deferred this until a phase needed it, and named exactly what it must not become:
 * a path by which Splitwise's numbers become authoritative. That line holds here.
 *
 *  - **Reads are compared, never trusted.** `fetchBalances` and `fetchLedgerEntries` return
 *    what Splitwise says. `services.runReconciliation` and `domain.auditSplitwisePair` compare
 *    it against this ledger's own figures; disagreement becomes a discrepancy or a finding,
 *    and never a correction to the local ledger.
 *  - **Writes are first-sync only.** `createExpense` and `recordPayment` push a decision a
 *    person already approved locally. Nothing here updates or deletes a remote row — stale
 *    re-sync is still unbuilt and is still its own deliberate decision (ADR-0040, ADR-0046).
 *  - **A failure is a failure, never agreement.** Every method throws rather than resolving
 *    empty. An adapter that answered "no balances" when it could not reach Splitwise would
 *    make an unreadable account look like a reconciled one, which is the single worst thing
 *    this module could do.
 *
 * `fetchLedgerEntries` **is** implemented here, so an audit against a real account gets
 * per-record attribution rather than aggregate-only findings. It reports `complete: false`
 * when it stops at the page cap rather than pretending it saw everything — under a partial
 * read the audit will not call anything missing.
 *
 * No SDK dependency, for the same reason the Anthropic transport has none: this is a handful
 * of JSON calls behind an interface the rest of the system already speaks.
 */

import { paise } from '../../domain/index.js';
import type { Paise } from '../../domain/index.js';

import type {
  CreateSplitwiseExpenseInput,
  CreateSplitwiseExpenseResult,
  FetchSplitwiseLedgerEntriesInput,
  FetchSplitwiseLedgerEntriesResult,
  RecordSplitwisePaymentInput,
  RecordSplitwisePaymentResult,
  SplitwiseFriendBalance,
  SplitwiseLedgerEntry,
  SplitwisePort,
} from './port.js';

const SPLITWISE_API_BASE = 'https://secure.splitwise.com/api/v3.0';

/** How many entries one `fetchLedgerEntries` call will read before reporting a partial read. */
const MAX_LEDGER_ENTRIES = 500;

export interface SplitwiseAdapterOptions {
  /** A Splitwise API key or OAuth access token. Never logged, never stored by this module. */
  readonly apiKey: string;
  /** `people.splitwise_user_id` of the account this key authenticates as. */
  readonly connectedSplitwiseUserId: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Raised when Splitwise itself fails. Distinct from a disagreement about the numbers. */
export class SplitwiseTransportError extends Error {
  public readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SplitwiseTransportError';
    this.status = status;
  }
}

export function createSplitwiseAdapter(options: SplitwiseAdapterOptions): SplitwisePort {
  const baseUrl = options.baseUrl ?? SPLITWISE_API_BASE;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? `no response within ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : 'unknown network failure';
      throw new SplitwiseTransportError(`Splitwise could not be reached: ${reason}.`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new SplitwiseTransportError(
        `Splitwise returned ${response.status}. ${detail}`,
        response.status,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (body === null) {
      throw new SplitwiseTransportError('Splitwise returned a body that is not JSON.');
    }
    // Splitwise reports some failures with a 200 and an `errors` object. Treating that as
    // success would be exactly the "silently trust an external answer" failure ADR-0046 names.
    const errors = (body as { errors?: unknown }).errors;
    if (typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0) {
      throw new SplitwiseTransportError(`Splitwise reported: ${JSON.stringify(errors)}`);
    }
    return body;
  }

  return {
    async createExpense(input: CreateSplitwiseExpenseInput): Promise<CreateSplitwiseExpenseResult> {
      // Splitwise's own wire format is major units as a decimal string. This is the only place
      // in the system that converts, and it does so exactly: paise divided by 100 with the
      // remainder kept as the two decimal places, never a float (`invariants.md` #12).
      const users = input.shares.map((share, index) => ({
        [`users__${index}__user_id`]: Number(share.splitwiseUserId),
        [`users__${index}__owed_share`]: toMajorUnits(share.owedAmount),
        [`users__${index}__paid_share`]:
          share.splitwiseUserId === input.paidBySplitwiseUserId
            ? toMajorUnits(input.amount)
            : '0.00',
      }));

      const body = await call('/create_expense', {
        method: 'POST',
        body: JSON.stringify({
          cost: toMajorUnits(input.amount),
          description: input.description ?? 'Expense',
          currency_code: input.currency,
          split_equally: false,
          ...Object.assign({}, ...users),
        }),
      });

      const created = firstOf(body, 'expenses');
      const id = readId(created);
      if (id === null) {
        throw new SplitwiseTransportError(
          'Splitwise accepted the expense but returned no id for it. Nothing was recorded ' +
            'locally: without their id there is no way to audit this row against theirs later.',
        );
      }
      return { splitwiseExpenseId: id, theirSnapshot: created };
    },

    async recordPayment(input: RecordSplitwisePaymentInput): Promise<RecordSplitwisePaymentResult> {
      const body = await call('/create_expense', {
        method: 'POST',
        body: JSON.stringify({
          payment: true,
          cost: toMajorUnits(input.amount),
          description: 'Settlement',
          users__0__user_id: Number(input.fromSplitwiseUserId),
          users__0__paid_share: toMajorUnits(input.amount),
          users__0__owed_share: '0.00',
          users__1__user_id: Number(input.toSplitwiseUserId),
          users__1__paid_share: '0.00',
          users__1__owed_share: toMajorUnits(input.amount),
        }),
      });

      const created = firstOf(body, 'expenses');
      const id = readId(created);
      if (id === null) {
        throw new SplitwiseTransportError(
          'Splitwise accepted the settlement but returned no id for it.',
        );
      }
      return { splitwiseTransactionId: id, theirSnapshot: created };
    },

    async fetchBalances(): Promise<readonly SplitwiseFriendBalance[]> {
      const body = await call('/get_friends');
      const friends = arrayOf(body, 'friends');
      const balances: SplitwiseFriendBalance[] = [];
      for (const friend of friends) {
        const id = readId(friend);
        if (id === null) continue;
        // Splitwise reports a friend's balance per currency. INR is the only currency this
        // system does arithmetic in (ADR-0012), so anything else is skipped rather than
        // summed into a figure that would silently mix currencies.
        const entries = arrayOf(friend, 'balance').filter(
          (entry) => readString(entry, 'currency_code') === 'INR',
        );
        const total = entries.reduce<bigint>(
          (sum, entry) => sum + toPaise(readString(entry, 'amount') ?? '0'),
          0n,
        );
        // Splitwise's sign is "what the friend owes the connected account"; ours is the
        // opposite ("positive means the connected account owes this friend"), so it flips here
        // — once, in the one place that knows their convention.
        balances.push({ splitwiseUserId: id, netBalance: paise(-total) });
      }
      return balances;
    },

    async fetchLedgerEntries(
      input: FetchSplitwiseLedgerEntriesInput,
    ): Promise<FetchSplitwiseLedgerEntriesResult> {
      const body = await call(
        `/get_expenses?friend_id=${encodeURIComponent(input.friendSplitwiseUserId)}` +
          `&limit=${MAX_LEDGER_ENTRIES}`,
      );
      const rows = arrayOf(body, 'expenses');
      const entries: SplitwiseLedgerEntry[] = [];

      for (const row of rows) {
        const id = readId(row);
        if (id === null) continue;
        const currency = readString(row, 'currency_code') ?? 'INR';
        const users = arrayOf(row, 'users');

        // This entry's contribution to the pair balance: what the connected account is owed by
        // the friend, expressed in our sign convention. `net_balance` per user is Splitwise's
        // own per-entry figure, so this is their arithmetic read back, not ours re-derived.
        const friendNet = users
          .filter((user) => {
            const nested = (user as { user?: unknown }).user;
            return readId(nested) === input.friendSplitwiseUserId;
          })
          .reduce<bigint>((sum, user) => sum + toPaise(readString(user, 'net_balance') ?? '0'), 0n);

        entries.push({
          splitwiseEntryId: id,
          kind: readBoolean(row, 'payment') === true ? 'payment' : 'expense',
          description: readString(row, 'description'),
          totalAmount: paise(absolute(toPaise(readString(row, 'cost') ?? '0'))),
          currency,
          deleted: readString(row, 'deleted_at') !== null,
          occurredAt: readDate(row, 'date') ?? readDate(row, 'created_at'),
          pairNetBalance: paise(-friendNet),
        });
      }

      // Honest about its own limits: at the cap, this is a page rather than the whole pair,
      // and the audit must not read an absence in it as "Splitwise does not have that row".
      const complete = rows.length < MAX_LEDGER_ENTRIES;
      return {
        entries,
        complete,
        ...(complete
          ? {}
          : {
              incompleteReason:
                `Read stopped at ${MAX_LEDGER_ENTRIES} entries, which is a page rather than ` +
                'the whole pair. Nothing absent from this listing can be reported as missing.',
            }),
      };
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/** Paise → Splitwise's major-unit decimal string. Exact: no float ever appears. */
function toMajorUnits(amount: Paise): string {
  const value: bigint = amount;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rupees = magnitude / 100n;
  const remainder = magnitude % 100n;
  return `${negative ? '-' : ''}${rupees}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Splitwise's major-unit decimal string → paise, exactly.
 *
 * String arithmetic on purpose: `Number('1234.56') * 100` is `123455.99999999999`, and this
 * system does not have a field for "nearly ₹1,234.56" (`invariants.md` #12, ADR-0012).
 */
function toPaise(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return 0n;
  const sign = match[1] === '-' ? -1n : 1n;
  const rupees = BigInt(match[2]!);
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  return sign * (rupees * 100n + fraction);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function arrayOf(body: unknown, key: string): unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function firstOf(body: unknown, key: string): unknown {
  return arrayOf(body, key)[0] ?? null;
}

function readId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  if (typeof id === 'number') return String(id);
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  if (typeof found === 'string') return found;
  return typeof found === 'number' ? String(found) : null;
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'boolean' ? found : null;
}

function readDate(value: unknown, key: string): Date | null {
  const raw = readString(value, key);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
