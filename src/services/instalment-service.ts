/**
 * ```
 * services.readInstalmentsAndAnomalies ─▶ db.listPaymentPurposeContext   every row, once
 *                                     ├─▶ domain.buildInstalmentPlans    what belongs together
 *                                     └─▶ domain.findAnomalies           what is worth a look
 * ```
 *
 * Instalment plans ([ADR-0062](../../docs/decisions/0062-an-instalment-plan-is-a-timeline-of-what-the-statement-said.md))
 * and anomalies ([ADR-0063](../../docs/decisions/0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md))
 * are produced by **one** function over **one** snapshot, deliberately.
 *
 * They are not independent. The anomaly reader's central rule is that a row a recognised plan
 * already explains cannot be a finding, so it needs the exact set of payments the plan reader
 * accounted for. Two services reading the table separately would each hold their own snapshot,
 * and a row imported between the two calls would be inside one and outside the other — which
 * surfaces as an anomaly about a plan the anomaly list cannot see. Reading once removes the
 * possibility rather than making it unlikely.
 *
 * Both are pure reads. Nothing here writes a row, records a proposal, creates a link or enqueues
 * a question.
 */

import { listPaymentPurposeContext } from '../db/index.js';
import type { Executor } from '../db/index.js';
import { buildInstalmentPlans, paymentsExplainedByPlans, planForPayment } from '../domain/index.js';
import type { Anomaly, InstalmentPlan } from '../domain/index.js';
import { findAnomalies } from '../domain/index.js';

export interface LedgerReading {
  readonly plans: readonly InstalmentPlan[];
  readonly anomalies: readonly Anomaly[];
  /** How many rows the reading covered, so a screen can say what it looked at. */
  readonly rowsRead: number;
}

/**
 * Every instalment plan and every anomaly the ledger's own rows support.
 *
 * One pass. The plans are built first because the anomalies depend on them.
 */
export async function readInstalmentsAndAnomalies(db: Executor): Promise<LedgerReading> {
  const rows = await listPaymentPurposeContext(db);

  const sourceRows = rows.map((row) => ({
    paymentId: row.paymentId,
    rawDescription: row.rawDescription,
    direction: row.direction,
    occurredAt: row.occurredAt,
    amount: row.amount,
  }));

  const plans = buildInstalmentPlans(sourceRows);

  const anomalies = findAnomalies({
    rows: sourceRows,
    explainedByPlans: paymentsExplainedByPlans(plans),
    planPrincipals: plans.map((plan) => ({
      planKey: plan.planKey,
      merchantName: plan.merchantName,
      charges: plan.positions
        .flatMap((position) => position.charges)
        .filter((charge) => charge.component === 'principal')
        .map((charge) => ({
          paymentId: charge.paymentId,
          occurredAt: charge.occurredAt,
          amount: charge.amount,
          narration: charge.narration,
        })),
    })),
  });

  return { plans, anomalies, rowsRead: rows.length };
}

/**
 * The plan one payment belongs to, or `null`.
 *
 * Goes through the same full reading rather than grouping the payment's own merchant separately,
 * so the event screen and the plan list can never disagree about which plan a row is in. It is
 * O(ledger) per detail page, which is the same trade `getPaymentConnection` already makes for the
 * same reason — one definition beats a faster second one.
 */
export async function getInstalmentPlanForPayment(
  db: Executor,
  paymentId: string,
): Promise<InstalmentPlan | null> {
  const { plans } = await readInstalmentsAndAnomalies(db);
  return planForPayment(plans, paymentId);
}
