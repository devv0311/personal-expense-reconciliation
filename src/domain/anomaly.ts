/**
 * Things worth a second look, each one a comparison between rows with those rows attached.
 *
 * [ADR-0063](../../docs/decisions/0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md).
 *
 * Two failure modes shape everything here, and the second is worse than the first.
 *
 * **Noise.** On a real card statement most rows look irregular and are not: tax components,
 * interest, principal amortisation, EMI fees and the card bill together account for the large
 * majority of lines. A detector that flagged them would teach its reader to close the list within
 * a day, and the one finding that mattered would go with them. So suppression happens *here*,
 * before a finding is built — a row a recognised instalment plan explains cannot become one — and
 * not in a UI filter that the next person to touch the screen can undo.
 *
 * **Accusation.** A statement line does not tell you the merchant's pricing, the card's terms or
 * what somebody agreed to. "This charge is suspicious" is a claim this product cannot support and
 * should not make; "two payments to the same place for the same amount, three hours apart" is a
 * fact about two rows and is always true. Every finding below is written as the second kind, and
 * every one carries the payments it compared.
 */

import { type Paise, subtractPaise } from './money.js';
import { type RowNature, readStatementRow } from './purpose.js';

/* ------------------------------------------------------------------------------- inputs */

export interface AnomalySourceRow {
  readonly paymentId: string;
  readonly rawDescription: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  readonly amount: Paise;
}

export interface AnomalyInput {
  readonly rows: readonly AnomalySourceRow[];
  /**
   * Payments a recognised instalment plan already accounts for
   * ({@link import('./instalment.js').paymentsExplainedByPlans}).
   *
   * These are invisible to every check below. That is the feature, not a filter over it.
   */
  readonly explainedByPlans: ReadonlySet<string>;
  /** Principal amounts per plan, so a plan that charges unevenly can be noticed. */
  readonly planPrincipals: readonly PlanPrincipals[];
}

export interface PlanPrincipals {
  readonly planKey: string;
  readonly merchantName: string | null;
  /**
   * The plan's principal repayments, each carrying enough to *be* evidence.
   *
   * The date and the wording are required rather than optional: a finding cites the rows it
   * compared, and a citation that had to invent a date in order to satisfy its own type would
   * be a fabricated fact sitting inside the thing that exists to prevent them.
   */
  readonly charges: readonly AnomalyEvidence[];
}

/* ------------------------------------------------------------------------------ outputs */

export type AnomalyKind =
  'unexplained_interest' | 'inconsistent_instalment' | 'unusual_fee' | 'repeated_charge';

/** A payment a finding points at, so "why are you telling me this?" is one tap away. */
export interface AnomalyEvidence {
  readonly paymentId: string;
  readonly occurredAt: Date;
  readonly amount: Paise;
  /** The issuer's own wording. Immutable source, quoted rather than interpreted. */
  readonly narration: string;
}

export interface Anomaly {
  /** Stable for one read, so a screen can key a list without an index. */
  readonly id: string;
  readonly kind: AnomalyKind;
  /** What was noticed, as a comparison. Never a verdict, never a recommendation to act. */
  readonly headline: string;
  /** The comparison spelled out — what differs, and against what basis. */
  readonly detail: string;
  /** Every row the comparison used. Never empty. */
  readonly evidence: readonly AnomalyEvidence[];
}

/* ------------------------------------------------------------------------- the thresholds */

/**
 * How much larger a fee must be than its merchant's usual one before it is worth mentioning.
 *
 * Three times, and a minimum of two prior fees to compare against. A fee that is merely a little
 * higher is not news, and a "usual" derived from one previous fee is not a usual. Both numbers
 * are deliberately conservative: a missed finding costs nothing the ledger was not already
 * hiding, and a false one costs the reader's trust in the whole list.
 */
const FEE_MULTIPLE = 3n;
const FEE_MINIMUM_BASIS = 2;

/** How close two identical charges must be before their closeness is the notable part. */
const REPEAT_WINDOW_HOURS = 24;
const REPEAT_WINDOW_MS = REPEAT_WINDOW_HOURS * 60 * 60 * 1000;

/** Natures that are ordinary card mechanics and never an anomaly on their own. */
const ALWAYS_QUIET: ReadonlySet<RowNature> = new Set<RowNature>([
  'tax_on_another_line',
  'card_bill_paid',
  'instalment_principal',
  'refund_or_reversal',
  'money_in',
]);

/* ---------------------------------------------------------------------------- the reading */

/**
 * Every comparison worth showing, in the order a person should meet them.
 *
 * Deterministic: the same rows give the same findings in the same order, so a screen that
 * re-reads after a correction does not reshuffle under the reader.
 */
export function findAnomalies(input: AnomalyInput): readonly Anomaly[] {
  const readable = input.rows.map((row) => ({ row, reading: readStatementRow(row) }));

  const found = [
    ...unexplainedInterest(readable, input.explainedByPlans),
    ...inconsistentInstalments(input.planPrincipals),
    ...unusualFees(readable, input.explainedByPlans),
    ...repeatedCharges(readable, input.explainedByPlans),
  ];

  return found.sort((a, b) => latest(b) - latest(a));
}

function latest(anomaly: Anomaly): number {
  return Math.max(...anomaly.evidence.map((item) => item.occurredAt.getTime()));
}

type Readable = {
  readonly row: AnomalySourceRow;
  readonly reading: ReturnType<typeof readStatementRow>;
};

function evidenceOf(row: AnomalySourceRow): AnomalyEvidence {
  return {
    paymentId: row.paymentId,
    occurredAt: row.occurredAt,
    amount: row.amount,
    narration: row.rawDescription,
  };
}

/**
 * Interest with no instalment plan it belongs to.
 *
 * Interest inside a recognised plan is the cost of that plan and is quiet. Interest that belongs
 * to no plan the statement described is a cost with nothing explaining it — which is a fact about
 * the ledger's own completeness, not an allegation about the bank.
 */
function unexplainedInterest(
  readable: readonly Readable[],
  explained: ReadonlySet<string>,
): readonly Anomaly[] {
  return readable
    .filter(
      ({ row, reading }) =>
        reading.nature === 'instalment_interest' && !explained.has(row.paymentId),
    )
    .map(({ row }) => ({
      id: `unexplained_interest:${row.paymentId}`,
      kind: 'unexplained_interest' as const,
      headline: 'Interest charged, with no instalment plan on file that explains it',
      detail:
        'This line is the cost of paying for something over time, but nothing on file says what ' +
        'was bought or how many instalments there are. The statement that set the plan up may ' +
        'not have been added yet.',
      evidence: [evidenceOf(row)],
    }));
}

/**
 * Principal repayments within one plan that are not the same amount.
 *
 * A plan repays the same principal each month; one that does not is either a plan the reader did
 * not expect or a row grouped into the wrong plan. Both are worth a look, and the finding says
 * which two amounts differ rather than asserting which is wrong.
 */
function inconsistentInstalments(plans: readonly PlanPrincipals[]): readonly Anomaly[] {
  const found: Anomaly[] = [];
  for (const plan of plans) {
    if (plan.charges.length < 2) continue;
    const amounts = new Set(plan.charges.map((charge) => charge.amount));
    if (amounts.size < 2) continue;

    found.push({
      id: `inconsistent_instalment:${plan.planKey}`,
      kind: 'inconsistent_instalment',
      headline: `Repayments of different sizes in one instalment plan${
        plan.merchantName === null ? '' : ` at ${plan.merchantName}`
      }`,
      detail:
        'The repayments on this plan are not all the same amount. That can be normal — a first ' +
        'or last instalment often differs — but it is also what a row filed under the wrong plan ' +
        'looks like.',
      evidence: plan.charges,
    });
  }
  return found;
}

/**
 * A fee much larger than the same merchant's other fees.
 *
 * Compared against that merchant's own history rather than against any absolute figure: what
 * counts as a large fee depends entirely on what is being paid for, and this product has no
 * opinion about that.
 */
function unusualFees(
  readable: readonly Readable[],
  explained: ReadonlySet<string>,
): readonly Anomaly[] {
  const byMerchant = new Map<string, Readable[]>();
  for (const entry of readable) {
    if (entry.reading.nature !== 'card_fee') continue;
    if (entry.reading.merchantKey === null) continue;
    const list = byMerchant.get(entry.reading.merchantKey) ?? [];
    list.push(entry);
    byMerchant.set(entry.reading.merchantKey, list);
  }

  const found: Anomaly[] = [];
  for (const entries of byMerchant.values()) {
    if (entries.length < FEE_MINIMUM_BASIS + 1) continue;
    const sorted = [...entries].sort((a, b) => (a.row.amount < b.row.amount ? -1 : 1));
    const largest = sorted[sorted.length - 1];
    const others = sorted.slice(0, -1);
    if (largest === undefined || others.length < FEE_MINIMUM_BASIS) continue;
    if (explained.has(largest.row.paymentId)) continue;

    // Against the median of the rest, so one other outlier cannot hide this one.
    const median = others[Math.floor(others.length / 2)];
    if (median === undefined || median.row.amount === 0n) continue;
    if (largest.row.amount < median.row.amount * FEE_MULTIPLE) continue;

    found.push({
      id: `unusual_fee:${largest.row.paymentId}`,
      kind: 'unusual_fee',
      headline: `A fee much larger than the others from ${largest.reading.merchantText ?? 'the same place'}`,
      detail:
        `This fee is at least ${String(FEE_MULTIPLE)} times the usual one from the same place on ` +
        'this statement. It may be a different kind of fee entirely — the statement does not say ' +
        'what any of them are for.',
      evidence: [evidenceOf(largest.row), ...others.map((entry) => evidenceOf(entry.row))],
    });
  }
  return found;
}

/**
 * The same merchant and the same amount, close together.
 *
 * Stated as the observation it is. Two identical coffees an hour apart produce this, and so does
 * a charge that genuinely went through twice; the product cannot tell them apart and does not
 * pretend to. The existing duplicate check (`domain/payment.ts`) is about *records* of one
 * movement; this is about two movements that may both be real.
 */
function repeatedCharges(
  readable: readonly Readable[],
  explained: ReadonlySet<string>,
): readonly Anomaly[] {
  const purchases = readable.filter(
    ({ row, reading }) =>
      reading.nature === 'merchant_purchase' &&
      reading.merchantKey !== null &&
      !ALWAYS_QUIET.has(reading.nature) &&
      !explained.has(row.paymentId),
  );

  // Grouped, not paired. Pairing produced n(n-1)/2 findings for n identical rows — four charges
  // became six separate alerts saying the same thing, which is the alert fatigue this module was
  // written to prevent, arriving by arithmetic. A cluster of identical charges is **one**
  // observation that happens to cite more than two rows. Found by looking at a rendered list.
  const clusters = new Map<string, Readable[]>();
  for (const entry of purchases) {
    const key = `${entry.reading.merchantKey ?? ''}|${String(entry.row.amount)}`;
    const cluster = clusters.get(key) ?? [];
    cluster.push(entry);
    clusters.set(key, cluster);
  }

  const found: Anomaly[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    const byTime = [...cluster].sort(
      (a, b) => a.row.occurredAt.getTime() - b.row.occurredAt.getTime(),
    );

    // Only the run that actually sits close together. Three charges over a year with two of them
    // an hour apart is a finding about those two, not about all three.
    const near: Readable[] = [];
    for (const entry of byTime) {
      const previous = near[near.length - 1];
      if (
        previous === undefined ||
        entry.row.occurredAt.getTime() - previous.row.occurredAt.getTime() <= REPEAT_WINDOW_MS
      ) {
        near.push(entry);
      }
    }
    if (near.length < 2) continue;

    const first = near[0];
    if (first === undefined) continue;
    const place = first.reading.merchantText ?? 'the same place';
    const count = near.length;

    found.push({
      id: `repeated_charge:${near
        .map((entry) => entry.row.paymentId)
        .sort()
        .join('|')}`,
      kind: 'repeated_charge',
      headline:
        count === 2
          ? `The same amount, twice at ${place}`
          : `The same amount, ${String(count)} times at ${place}`,
      detail:
        `${count === 2 ? 'Two payments' : `${String(count)} payments`} of the same amount to the ` +
        `same place, within ${String(REPEAT_WINDOW_HOURS)} hours of each other. That is often ` +
        'exactly what happened; it is also what a charge that went through more than once looks ' +
        'like.',
      evidence: near.map((entry) => evidenceOf(entry.row)),
    });
  }
  return found;
}

/** Exported for the service, which reports how much was compared alongside what was found. */
export function differenceBetween(a: Paise, b: Paise): Paise {
  return a >= b ? subtractPaise(a, b) : subtractPaise(b, a);
}
