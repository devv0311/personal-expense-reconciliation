/**
 * An instalment plan, read out of the rows a statement actually printed.
 *
 * [ADR-0062](../../docs/decisions/0062-an-instalment-plan-is-a-timeline-of-what-the-statement-said.md).
 *
 * A single financed purchase reaches a card statement as four unrelated-looking rows on four
 * dates — the principal amortisation, the interest, the tax charged on that interest, and
 * sometimes a one-off fee. Each renders correctly on its own and none of them says *these belong
 * together*. This module says it.
 *
 * **The tenure is the issuer's, or it does not exist.** The one tempting mistake here is to group
 * on recurrence: a monthly debit of a similar amount to the same merchant looks exactly like an
 * instalment plan, and gyms, rent and subscriptions all produce that shape. Grouping on it would
 * invent a tenure, then a schedule, and the product would be asserting an obligation nobody ever
 * agreed to. So a plan's length comes only from a printed `<n/of>` marker, and where no row
 * carries one the answer is that the length is not known.
 *
 * Nothing here computes a due date, an interest rate, a remaining balance or a schedule. Those
 * are the issuer's internal facts; the product holds the rows, and the rows are what it reports.
 */

import { ZERO, addPaise, type Paise } from './money.js';
import { type RowNature, readStatementRow } from './purpose.js';

/* ------------------------------------------------------------------------------- inputs */

/** One statement row, as the caller already holds it. Immutable source, never modified here. */
export interface InstalmentSourceRow {
  readonly paymentId: string;
  readonly rawDescription: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  readonly amount: Paise;
}

/* ------------------------------------------------------------------------------ outputs */

/**
 * How much the ledger actually knows about one position in a plan.
 *
 * These are not interchangeable and a screen must never collapse them. `observed` is a row that
 * exists. `expected` is the issuer's own count — "the statement says six" — and deliberately
 * carries no amount and no date, because the product has not seen one.
 */
export type PositionCertainty = 'observed' | 'expected' | 'inferred' | 'unknown';

/** What a row within a plan is paying for. Mirrors `RowNature`, narrowed to a plan's parts. */
export type InstalmentComponent = 'principal' | 'interest' | 'tax' | 'fee';

/** One real row inside a plan. Always evidence: it has a payment behind it. */
export interface InstalmentCharge {
  readonly paymentId: string;
  readonly component: InstalmentComponent;
  readonly amount: Paise;
  readonly occurredAt: Date;
  /** The issuer's own wording, verbatim. Immutable source — for Details, not the headline. */
  readonly narration: string;
  /** Which position of the plan this row names, when it names one. */
  readonly position: number | null;
}

/**
 * One entry in the plan's timeline.
 *
 * Named an entry rather than a position because `purpose.ts` already has an
 * `InstalmentPosition` — the `<n/of>` marker read off a single line. That is where a row *says*
 * it sits; this is a step of the plan the timeline reports, seen or merely stated.
 *
 * An `observed` position lists the charges seen for it. An `expected` one lists none and carries
 * no figure: it exists because the issuer printed a tenure, and for no other reason.
 */
export interface InstalmentTimelineEntry {
  readonly number: number;
  readonly certainty: PositionCertainty;
  readonly charges: readonly InstalmentCharge[];
  /** The principal repaid at this position, when a principal row was seen for it. */
  readonly principal: Paise | null;
  /** The interest charged at this position, when an interest row was seen for it. */
  readonly interest: Paise | null;
  /** Tax attributed to this position, when a tax row could be attributed to it. */
  readonly tax: Paise | null;
}

/** A figure the plan either knows or does not. Never a zero standing in for an absence. */
export interface PlanFigure {
  readonly known: boolean;
  readonly amount: Paise | null;
  /** Why it is not known, in words, when it is not. */
  readonly unknownReason: string | null;
}

export interface InstalmentPlan {
  /** Stable within one read: the merchant key the plan's rows share. */
  readonly planKey: string;
  /** The merchant's words as the statement printed them, when it printed any. */
  readonly merchantName: string | null;

  /**
   * How many instalments the issuer said there are.
   *
   * `known: false` means no row carried a `<n/of>` marker. It does **not** mean the plan is
   * open-ended, and nothing downstream may treat it as a number.
   */
  readonly tenure: { readonly known: boolean; readonly of: number | null };

  /**
   * The original purchase, when a row evidences one.
   *
   * Usually absent: a statement shows the repayments of a purchase financed on an earlier
   * statement, not the purchase itself. Absent is reported as absent.
   */
  readonly purchase: {
    readonly known: boolean;
    readonly paymentId: string | null;
    readonly amount: Paise | null;
    readonly occurredAt: Date | null;
  };

  readonly positions: readonly InstalmentTimelineEntry[];

  /** Charges that belong to the plan but name no position — a joining fee, an unnumbered tax. */
  readonly unpositionedCharges: readonly InstalmentCharge[];

  /** Totals over **observed** rows only. Never over expected positions. */
  readonly observed: {
    readonly principal: Paise;
    readonly interest: Paise;
    readonly tax: Paise;
    readonly fee: Paise;
    readonly chargeCount: number;
  };

  /** How many of the issuer's stated positions have been seen. `null` when tenure is unknown. */
  readonly progress: { readonly seen: number; readonly of: number | null };

  /**
   * What this plan does not know, in words a person reads.
   *
   * Rendered as-is. This is where "no due date" lives, rather than in a field the screen would
   * have to notice was missing.
   */
  readonly unknowns: readonly string[];
}

/* ------------------------------------------------------------------------- the reading */

/**
 * The one nature that may *found* a plan: a principal repayment.
 *
 * A repayment plan is defined by its repayments. Interest is a cost **of** a plan, not evidence
 * that one exists — and treating a lone interest row as a plan would be the quiet way to lose the
 * most useful finding this product has: interest charged with nothing on file explaining it
 * (ADR-0063). So interest attaches to plans that principal rows established, exactly as fees and
 * tax do, and interest that attaches to nothing stays visibly unexplained.
 */
const FOUNDING_NATURE: RowNature = 'instalment_principal';

/**
 * Groups rows into the plans their own words describe.
 *
 * Two passes, and the order matters. The first finds the plans: only rows whose nature is already
 * instalment-shaped can *create* one, so a merchant with ordinary monthly purchases never becomes
 * a plan however regular it looks. The second attaches the supporting rows — fees, and tax that a
 * plan's own span covers — to plans that already exist.
 */
export function buildInstalmentPlans(
  rows: readonly InstalmentSourceRow[],
): readonly InstalmentPlan[] {
  const grouped = new Map<string, { readonly name: string | null; rows: PlanRow[] }>();

  // Pass one: principal repayments, which are the only rows that may found a plan.
  for (const row of rows) {
    const reading = readStatementRow(row);
    if (reading.nature !== FOUNDING_NATURE) continue;
    if (reading.merchantKey === null) continue;

    const existing = grouped.get(reading.merchantKey);
    const entry = existing ?? { name: reading.merchantText, rows: [] };
    entry.rows.push({
      row,
      component: 'principal',
      position: reading.instalment?.number ?? null,
      of: reading.instalment?.of ?? null,
    });
    if (existing === undefined) grouped.set(reading.merchantKey, entry);
  }

  if (grouped.size === 0) return [];

  // Pass two: interest and fees that name a plan's merchant. Both attach to a plan that already
  // exists and neither may create one.
  for (const row of rows) {
    const reading = readStatementRow(row);

    if (reading.nature === 'instalment_interest' && reading.merchantKey !== null) {
      const entry = grouped.get(reading.merchantKey);
      if (entry !== undefined) {
        entry.rows.push({
          row,
          component: 'interest',
          position: reading.instalment?.number ?? null,
          of: reading.instalment?.of ?? null,
        });
      }
      continue;
    }

    if (reading.nature === 'card_fee' && reading.merchantKey !== null) {
      // By merchant key, never by date. A fee whose wording does not separate the merchant from
      // the fee words produces a different key and is left unattached — which is the right
      // failure: an unattached fee is visible on its own row, a misattached one is money moved
      // onto the wrong purchase.
      const entry = grouped.get(reading.merchantKey);
      if (entry !== undefined) {
        entry.rows.push({
          row,
          component: 'fee',
          position: reading.instalment?.number ?? null,
          of: reading.instalment?.of ?? null,
        });
      }
      continue;
    }
  }

  // Pass three: tax, which attaches by proximity to an interest or fee charge — so it has to run
  // after pass two has put those charges on their plans.
  for (const row of rows) {
    const reading = readStatementRow(row);
    if (reading.nature !== 'tax_on_another_line') continue;
    const owner = solePlanTaxedBy(grouped, row.occurredAt);
    if (owner !== null) {
      grouped.get(owner)?.rows.push({ row, component: 'tax', position: null, of: null });
    }
  }

  return [...grouped.entries()]
    .map(([planKey, entry]) => toPlan(planKey, entry.name, entry.rows))
    .sort((a, b) => (a.merchantName ?? a.planKey).localeCompare(b.merchantName ?? b.planKey));
}

interface PlanRow {
  readonly row: InstalmentSourceRow;
  readonly component: InstalmentComponent;
  readonly position: number | null;
  readonly of: number | null;
}

/**
 * How far a tax row may sit from the charge it was levied on.
 *
 * Card tax is charged on the interest or fee of the same statement, normally on the same day and
 * occasionally a day or two later once the issuer posts it. Three days is wide enough to catch
 * that posting lag and narrow enough that two unrelated months never overlap. It is a constant
 * with a reason rather than a tuned number: widening it trades a correct attribution for the risk
 * of putting somebody's tax on the wrong purchase, which is the more expensive mistake.
 */
const TAX_ATTRIBUTION_DAYS = 3;
const TAX_ATTRIBUTION_MS = TAX_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The one plan whose interest or fee this tax row was plausibly charged on, or `null`.
 *
 * Proximity to an **interest or fee charge** specifically, not to a plan's whole span: tax on a
 * card statement is levied on the cost of credit, not on the principal being repaid, so a
 * principal row is not something tax attaches to.
 *
 * `null` whenever more than one plan qualifies. Two candidates means the ledger genuinely cannot
 * say which purchase the tax belongs to, and a guess there moves money onto the wrong plan — so
 * the row stays on its own, visibly unattached, which is the honest outcome.
 */
function solePlanTaxedBy(
  grouped: ReadonlyMap<string, { readonly rows: readonly PlanRow[] }>,
  taxedAt: Date,
): string | null {
  const candidates: string[] = [];
  for (const [key, entry] of grouped) {
    const near = entry.rows.some(
      (planRow) =>
        (planRow.component === 'interest' || planRow.component === 'fee') &&
        Math.abs(planRow.row.occurredAt.getTime() - taxedAt.getTime()) <= TAX_ATTRIBUTION_MS,
    );
    if (near) candidates.push(key);
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function toPlan(
  planKey: string,
  merchantName: string | null,
  planRows: readonly PlanRow[],
): InstalmentPlan {
  // The issuer's own count. Where two rows disagree the larger is taken and the disagreement is
  // reported as an unknown rather than silently resolved — a plan whose statement contradicts
  // itself is exactly the case a confident answer would get wrong.
  const stated = [...new Set(planRows.map((planRow) => planRow.of).filter(isNumber))];
  const of = stated.length === 0 ? null : Math.max(...stated);
  const tenureDisputed = stated.length > 1;

  const charges = planRows.map((planRow): InstalmentCharge => ({
    paymentId: planRow.row.paymentId,
    component: planRow.component,
    amount: planRow.row.amount,
    occurredAt: planRow.row.occurredAt,
    narration: planRow.row.rawDescription,
    position: planRow.position,
  }));

  const positioned = charges.filter((charge) => charge.position !== null);
  const seenNumbers = [...new Set(positioned.map((charge) => charge.position as number))].sort(
    (a, b) => a - b,
  );

  // Every position the ledger can speak about: the ones seen, plus — only when the issuer stated
  // a tenure — the ones it said exist. Never a position beyond what was printed.
  const allNumbers =
    of === null
      ? seenNumbers
      : [...new Set([...seenNumbers, ...range(1, of)])].sort((a, b) => a - b);

  const positions = allNumbers.map((number): InstalmentTimelineEntry => {
    const here = positioned.filter((charge) => charge.position === number);
    if (here.length === 0) {
      return {
        number,
        certainty: 'expected',
        charges: [],
        principal: null,
        interest: null,
        tax: null,
      };
    }
    return {
      number,
      certainty: 'observed',
      charges: here,
      principal: componentTotalOrNull(here, 'principal'),
      interest: componentTotalOrNull(here, 'interest'),
      tax: componentTotalOrNull(here, 'tax'),
    };
  });

  return {
    planKey,
    merchantName,
    tenure: { known: of !== null && !tenureDisputed, of },
    // A repayment plan's rows are the repayments. The purchase itself was financed on an earlier
    // statement and is simply not here; reporting it as absent is the honest answer.
    purchase: { known: false, paymentId: null, amount: null, occurredAt: null },
    positions,
    unpositionedCharges: charges.filter((charge) => charge.position === null),
    observed: {
      principal: componentTotal(charges, 'principal'),
      interest: componentTotal(charges, 'interest'),
      tax: componentTotal(charges, 'tax'),
      fee: componentTotal(charges, 'fee'),
      chargeCount: charges.length,
    },
    progress: { seen: seenNumbers.length, of: tenureDisputed ? null : of },
    unknowns: unknownsFor({ of, tenureDisputed, seen: seenNumbers.length }),
  };
}

/**
 * What the plan cannot tell you, said plainly.
 *
 * Every entry here is a thing a reader might reasonably expect and the product does not hold. The
 * "no due date" line is unconditional on purpose: it is true of every plan this product will ever
 * read, and a reader who does not see it stated will assume the absence is an oversight.
 */
function unknownsFor(input: {
  of: number | null;
  tenureDisputed: boolean;
  seen: number;
}): readonly string[] {
  const unknowns: string[] = [];
  if (input.of === null) {
    unknowns.push(
      'How many instalments there are in total — no statement line said, and how often something repeats is not evidence of how long it runs.',
    );
  } else if (input.tenureDisputed) {
    unknowns.push(
      'How many instalments there are in total — the statement lines disagree with each other about it.',
    );
  }
  unknowns.push(
    'When the next one is due, and how much it will be. A statement records what was charged; it does not say what the bank will charge next.',
  );
  unknowns.push(
    'What was originally bought, and for how much — that was charged on an earlier statement than the ones on file.',
  );
  return unknowns;
}

function componentTotal(
  charges: readonly InstalmentCharge[],
  component: InstalmentComponent,
): Paise {
  let total = ZERO;
  for (const charge of charges) {
    if (charge.component === component) total = addPaise(total, charge.amount);
  }
  return total;
}

function componentTotalOrNull(
  charges: readonly InstalmentCharge[],
  component: InstalmentComponent,
): Paise | null {
  const present = charges.some((charge) => charge.component === component);
  return present ? componentTotal(charges, component) : null;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += 1) out.push(value);
  return out;
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

/**
 * The plan a given payment belongs to, or `null`.
 *
 * A lookup rather than a second grouping, so an event screen and the plan list can never disagree
 * about which plan a row is in.
 */
export function planForPayment(
  plans: readonly InstalmentPlan[],
  paymentId: string,
): InstalmentPlan | null {
  for (const plan of plans) {
    const inPositions = plan.positions.some((position) =>
      position.charges.some((charge) => charge.paymentId === paymentId),
    );
    if (inPositions) return plan;
    if (plan.unpositionedCharges.some((charge) => charge.paymentId === paymentId)) return plan;
  }
  return null;
}

/** Every payment id any plan accounts for. What the anomaly reader must leave alone. */
export function paymentsExplainedByPlans(plans: readonly InstalmentPlan[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const plan of plans) {
    for (const position of plan.positions) {
      for (const charge of position.charges) ids.add(charge.paymentId);
    }
    for (const charge of plan.unpositionedCharges) ids.add(charge.paymentId);
  }
  return ids;
}
