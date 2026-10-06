/**
 * The one check every act that makes a payment count must pass first (ADR-0071).
 *
 * `invariants.md` #10 says one movement must not be counted twice. The review queue is how a
 * person is asked whether two payments are one movement; this is what stops the answer being
 * skipped. A payment **counts** the moment a decision, a hand-entered funding link or a
 * settlement explains it, and until a person has said otherwise it may not do so while a payment
 * the duplicate rule (ADR-0070) pairs it with already counts:
 *
 *  - the pair is still **asked about** — the queue keeps the counted half as the survivor and
 *    offers the live half as the one to discard (`services.listReviewQueue`); and
 *  - the live half **cannot be counted** until it has been answered, either way. Confirming
 *    discards it; dismissing records two real movements, and then both may count.
 *
 * Nothing here changes what makes two payments a pair. That is `domain.isPossibleDuplicate`,
 * unchanged, and this only asks it. Nothing is discarded, merged or edited by a refusal: the
 * refusal says what to answer, and the person answers it.
 *
 * Also refused: counting a payment already discarded as a duplicate (`ignored`). It does not
 * count — the copy it restates does — and explaining it would put an approved expense on money
 * the ledger says did not move twice.
 *
 * **Concurrency.** Every act that counts a payment first takes one lock for the payment's
 * *class* — its amount and direction, which is all the duplicate rule can pair — and takes it
 * **before it reads or locks anything else** (`db.lockPaymentClasses`). Two decisions on the two
 * halves of one pair therefore run one after the other and the second sees what the first
 * committed. An earlier version locked the payment, discovered its twins and then locked those;
 * two transactions did that in opposite directions and PostgreSQL aborted one with a deadlock
 * (`40P01`) instead of the refusal below. The rule that replaced it: a transaction that will
 * count several payments names them all to `lockPaymentClasses` once, at its start.
 */

import { isPossibleDuplicate, possibleDuplicateKey } from '../domain/index.js';
import type { PaymentId } from '../domain/index.js';
import {
  listClaimedPaymentIds,
  listDismissedDuplicatePairs,
  listDuplicateTwinIds,
  listPaymentsByIds,
  lockPaymentClasses,
} from '../db/index.js';
import type { Executor, PaymentRow } from '../db/index.js';

import { ServiceError } from './errors.js';

/** The reason a refusal carries, so a surface can tell the two apart without reading prose. */
export const UNRESOLVED_DUPLICATE_REASON = 'unresolved_possible_duplicate';
export const DISCARDED_DUPLICATE_REASON = 'discarded_duplicate';

/**
 * Throws unless this payment may now be counted. Must run inside the transaction that counts it.
 *
 * A payment that already counts passes: adding a second funding link to it, or a settlement
 * beside a link, is not a new movement being counted.
 */
export async function assertPaymentMayBeCounted(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentRow | null> {
  // The lock comes first, so nothing below can be read before a competing decision on this
  // class has finished. Re-taking a class the caller already holds costs nothing.
  await lockPaymentClasses(exec, [paymentId]);
  const [first] = await listPaymentsByIds(exec, [paymentId]);
  if (first === undefined) return null;

  if (first.state === 'ignored') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This payment was discarded as a duplicate of another, so it does not count and nothing ' +
        'may explain it. The copy it restates is the one to explain (invariants.md #10).',
      { paymentId: first.id, reason: DISCARDED_DUPLICATE_REASON },
    );
  }

  const twinIds = await listDuplicateTwinIds(exec, first);
  if (twinIds.length === 0) return first;

  // Every one of these is in `first`'s class, which this transaction holds, so what is read
  // below cannot change underneath it.
  const locked = await listPaymentsByIds(exec, [first.id, ...twinIds]);
  const self = locked.find((row) => row.id === first.id);
  if (self === undefined || self.state === 'ignored') return self ?? first;

  const claimed = await listClaimedPaymentIds(
    exec,
    locked.map((row) => row.id),
  );
  if (claimed.has(self.id)) return self;

  const dismissed = new Set(await listDismissedDuplicatePairs(exec));
  for (const other of locked) {
    if (other.id === self.id || !claimed.has(other.id)) continue;
    if (!isPossibleDuplicate(self, other)) continue;
    if (dismissed.has(possibleDuplicateKey(self.id, other.id))) continue;
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This payment looks like the same movement as another one that already counts — same ' +
        'amount, same day, same payee. Counting both would count it twice, so say first whether ' +
        'they are one payment: confirm it as a duplicate (the copy that does not count is set ' +
        'aside), or record that they are two real movements. The question is in Needs ' +
        'attention (invariants.md #10, ADR-0071).',
      {
        paymentId: self.id,
        resemblesPaymentId: other.id,
        reason: UNRESOLVED_DUPLICATE_REASON,
      },
    );
  }
  return self;
}
