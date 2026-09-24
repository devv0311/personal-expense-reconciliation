/**
 * "Analyze records" — the one thing a person does after adding something.
 *
 * ```
 * services.analyzeRecords ─▶ services.normalizePayments      read what each record says
 *                         ─▶ services.classifyPayments       work out what each payment was
 *                         ─▶ services.matchEvidenceContext   connect records to each other
 * ```
 *
 * **Orchestration only.** Every stage calls a service that already exists, already refuses to
 * approve anything, and is already idempotent: normalization acts on `imported` rows only,
 * classification skips a payment that already carries a proposal, and matching returns
 * `unchanged` having written nothing when it finds what is already recorded. Running this
 * twice over an unchanged ledger changes nothing and says so.
 *
 * **It approves nothing.** Not a category, not a match, not a duplicate, not a beneficiary,
 * not a share, not a transfer, not a refund, not a debt. The most it can do is fill the
 * question list, which is exactly what `ai-boundary.md` designs for.
 *
 * **A stage that could not run says which one and why.** The two screens this replaced were
 * called *Run normalization* and *Run classification*, and the second one simply failed on an
 * installation with no model configured — which is the default. Here the deterministic half of
 * classification still runs (self-transfer pairing is arithmetic over two rows, and it is what
 * keeps a credit-card bill payment out of spending), and the model half is reported `skipped`
 * carrying the transport's own declared reason. Nothing reads as success that was not.
 */

import type { AiService } from '../ai/index.js';
import type { ClassificationSkipReason, ImportBatchId, PaymentId } from '../domain/index.js';
import {
  listPaymentsAwaitingClassification,
  listPaymentsAwaitingNormalization,
  listUnmatchedEvidence,
} from '../db/index.js';
import type { Database, EvidenceRow, Executor, PaymentRow } from '../db/index.js';

import type { AuditMeta } from './audit.js';
import { classifyPayments } from './classification-service.js';
import type { ClassificationOutcome } from './classification-service.js';
import { matchEvidenceContext } from './evidence-enrichment-service.js';
import { normalizePayments } from './normalization-service.js';
import { loadPurposeContext, readPurposeFor } from './purpose-proposal-service.js';
import { listReviewQueue } from './review-service.js';

/* ---------------------------------------------------------------------------- stages */

/** The three stages, in the order they run. Named for what they do, not for the machinery. */
export const ANALYSIS_STAGES = ['read_records', 'work_out_purpose', 'connect_records'] as const;
export type AnalysisStageName = (typeof ANALYSIS_STAGES)[number];

/**
 * What happened to one stage.
 *
 * `skipped` and `failed` are deliberately different. `skipped` means the stage could not run
 * and the reason is a fact about this installation — no model is configured. `failed` means it
 * started and something went wrong. A surface that collapsed them would tell somebody to fix a
 * configuration when the truth was a bug, or the reverse.
 */
export type AnalysisStageStatus = 'done' | 'partial' | 'skipped' | 'failed';

export interface AnalysisStage {
  readonly name: AnalysisStageName;
  readonly status: AnalysisStageStatus;
  /** One sentence in the reader's language. Never a state name, never a code. */
  readonly summary: string;
  /** Why it could not run or did not finish. Present exactly when it did not fully run. */
  readonly unfinishedReason?: string;
  /** How many records this stage actually touched. */
  readonly recordsTouched: number;
}

/* ---------------------------------------------------------------------------- result */

export interface AnalysisResult {
  /** Every record the run looked at: payments read, plus documents it tried to place. */
  readonly recordsChecked: number;
  /** Connections proposed between a document and a payment. Never made — only proposed. */
  readonly connectionsFound: number;
  /** Suggestions about what a payment was, waiting for a person. */
  readonly suggestionsReady: number;
  /** Everything now waiting on a human decision, from the queue's own count. */
  readonly questionsForYou: number;
  /** Records the run could say nothing about. Not a failure — a fact to show. */
  readonly notUnderstood: number;
  readonly stages: readonly AnalysisStage[];
  /**
   * True when every stage ran to completion.
   *
   * A surface must not say "done" when this is false. It is the single flag that keeps a run
   * with a skipped stage from reading as a finished one.
   */
  readonly complete: boolean;
}

export interface AnalyzeRecordsInput {
  readonly ai: AiService;
  readonly audit: AuditMeta;
  /** Scope every stage to one imported statement. Omitted means everything outstanding. */
  readonly importBatchId?: ImportBatchId;
  /** Bounds the document pass, so one run over a large library stays a request. */
  readonly documentLimit?: number;
}

const DEFAULT_DOCUMENT_LIMIT = 50;

export async function analyzeRecords(
  db: Database,
  input: AnalyzeRecordsInput,
): Promise<AnalysisResult> {
  const stages: AnalysisStage[] = [];

  const read = await readRecords(db, input);
  stages.push(read.stage);

  const purpose = await workOutPurpose(db, input);
  stages.push(purpose.stage);

  const connected = await connectRecords(db, input);
  stages.push(connected.stage);

  // The queue's own count, so "what needs you" after a run is the same number every other
  // screen reports. Re-deriving it here would be a second answer to one question.
  const queue = await listReviewQueue(db, { limit: 1 });

  return {
    recordsChecked: read.stage.recordsTouched + connected.stage.recordsTouched,
    connectionsFound: connected.connections,
    suggestionsReady: purpose.proposals,
    questionsForYou: queue.total,
    notUnderstood: purpose.notUnderstood + connected.notUnderstood,
    stages,
    complete: stages.every((stage) => stage.status === 'done'),
  };
}

/* ---------------------------------------------------------------------- stage: read */

async function readRecords(
  db: Database,
  input: AnalyzeRecordsInput,
): Promise<{ stage: AnalysisStage }> {
  const awaiting = await listPaymentsAwaitingNormalization(db, input.importBatchId);
  if (awaiting.length === 0) {
    return {
      stage: {
        name: 'read_records',
        status: 'done',
        summary: 'Every record on file had already been read.',
        recordsTouched: 0,
      },
    };
  }

  try {
    const result = await normalizePayments(db, {
      audit: input.audit,
      ...(input.importBatchId === undefined ? {} : { importBatchId: input.importBatchId }),
    });
    const count = result.normalizedPaymentIds.length;
    return {
      stage: {
        name: 'read_records',
        status: 'done',
        summary:
          `Read ${count} new ${count === 1 ? 'record' : 'records'}, and recognised ` +
          `${result.merchantResolvedCount} of them by name.`,
        recordsTouched: count,
      },
    };
  } catch (error) {
    return {
      stage: {
        name: 'read_records',
        status: 'failed',
        summary: `${awaiting.length} records were not read.`,
        unfinishedReason: messageOf(error),
        recordsTouched: 0,
      },
    };
  }
}

/* ------------------------------------------------------------------- stage: purpose */

async function workOutPurpose(
  db: Database,
  input: AnalyzeRecordsInput,
): Promise<{ stage: AnalysisStage; proposals: number; notUnderstood: number }> {
  const availability = input.ai.describeAvailability();

  let result;
  try {
    result = await classifyPayments(db, {
      ai: input.ai,
      audit: input.audit,
      ...(availability.configured ? {} : { deterministicOnly: true }),
      ...(input.importBatchId === undefined ? {} : { importBatchId: input.importBatchId }),
    });
  } catch (error) {
    return {
      stage: {
        name: 'work_out_purpose',
        status: 'failed',
        summary: 'Nothing was worked out about what these payments were for.',
        unfinishedReason: messageOf(error),
        recordsTouched: 0,
      },
      proposals: 0,
      notUnderstood: 0,
    };
  }

  const proposals = countOutcome(result.outcomes, 'proposed');
  const transfers = countOutcome(result.outcomes, 'internal_transfer');
  const rejected = countOutcome(result.outcomes, 'rejected');
  const unanswered = result.outcomes.filter(
    (outcome) => outcome.outcome === 'skipped' && isUnanswered(outcome.reason),
  ).length;

  // With no provider configured this stage used to report `skipped` and zero proposals — which
  // was true when the deterministic leg could only pair transfers, and became a lie the moment
  // the local description reader started proposing (ADR-0060). What decides the wording now is
  // **what actually happened**, not what is configured: a run that read a hundred lines and
  // suggested what forty of them were for did not skip.
  if (!availability.configured && proposals === 0 && transfers === 0) {
    return {
      stage: {
        name: 'work_out_purpose',
        status: 'skipped',
        summary: 'Nothing in these records said what they were for.',
        // Deliberately this sentence and not the transport's own. A transport declares its
        // reason for the screen that owns it, and that wording names environment variables and
        // other screens — true, useful under Details, and not something a primary surface may
        // say. What a person needs here is that nothing was guessed and they can still answer.
        unfinishedReason:
          'Nothing was guessed about any of them. You can still say what each one was yourself.',
        recordsTouched: 0,
      },
      proposals: 0,
      notUnderstood: unanswered,
    };
  }

  return {
    stage: {
      name: 'work_out_purpose',
      status: rejected > 0 ? 'partial' : 'done',
      summary:
        `Suggested what ${proposals} ${proposals === 1 ? 'payment was' : 'payments were'} for` +
        (transfers === 0
          ? '.'
          : `, and recognised ${transfers} as ${transfers === 1 ? 'a transfer' : 'transfers'} between your own accounts.`),
      ...(rejected === 0
        ? {}
        : {
            unfinishedReason:
              `${rejected} ${rejected === 1 ? 'payment' : 'payments'} came back with an answer ` +
              'that could not be stored, so nothing was recorded for them.',
          }),
      recordsTouched: proposals + transfers,
    },
    proposals,
    notUnderstood: unanswered + rejected,
  };
}

/**
 * Skip reasons that mean "nothing was established", as opposed to "already settled".
 *
 * `not_a_purchase_of_its_own` is deliberately absent. A tax line or an instalment repayment was
 * **understood** — well enough to refuse to propose anything about it — and counting it as a
 * record nothing could be made of would report the safety rule as a failure, on a card
 * statement where those rows are the majority.
 */
function isUnanswered(reason: ClassificationSkipReason): boolean {
  return (
    reason === 'no_model_configured' ||
    reason === 'credit_out_of_scope' ||
    reason === 'nothing_to_go_on'
  );
}

function countOutcome(
  outcomes: readonly ClassificationOutcome[],
  kind: ClassificationOutcome['outcome'],
): number {
  return outcomes.filter((outcome) => outcome.outcome === kind).length;
}

/* ------------------------------------------------------------------- stage: connect */

async function connectRecords(
  db: Database,
  input: AnalyzeRecordsInput,
): Promise<{ stage: AnalysisStage; connections: number; notUnderstood: number }> {
  const limit = input.documentLimit ?? DEFAULT_DOCUMENT_LIMIT;
  const unattached = (await listUnmatchedEvidence(db)) as readonly EvidenceRow[];
  const considered = unattached.slice(0, limit);

  if (considered.length === 0) {
    return {
      stage: {
        name: 'connect_records',
        status: 'done',
        summary: 'Every bill, receipt and message on file is already connected to a payment.',
        recordsTouched: 0,
      },
      connections: 0,
      notUnderstood: 0,
    };
  }

  let connections = 0;
  let unreadable = 0;
  const failures: string[] = [];

  for (const document of considered) {
    try {
      const result = await matchEvidenceContext(db, {
        evidenceId: document.id,
        audit: input.audit,
      });
      if (result.outcome === 'no_observation') unreadable += 1;
      // Proposals only. `services.decideEvidenceMatch` is still the one path to a link, and
      // nothing in this run calls it (ADR-0044).
      connections += result.candidates.filter(
        (candidate) => candidate.status === 'proposed',
      ).length;
    } catch (error) {
      failures.push(messageOf(error));
    }
  }

  const truncated = unattached.length > considered.length;
  const status: AnalysisStageStatus = failures.length > 0 || truncated ? 'partial' : 'done';

  return {
    stage: {
      name: 'connect_records',
      status,
      summary:
        connections === 0
          ? `Looked at ${considered.length} ${considered.length === 1 ? 'document' : 'documents'} and found nothing that matches a payment yet.`
          : `Found ${connections} possible ${connections === 1 ? 'connection' : 'connections'} between a document and a payment.`,
      ...(status === 'done'
        ? {}
        : {
            unfinishedReason: truncated
              ? `${unattached.length - considered.length} more documents were not looked at in ` +
                'this pass. Run it again to continue.'
              : `${failures.length} ${failures.length === 1 ? 'document' : 'documents'} could ` +
                `not be looked at: ${[...new Set(failures)].join('; ')}`,
          }),
      recordsTouched: considered.length,
    },
    connections,
    notUnderstood: unreadable,
  };
}

/* ------------------------------------------------------------------------ internals */

/** An error's message, or a fixed sentence. Never an object a screen would print raw. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/* ------------------------------------------------------------------------ readiness */

export interface AnalysisReadiness {
  /**
   * Payments nobody has read yet — imported and not normalized, **or** normalized and never
   * asked what they were for.
   *
   * Both halves matter, and only the first was counted until an import started reading its own
   * rows. A ledger normalized by an earlier version sat with 120 payments in a state this
   * number called finished: the front page offered nothing to do, reported nothing spent, and
   * said everything was accounted for — over statements whose purpose nothing had ever looked
   * at. "Read" means read, not "moved one state along".
   */
  readonly recordsAwaitingAnalysis: number;
  /**
   * Documents nothing has proposed a home for.
   *
   * Reported, and deliberately **not** what the front page's prompt keys off. A document stays
   * attached to nothing until a person accepts a match or nothing can be read off it at all,
   * and neither is fixed by running the analysis again — so a prompt driven by this number
   * would be permanent, and its button would do nothing new each time. What those documents
   * are is questions, and the attention list is where a question belongs.
   */
  readonly documentsAwaitingAnalysis: number;
}

/**
 * Whether there is anything to analyse.
 *
 * Read separately from the run so a screen can offer the action only when it would do
 * something — and, more importantly, so an Overview can tell "nothing has been spent" apart
 * from "nothing has been read yet", which look identical in a total and are not the same
 * statement at all.
 */
export async function getAnalysisReadiness(db: Executor): Promise<AnalysisReadiness> {
  const [awaiting, awaitingPurpose, unattached] = await Promise.all([
    listPaymentsAwaitingNormalization(db),
    listPaymentsAwaitingClassification(db),
    listUnmatchedEvidence(db),
  ]);

  // Of the normalized rows nothing has proposed anything about, only the ones a reading would
  // *still have something to say about* are waiting.
  //
  // The distinction is what keeps this number from sticking. A line whose wording says nothing,
  // and a tax line the reader deliberately refuses to propose, both stay in
  // `listPaymentsAwaitingClassification` for ever — no inference is written for either, because
  // there is nothing to propose. Counting those as waiting would leave the front page prompting
  // permanently and re-reading the whole ledger on every visit, to do nothing each time.
  //
  // The check is `domain.inferPurpose`, which is pure and local, over rows already in memory.
  // It is the same function the run itself uses, so this number cannot promise a proposal the
  // run would not make.
  //
  // `listPaymentsAwaitingClassification` returns every normalized row and reports whether each
  // already carries a proposal — it does not filter — so both conditions are applied here.
  const context = await loadPurposeContext(db);
  const wouldPropose = (
    awaitingPurpose as readonly (PaymentRow & { hasClassificationInference: boolean })[]
  ).filter(
    (payment) =>
      !payment.hasClassificationInference &&
      readPurposeFor(payment, context).outcome === 'proposal',
  ).length;

  // The two sets are disjoint by construction — normalization moves a row out of the first and
  // into the second — so adding them counts each waiting record exactly once.
  return {
    recordsAwaitingAnalysis: (awaiting as readonly { id: PaymentId }[]).length + wouldPropose,
    documentsAwaitingAnalysis: (unattached as readonly EvidenceRow[]).length,
  };
}

/* ================================================================ preparing, once */

/**
 * The same run, guarded so two callers asking at once get one answer rather than two.
 *
 * Every stage `analyzeRecords` calls is already idempotent — `normalizePayments` acts on
 * `imported` rows only, `classifyPayment` refuses a payment that already carries a proposal,
 * `matchEvidenceContext` returns `unchanged` having written nothing — so running it twice in
 * sequence changes nothing. What that does **not** cover is two runs overlapping: both read
 * "awaiting", both find the same rows, and both write a proposal for each.
 *
 * That is no longer hypothetical, because nobody presses a button any more. An import triggers
 * a run, the screen that opens next may ask for one, a refresh may ask again, and a second tab
 * may be open the whole time. So a run in progress is the run every caller gets.
 *
 * Deliberately a promise held in this module, not a job table: nothing in this process claims a
 * job, and a queue nobody drains would report queued work that never happens. One process, one
 * database, one in-flight run — and after a restart the per-row idempotency is what holds.
 */
let inFlight: Promise<AnalysisResult> | null = null;

export async function prepareRecords(
  db: Database,
  input: AnalyzeRecordsInput,
): Promise<AnalysisResult> {
  // A scoped run and an unscoped one are not interchangeable, so a caller naming a batch waits
  // for the general run to finish and then does its own: joining it could return an answer
  // about records it never asked about.
  if (inFlight !== null && input.importBatchId === undefined) return inFlight;

  const run = (async () => {
    if (inFlight !== null) await inFlight.catch(() => undefined);
    return analyzeRecords(db, input);
  })();

  if (input.importBatchId === undefined) {
    inFlight = run;
    try {
      return await run;
    } finally {
      // Cleared whether it resolved or threw: a failed run must not make every later caller
      // inherit the same failure forever.
      if (inFlight === run) inFlight = null;
    }
  }
  return run;
}

/** Test seam: forgets any in-flight run, so one case cannot leak into the next. */
export function resetPreparationForTests(): void {
  inFlight = null;
}
