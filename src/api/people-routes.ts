/**
 * `GET /api/people` — the roster `web/` renders names from (`docs/roadmap.md` phase 15).
 *
 * `services.listPeople`'s first `src/api` caller — the underlying reads
 * (`db.listPeople`/`getPrimaryUserPerson`) are unchanged, foundation-pass code.
 */

import { listPeople } from '../services/index.js';

import { jsonResponse } from './http.js';
import type { ApiDependencies } from './router.js';

export async function getPeopleRoute(deps: ApiDependencies): Promise<Response> {
  const people = await listPeople(deps.db);
  return jsonResponse(200, { people });
}
