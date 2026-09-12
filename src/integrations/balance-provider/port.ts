/**
 * The balance-provider port: what a live account balance looks like to this ledger, and what
 * it deliberately is not.
 *
 * The audit's row 37: *"Absent external account/balance adapters … the waterfall compares
 * user-supplied evidenced statement boundaries; it does not fetch current bank balances."*
 * This is the seam a real one plugs into.
 *
 * Three rules the port's shape enforces rather than asks for:
 *
 *  - **A read reports its own completeness.** `BalanceReadResult` carries a per-account
 *    status, and `failed`/`unsupported` are values rather than exceptions, because a bank that
 *    could not be reached is a fact about the read and not a crash. ADR-0046's rule,
 *    generalised: *an absence of disagreement under an incomplete check is not agreement.*
 *  - **A balance carries the instant it was true.** `asOf` is the provider's own timestamp,
 *    separate from `fetchedAt`. A balance from six hours ago compared against a period ending
 *    yesterday is a stale read, and the only way to know that is to keep both.
 *  - **Nothing here is authoritative.** A reading is evidence of what a provider said, exactly
 *    like a statement PDF. It is compared against the ledger's own arithmetic; it never
 *    overwrites it, and it can never make a `verified` ₹0 delta on its own (ADR-0017, 17.6).
 *
 * Credentials never cross this port. They are the adapter's, held in the closure that
 * `src/server.ts` builds from the environment, and no field on any type here can carry one.
 */

import type { Paise } from '../../domain/index.js';

/** What one provider read said about one account. */
export interface AccountBalanceReading {
  /** The provider's identifier for the account — never a full account number. */
  readonly externalAccountRef: string;
  /**
   * The balance, or `null` when the provider could not state one.
   *
   * Signed: an overdrawn account is a real balance. `null` is not zero, and nothing
   * downstream may treat it as such (ADR-0017, 17.5).
   */
  readonly balance: Paise | null;
  readonly currency: string;
  /** The instant the provider says the balance was true. `null` when it does not say. */
  readonly asOf: Date | null;
  /** `ok` only when a balance and an `asOf` both came back. */
  readonly status: 'ok' | 'unavailable';
  /** Why the account could not be read, when it could not. */
  readonly failureReason?: string;
}

export interface BalanceReadResult {
  readonly readings: readonly AccountBalanceReading[];
  /**
   * Whether every account asked about was answered.
   *
   * `false` makes this a **partial** read: an account absent from `readings` proves nothing,
   * and no boundary may be taken from the silence.
   */
  readonly complete: boolean;
  readonly incompleteReason?: string;
}

/** What a provider is and what it can do, for a screen to say before anyone relies on it. */
export interface BalanceProviderCapabilities {
  /** A stable id recorded on every reading, so a figure can be traced to what produced it. */
  readonly providerId: string;
  readonly label: string;
  readonly configured: boolean;
  /** Why it is unconfigured, when it is. Names the environment variables, never their values. */
  readonly unavailableReason?: string;
  /** The host the adapter talks to. Never a URL carrying a token. */
  readonly endpointHost?: string;
}

export interface FetchAccountBalancesInput {
  /** The provider's own refs for the accounts to read, from `account_provider_links`. */
  readonly externalAccountRefs: readonly string[];
}

export interface BalanceProviderPort {
  describe(): BalanceProviderCapabilities;
  /**
   * Reads the current balances.
   *
   * @throws never for a provider-side failure — an unreachable bank comes back as a reading
   *   with `status: 'unavailable'` or as `complete: false`, because the caller's next step is
   *   the same either way (record the incomplete read, do not take a boundary from it) and a
   *   thrown error would make "we could not look" indistinguishable from a bug.
   */
  fetchBalances(input: FetchAccountBalancesInput): Promise<BalanceReadResult>;
}
