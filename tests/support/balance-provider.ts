/**
 * An in-memory {@link BalanceProviderPort}, scriptable per account ref.
 *
 * The same shape as `tests/support/splitwise.ts` and `tests/support/message-transport.ts`: the
 * real adapter has its own unit tests, and everything above the port is exercised without a
 * network call.
 *
 * `setBalance` scripts an `ok` reading, `setUnavailable` an account the provider could not
 * answer for, and `setPartial` a read that reports itself incomplete — the three states the
 * service and the screens above it have to tell apart.
 */

import { paise } from '../../src/domain/index.js';
import type {
  AccountBalanceReading,
  BalanceProviderCapabilities,
  BalanceProviderPort,
  BalanceReadResult,
  FetchAccountBalancesInput,
} from '../../src/integrations/balance-provider/index.js';

export interface MockBalanceProvider extends BalanceProviderPort {
  /** Every read this provider received, in order. */
  readonly reads: readonly FetchAccountBalancesInput[];
  setBalance(ref: string, minorUnits: bigint, asOf: Date): void;
  setUnavailable(ref: string, reason: string): void;
  /** Makes the whole read report itself partial, whatever the per-account answers say. */
  setPartial(reason: string | null): void;
  /** Drops an account from the answer entirely — the "silence" case. */
  omit(ref: string): void;
}

export function createMockBalanceProvider(
  overrides: Partial<BalanceProviderCapabilities> = {},
): MockBalanceProvider {
  const reads: FetchAccountBalancesInput[] = [];
  const answers = new Map<string, AccountBalanceReading>();
  const omitted = new Set<string>();
  let partialReason: string | null = null;
  let partial = false;

  return {
    reads,
    setBalance(ref, minorUnits, asOf) {
      omitted.delete(ref);
      answers.set(ref, {
        externalAccountRef: ref,
        balance: paise(minorUnits),
        currency: 'INR',
        asOf,
        status: 'ok',
      });
    },
    setUnavailable(ref, reason) {
      omitted.delete(ref);
      answers.set(ref, {
        externalAccountRef: ref,
        balance: null,
        currency: 'INR',
        asOf: null,
        status: 'unavailable',
        failureReason: reason,
      });
    },
    setPartial(reason) {
      partial = true;
      partialReason = reason;
    },
    omit(ref) {
      omitted.add(ref);
      answers.delete(ref);
    },
    describe(): BalanceProviderCapabilities {
      return {
        providerId: 'mock-provider',
        label: 'Mock balance provider',
        configured: true,
        endpointHost: 'balances.invalid',
        ...overrides,
      };
    },
    fetchBalances(input: FetchAccountBalancesInput): Promise<BalanceReadResult> {
      reads.push(input);
      const readings = input.externalAccountRefs
        .filter((ref) => !omitted.has(ref))
        .map((ref) => answers.get(ref))
        .filter((reading): reading is AccountBalanceReading => reading !== undefined);
      return Promise.resolve({
        readings,
        complete: !partial,
        ...(partial && partialReason !== null ? { incompleteReason: partialReason } : {}),
      });
    },
  };
}
