/**
 * The people roster — a read `web/` needs (names, Splitwise linkage, who "the user" is) that no
 * phase before 15 exposed over HTTP, because no phase before 15 had a UI rendering anything
 * other than a raw id. `db.listPeople` and `db.getPrimaryUserPerson` are both unchanged,
 * foundation-pass reads; this is their first `src/api` caller (`docs/roadmap.md` phase 15).
 */

import { getPrimaryUserPerson, listPeople as dbListPeople } from '../db/index.js';
import type { Executor } from '../db/index.js';
import type { PersonId } from '../domain/index.js';

export interface PersonSummary {
  readonly id: PersonId;
  readonly displayName: string;
  readonly splitwiseUserId: string | null;
  /** True for the single `Person` a `User` maps to (`domain-model.md`). */
  readonly isUser: boolean;
}

/** Everyone not archived, oldest first, each flagged with whether they're the ledger's user. */
export async function listPeople(db: Executor): Promise<readonly PersonSummary[]> {
  const [people, userPerson] = await Promise.all([dbListPeople(db), getPrimaryUserPerson(db)]);
  return people.map((person) => ({
    id: person.id,
    displayName: person.displayName,
    splitwiseUserId: person.splitwiseUserId,
    isUser: person.id === userPerson?.personId,
  }));
}
