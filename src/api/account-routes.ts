/**
 * `GET /api/accounts` — the account roster (`docs/roadmap.md` phase 21).
 *
 * `services.listAccounts`'s only caller. Phase 16 shipped the per-account cash identity with
 * no API surface for it on purpose; this is half of what phase 21 needs to collect evidenced
 * statement boundaries and render the waterfall, the other half being
 * `GET /api/reconciliation/runs/:id/account-snapshots`.
 *
 * A read. `last4` is a redacted trailing fragment the schema already constrains to at most
 * four digits — there is no full account or card number in this system to return.
 */

import { listAccounts } from '../services/index.js';

import { jsonResponse } from './http.js';
import type { ApiDependencies } from './router.js';

export async function getAccountsRoute(deps: ApiDependencies): Promise<Response> {
  const accounts = await listAccounts(deps.db);
  return jsonResponse(200, { accounts });
}
