/**
 * The account roster — a read the per-account cash waterfall needs (`docs/roadmap.md` phase 21).
 *
 * Phase 16 shipped ADR-0017 (cash balance)'s `ReconciliationAccountSnapshot` with no API
 * surface at all, deliberately: "collecting evidenced statement balances and displaying the
 * account waterfall are Phase 21's". Both need to name an account, and neither may render a
 * raw `accounts.id` at a person — so this is the roster that turns one into a name, exactly as
 * `listPeople` does for a `PersonId`.
 *
 * A read, and only a read. Nothing here computes, classifies, or writes; `last4` is the only
 * identifying fragment the schema stores at all (`accounts_last4_check`), and no full account
 * or card number exists to leak (`security-model.md`).
 */

import { listAccountSummaries } from '../db/index.js';
import type { AccountSummaryRow, Executor } from '../db/index.js';
import type { AccountId } from '../domain/index.js';

export interface AccountSummary {
  readonly id: AccountId;
  readonly name: string;
  readonly type: string;
  readonly institution: string | null;
  /** A redacted trailing fragment, at most four digits. Never a full number. */
  readonly last4: string | null;
  readonly currency: string;
  readonly isActive: boolean;
  /**
   * When the account was closed, or `null`.
   *
   * Archived accounts are listed rather than hidden: a closed account still posted real
   * movements in a past period, and a snapshot naming it must stay renderable (17.6). A
   * surface says "closed" rather than showing a nameless id.
   */
  readonly archivedAt: Date | null;
}

/** Every account, by name — including archived ones, each flagged as such. */
export async function listAccounts(db: Executor): Promise<readonly AccountSummary[]> {
  const rows: readonly AccountSummaryRow[] = await listAccountSummaries(db);
  return rows;
}
