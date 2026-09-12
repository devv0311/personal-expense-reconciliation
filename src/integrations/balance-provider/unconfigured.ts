/**
 * The balance provider when nothing is configured.
 *
 * It answers every read as **incomplete**, which is the only honest answer and the important
 * one. The alternative — resolving `{ readings: [], complete: true }` — would say "we checked
 * every account and there was nothing to report", and a screen reading that would be entitled
 * to show agreement. ADR-0046's rule, generalised: an absence of disagreement under a check
 * that did not happen is not agreement.
 *
 * `describe()` is what the reconciliation and setup screens read to say, before anybody links
 * an account, that live balances are unavailable here and exactly which variables would make
 * them available. It names the variables and never their values.
 */

import type {
  BalanceProviderCapabilities,
  BalanceProviderPort,
  BalanceReadResult,
} from './port.js';

export const BALANCE_PROVIDER_UNCONFIGURED_REASON =
  'No balance provider is configured. Set BALANCE_PROVIDER_URL and BALANCE_PROVIDER_TOKEN ' +
  '(see .env.example) to compare the waterfall against a live balance. Until then every ' +
  'boundary comes from a statement you evidenced — which is the only thing a boundary was ' +
  'ever allowed to come from (ADR-0054).';

export function createUnconfiguredBalanceProvider(reason?: string): BalanceProviderPort {
  const unavailableReason = reason ?? BALANCE_PROVIDER_UNCONFIGURED_REASON;
  return {
    describe(): BalanceProviderCapabilities {
      return {
        providerId: 'unconfigured',
        label: 'Not configured',
        configured: false,
        unavailableReason,
      };
    },
    fetchBalances(): Promise<BalanceReadResult> {
      return Promise.resolve({
        readings: [],
        complete: false,
        incompleteReason: unavailableReason,
      });
    },
  };
}
