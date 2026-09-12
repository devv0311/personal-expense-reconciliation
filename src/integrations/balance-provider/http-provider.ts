/**
 * A concrete {@link BalanceProviderPort} over a configured HTTPS JSON endpoint.
 *
 * **What this is, said plainly.** No Indian retail bank offers a balance API to an individual
 * directly; the real paths are an Account Aggregator consent flow or a self-hosted bridge, and
 * both terminate in an HTTPS endpoint that speaks JSON. This adapter integrates with *that* —
 * a configured endpoint and a bearer token — rather than pretending to have integrated a
 * particular bank. `security-model.md` is explicit that a real connection is wired
 * deliberately and late, and this is the shape that keeps the wiring a configuration decision
 * instead of a code change.
 *
 * The request is a POST carrying the provider's own account refs:
 *
 * ```json
 * { "accountRefs": ["ref-1", "ref-2"] }
 * ```
 *
 * and the expected answer is:
 *
 * ```json
 * { "complete": true,
 *   "balances": [
 *     { "accountRef": "ref-1", "balanceMinorUnits": "1234500", "currency": "INR",
 *       "asOf": "2026-09-12T04:30:00Z" },
 *     { "accountRef": "ref-2", "error": "consent expired" }
 *   ] }
 * ```
 *
 * Three properties are enforced here rather than hoped for:
 *
 *  - **Money arrives as an exact minor-unit string.** A JSON `number` is a float, and this
 *    system does not have a field for "nearly ₹12,345" (`invariants.md` #12, ADR-0012). A
 *    balance that is not an exact integer string is refused as unavailable rather than rounded.
 *  - **A failure is a reading, not an exception.** An unreachable host, a 401, a timeout — each
 *    comes back as `complete: false` with a reason, because the caller's next step is the same
 *    either way (record the incomplete read, take no boundary from it) and an exception would
 *    make "we could not look" indistinguishable from a bug.
 *  - **Nothing is invented.** An entry with no `asOf` keeps `asOf: null` rather than being
 *    stamped with the fetch time, because "the provider did not say when" and "the provider
 *    said now" are different claims and only one of them is true.
 *
 * The token lives in this closure and appears in exactly one place: the `Authorization` header.
 * `describe()` names the host and never the credential.
 */

import { paise } from '../../domain/index.js';
import type { Paise } from '../../domain/index.js';

import type {
  AccountBalanceReading,
  BalanceProviderCapabilities,
  BalanceProviderPort,
  BalanceReadResult,
  FetchAccountBalancesInput,
} from './port.js';

export interface HttpBalanceProviderOptions {
  /** The endpoint to POST to. Never logged with its query string, never described with a token. */
  readonly endpointUrl: string;
  /** A bearer token for that endpoint. Never logged, never stored, never described. */
  readonly accessToken: string;
  /** A stable id recorded on every reading this provider produces. */
  readonly providerId?: string;
  readonly label?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createHttpBalanceProvider(
  options: HttpBalanceProviderOptions,
): BalanceProviderPort {
  const providerId = options.providerId ?? 'http-balance-provider';
  const label = options.label ?? 'Configured balance endpoint';
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    describe(): BalanceProviderCapabilities {
      const host = safeHost(options.endpointUrl);
      return {
        providerId,
        label,
        configured: true,
        ...(host === undefined ? {} : { endpointHost: host }),
      };
    },

    async fetchBalances(input: FetchAccountBalancesInput): Promise<BalanceReadResult> {
      if (input.externalAccountRefs.length === 0) {
        return { readings: [], complete: true };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let body: unknown;
      try {
        const response = await doFetch(options.endpointUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ accountRefs: input.externalAccountRefs }),
        });
        const text = await response.text().catch(() => '');
        if (!response.ok) {
          return incomplete(
            input.externalAccountRefs,
            `The balance provider returned ${response.status}. ${summarize(text)}`,
          );
        }
        body = JSON.parse(text) as unknown;
      } catch (error) {
        return incomplete(
          input.externalAccountRefs,
          controller.signal.aborted
            ? `The balance provider did not respond within ${timeoutMs}ms.`
            : `The balance provider could not be reached: ${
                error instanceof Error ? error.message : 'unknown network failure'
              }.`,
        );
      } finally {
        clearTimeout(timer);
      }

      const entries = arrayOf(body, 'balances');
      const readings: AccountBalanceReading[] = [];
      for (const entry of entries) {
        const ref = readString(entry, 'accountRef');
        if (ref === null) continue;
        readings.push(toReading(ref, entry));
      }

      const answered = new Set(readings.map((reading) => reading.externalAccountRef));
      const missing = input.externalAccountRefs.filter((ref) => !answered.has(ref));
      const providerComplete = readBoolean(body, 'complete') !== false;

      if (!providerComplete || missing.length > 0) {
        return {
          readings,
          complete: false,
          incompleteReason:
            missing.length > 0
              ? `${missing.length} of ${input.externalAccountRefs.length} accounts were not ` +
                'answered. Their absence is not a statement about their balances.'
              : (readString(body, 'incompleteReason') ??
                'The provider reported the read as incomplete without saying why.'),
        };
      }
      return { readings, complete: true };
    },
  };
}

/* ------------------------------------------------------------------------- internals */

function toReading(ref: string, entry: unknown): AccountBalanceReading {
  const failure = readString(entry, 'error');
  if (failure !== null) {
    return {
      externalAccountRef: ref,
      balance: null,
      currency: readString(entry, 'currency') ?? 'INR',
      asOf: null,
      status: 'unavailable',
      failureReason: summarize(failure),
    };
  }

  const raw = readString(entry, 'balanceMinorUnits');
  const balance = raw === null ? null : toPaise(raw);
  const asOf = readDate(entry, 'asOf');

  if (balance === null) {
    return {
      externalAccountRef: ref,
      balance: null,
      currency: readString(entry, 'currency') ?? 'INR',
      asOf,
      status: 'unavailable',
      failureReason:
        raw === null
          ? 'The provider answered for this account without a balance.'
          : `"${raw}" is not an exact count of minor units. A balance is never rounded into ` +
            'this ledger (invariants.md #12).',
    };
  }
  if (asOf === null) {
    // Deliberately not stamped with the fetch time: "the provider did not say when" and "the
    // provider said now" are different claims, and only one of them is true.
    return {
      externalAccountRef: ref,
      balance,
      currency: readString(entry, 'currency') ?? 'INR',
      asOf: null,
      status: 'unavailable',
      failureReason:
        'The provider gave a balance with no instant it was true at, so there is nothing to ' +
        'compare it to a period end with.',
    };
  }

  return {
    externalAccountRef: ref,
    balance,
    currency: readString(entry, 'currency') ?? 'INR',
    asOf,
    status: 'ok',
  };
}

/** Every requested account, unanswered, plus the reason. Never an empty success. */
function incomplete(refs: readonly string[], reason: string): BalanceReadResult {
  return {
    readings: [],
    complete: false,
    incompleteReason: `${reason} (asked about ${refs.length} accounts)`,
  };
}

/**
 * An exact minor-unit decimal string → `Paise`, or `null`.
 *
 * Signed, because an overdrawn account is a real balance (ADR-0017 (cash balance), 17.5).
 * String-validated rather than `Number`-parsed, because a float would round a large balance
 * silently.
 */
function toPaise(value: string): Paise | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return paise(BigInt(trimmed));
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Bounded: a provider's error text is recorded and shown, so it does not arrive unbounded. */
function summarize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
}

function arrayOf(body: unknown, key: string): unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' && found.length > 0 ? found : null;
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
