/**
 * The Splitwise drift and ghost-debt auditing service (phase 19, ADR-0046).
 *
 * Loads what both ledgers say, hands it to `domain.auditSplitwisePair`, and turns the findings
 * into durable, reviewable rows. Four properties are this file's responsibility rather than the
 * engine's, because all four are about persistence and the outside world:
 *
 *  - **The canonical ledger is read-only here.** Nothing in this file writes a `Payment`,
 *    `Expense`, `ExpenseItem`, `Allocation`, `ExpenseAdjustment` or `Settlement`, and no
 *    obligation or balance is recomputed into storage. An audit explains the ledger; it never
 *    edits it, and it never invents a `Settlement` to make an external figure agree.
 *  - **No external write, ever.** The only port calls are `fetchBalances` and the optional
 *    `fetchLedgerEntries`, both reads. Reviewing a finding does not authorize one either:
 *    re-syncing a `stale` row stays separate, explicitly approved work (ADR-0040/0041).
 *  - **A failed read is an incomplete audit.** Every failure path records what could not be
 *    seen and stops short of the conclusions that needed it. There is no branch here that
 *    turns an unreachable Splitwise into zero findings.
 *  - **A rerun is a rerun.** Findings are matched by `domain.findingFingerprint` and compared
 *    by a digest of their snapshots, so an unchanged rerun writes nothing but a "seen again"
 *    timestamp, and a materially changed one supersedes rather than overwrites — the earlier
 *    row keeps its evidence, its snapshots and its review decision.
 */

import { createHash } from 'node:crypto';

import {
  assessExternalListingCompleteness,
  auditSplitwisePair,
  auditUnobservablePairs,
  computeNetBalance,
  computeObligations,
  findingComparisonSource,
  findingDependsOnExternalRead,
  findingFingerprint,
} from '../domain/index.js';
import type {
  ExpenseId,
  ExternalEntryView,
  ExternalPairObservation,
  LocalSettlementView,
  LocalSyncedExpenseView,
  Paise,
  PersonId,
  ReconciliationRunId,
  SplitwiseAuditFindingDraft,
  SplitwiseAuditFindingId,
  SplitwiseAuditRunId,
  SplitwiseAuditReviewDecision,
  SplitwiseExternalReadStatus,
  UnobservablePairInput,
} from '../domain/index.js';
import {
  getConnectedExternalIntegration,
  getPrimaryUserPerson,
  getSplitwiseAuditFindingById,
  getSplitwiseAuditRunById,
  insertSplitwiseAuditFinding,
  insertSplitwiseAuditRun,
  linkSplitwiseAuditFindingSuccessor,
  listAuditEvents,
  listCurrentSplitwiseAuditFindings,
  listExpenseAdjustmentIds,
  listPersonsWithSplitwiseUserId,
  listRefundBasisByExpense,
  listSettlementsForAudit,
  listSplitwiseAuditFindings,
  listSplitwiseAuditRuns,
  listSplitwiseExpensesPaidByForAudit,
  loadBalanceInput,
  markSplitwiseAuditFindingObserved,
  supersedeSplitwiseAuditFinding,
  updateSplitwiseAuditFindingReview,
  updateSplitwiseAuditRunCounts,
} from '../db/index.js';
import type {
  Database,
  Executor,
  ExternalIntegrationRow,
  ListSplitwiseAuditFindingsFilter,
  SplitwiseAuditFindingRow,
  SplitwiseAuditRunRow,
} from '../db/index.js';
import type { SplitwiseFriendBalance, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { loadCurrentAllocation, resolveAllocationShares } from './loaders.js';

/* ============================================================================ running */

/** `fetchBalances()`'s outcome, when a caller has already paid for it. */
export type PrefetchedSplitwiseBalances =
  | { readonly ok: true; readonly balances: readonly SplitwiseFriendBalance[] }
  | { readonly ok: false; readonly error: string };

export interface RunSplitwiseAuditInput {
  readonly userPersonId: PersonId;
  readonly splitwise: SplitwisePort;
  /** Set when the audit runs as part of a `ReconciliationRun`, so findings can name it. */
  readonly reconciliationRunId?: ReconciliationRunId | null;
  /**
   * `runReconciliation` has already called `fetchBalances()` for its own comparison; reusing
   * the answer keeps one run to one external read rather than asking Splitwise twice for the
   * same figures.
   */
  readonly prefetchedBalances?: PrefetchedSplitwiseBalances | null;
  readonly audit: AuditMeta;
}

export interface RunSplitwiseAuditResult {
  readonly splitwiseAuditRunId: string;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsAudited: number;
  readonly pairsUnchecked: number;
  readonly findingsCreated: number;
  readonly findingsReobserved: number;
  readonly findingsSuperseded: number;
  /** Every finding that is current after this run, newest comparison first. */
  readonly findings: readonly SplitwiseAuditFindingRow[];
}

/**
 * Runs one audit and reconciles its findings against the ones already on record.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when no `User` exists to own an integration.
 */
export async function runSplitwiseAudit(
  db: Database,
  input: RunSplitwiseAuditInput,
): Promise<RunSplitwiseAuditResult> {
  return runAudited(db, input.audit, async ({ exec, record }) =>
    runSplitwiseAuditWithin(exec, record, input),
  );
}

/**
 * The audit itself, inside an already-open audited unit of work.
 *
 * Separated so `services.runReconciliation` can run the audit in its own transaction — one
 * reconciliation, one commit — without nesting `runAudited` inside itself.
 */
export async function runSplitwiseAuditWithin(
  exec: Executor,
  record: AuditContext['record'],
  input: RunSplitwiseAuditInput,
): Promise<RunSplitwiseAuditResult> {
  const integration = await loadConnectedIntegration(exec);

  if (integration === null) {
    return finishRun(exec, record, {
      integration: null,
      reconciliationRunId: input.reconciliationRunId ?? null,
      readStatus: 'skipped',
      readDetail:
        'No Splitwise ExternalIntegration is connected, so nothing external was read. ' +
        'Nothing was compared and nothing is claimed to agree.',
      balancesSnapshot: null,
      drafts: [],
      auditedPairKeys: new Set<string>(),
      completePairKeys: new Set<string>(),
      integrationScopeAudited: false,
      pairsAudited: 0,
      pairsUnchecked: 0,
    });
  }

  const balances = await resolveBalances(input);
  if (!balances.ok) {
    const draft = balancesFailedFinding(balances.error);
    return finishRun(exec, record, {
      integration,
      reconciliationRunId: input.reconciliationRunId ?? null,
      readStatus: 'failed',
      readDetail: balances.error,
      balancesSnapshot: null,
      drafts: [draft],
      auditedPairKeys: new Set<string>(),
      completePairKeys: new Set<string>(),
      integrationScopeAudited: true,
      pairsAudited: 0,
      pairsUnchecked: 0,
    });
  }

  const friends = await listPersonsWithSplitwiseUserId(exec, input.userPersonId);
  const balanceInput = await loadBalanceInput(exec, input.userPersonId);
  const obligations = computeObligations(balanceInput);
  const localExpenses = await listSplitwiseExpensesPaidByForAudit(exec, input.userPersonId);
  const adjustmentIdsByExpense = await listExpenseAdjustmentIds(
    exec,
    localExpenses.map((row) => row.expenseId),
  );
  const refundBasisByExpense = await listRefundBasisByExpense(
    exec,
    localExpenses.map((row) => row.expenseId),
  );

  const theirBalanceByUserId = new Map(
    balances.balances.map((entry) => [entry.splitwiseUserId, entry.netBalance]),
  );

  const drafts: SplitwiseAuditFindingDraft[] = [];
  const auditedPairKeys = new Set<string>();
  const completePairKeys = new Set<string>();
  const pairStatuses: SplitwiseExternalReadStatus[] = [];
  let pairsUnchecked = 0;

  for (const friend of friends) {
    const pairKey = toPairKey(input.userPersonId, friend.id);
    auditedPairKeys.add(pairKey);

    // A friend Splitwise did not report at all is unread, never "reported as settled" — the
    // same distinction phase 15 drew when it skipped them, recorded here as a finding so the
    // gap survives the run rather than vanishing with it.
    const theirNetBalance = theirBalanceByUserId.get(friend.splitwiseUserId) ?? null;
    const external = await readPairEntries(
      input.splitwise,
      friend.splitwiseUserId,
      theirNetBalance,
    );

    pairStatuses.push(external.status);
    if (external.status === 'complete') completePairKeys.add(pairKey);
    if (theirNetBalance === null || external.status === 'failed') pairsUnchecked += 1;

    const expenseViews = await buildExpenseViews(exec, {
      friendPersonId: friend.id,
      friendSplitwiseUserId: friend.splitwiseUserId,
      rows: localExpenses,
      adjustmentIdsByExpense,
      refundBasisByExpense,
    });
    const settlementViews = await buildSettlementViews(exec, friend.id);
    const crossPayer = summariseCrossPayerObligations(obligations, input.userPersonId, friend.id);

    drafts.push(
      ...auditSplitwisePair({
        userPersonId: input.userPersonId,
        friendPersonId: friend.id,
        friendSplitwiseUserId: friend.splitwiseUserId,
        ourNetBalance: computeNetBalance(balanceInput, input.userPersonId, friend.id),
        theirNetBalance,
        expenses: expenseViews,
        settlements: settlementViews,
        crossPayerObligationTotal: crossPayer.total,
        crossPayerExpenseCount: crossPayer.expenseCount,
        external,
      }),
    );
  }

  const unobservable = collectUnobservablePairs(balanceInput, obligations, input.userPersonId);
  for (const pair of unobservable) auditedPairKeys.add(toPairKey(pair.personAId, pair.personBId));
  drafts.push(...auditUnobservablePairs(unobservable));

  return finishRun(exec, record, {
    integration,
    reconciliationRunId: input.reconciliationRunId ?? null,
    readStatus: worstReadStatus(pairStatuses),
    readDetail: firstIncompleteDetail(drafts),
    balancesSnapshot: balances.balances.map((entry) => ({
      splitwiseUserId: entry.splitwiseUserId,
      netBalance: entry.netBalance.toString(),
    })),
    drafts,
    auditedPairKeys,
    completePairKeys,
    integrationScopeAudited: true,
    pairsAudited: friends.length + unobservable.length,
    pairsUnchecked,
  });
}

/* ============================================================================ reading */

/** Audit history, newest first. */
export async function listSplitwiseAuditRunHistory(
  db: Executor,
  options: { readonly limit?: number } = {},
): Promise<readonly SplitwiseAuditRunRow[]> {
  return listSplitwiseAuditRuns(db, options);
}

export interface SplitwiseAuditRunDetail {
  readonly run: SplitwiseAuditRunRow;
  readonly findings: readonly SplitwiseAuditFindingRow[];
}

/** One audit run and the findings it first produced. */
export async function getSplitwiseAuditRun(
  db: Executor,
  auditRunId: SplitwiseAuditRunId,
): Promise<SplitwiseAuditRunDetail | null> {
  const run = await getSplitwiseAuditRunById(db, auditRunId);
  if (run === null) return null;
  const findings = await listSplitwiseAuditFindings(db, {
    auditRunId,
    includeSuperseded: true,
    limit: 500,
  });
  return { run, findings };
}

/** Findings, filtered. Superseded rows are history and stay out unless asked for. */
export async function listAuditFindings(
  db: Executor,
  filter: ListSplitwiseAuditFindingsFilter = {},
): Promise<readonly SplitwiseAuditFindingRow[]> {
  return listSplitwiseAuditFindings(db, filter);
}

export interface SplitwiseAuditFindingDetail {
  readonly finding: SplitwiseAuditFindingRow;
  /**
   * Every recorded act on this finding, oldest first — its creation, any supersession, and
   * each review decision with actor, time and reason. Read from `audit_events`, which is
   * append-only by construction (`invariants.md` #22), so nothing here can rewrite it.
   */
  readonly history: Awaited<ReturnType<typeof listAuditEvents>>;
}

/** One finding in full, with its review/resolution history. */
export async function getAuditFinding(
  db: Executor,
  findingId: SplitwiseAuditFindingId,
): Promise<SplitwiseAuditFindingDetail | null> {
  const finding = await getSplitwiseAuditFindingById(db, findingId);
  if (finding === null) return null;
  const history = await listAuditEvents(db, 'splitwise_audit_finding', finding.id);
  return { finding, history };
}

/* =========================================================================== reviewing */

export interface ReviewSplitwiseAuditFindingInput {
  readonly findingId: SplitwiseAuditFindingId;
  readonly decision: SplitwiseAuditReviewDecision;
  /** Required for `resolved`/`dismissed`: a conclusion without a reason is not reviewable. */
  readonly reason?: string | null;
  readonly audit: AuditMeta;
}

export interface ReviewSplitwiseAuditFindingResult {
  readonly findingId: string;
  readonly reviewStatus: SplitwiseAuditReviewDecision;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

/**
 * Records a person's decision about one finding.
 *
 * Deliberately narrow. It writes the finding's own review columns and one `AuditEvent`, and
 * touches nothing else: not the ledger, not the finding's evidence or snapshots, and not
 * Splitwise. Accepting a finding is a statement about what a person concluded, never an
 * instruction to change either ledger — a corrective re-sync remains its own approved
 * operation (ADR-0040/0041, ADR-0046).
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when the finding does not exist.
 * @throws ServiceError `PRECONDITION_FAILED` when it has been superseded, or when a
 *   `resolved`/`dismissed` decision arrives with no reason.
 */
export async function reviewSplitwiseAuditFinding(
  db: Database,
  input: ReviewSplitwiseAuditFindingInput,
): Promise<ReviewSplitwiseAuditFindingResult> {
  const reason = input.reason ?? null;
  if ((input.decision === 'resolved' || input.decision === 'dismissed') && reason === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `A "${input.decision}" decision must record why. A finding closed with no stated reason ` +
        'cannot be reviewed later by anyone, including the person who closed it.',
      { findingId: input.findingId, decision: input.decision },
    );
  }
  if (!input.audit.actor.startsWith('user')) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `"${input.audit.actor}" cannot review an audit finding. Reviewing is a person's decision ` +
        '(invariants.md #17) — never a rule, a model or the system itself.',
      { findingId: input.findingId, actor: input.audit.actor },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const finding = await getSplitwiseAuditFindingById(exec, input.findingId);
    if (finding === null) {
      throw new ServiceError(
        'ENTITY_NOT_FOUND',
        `No Splitwise audit finding with id ${input.findingId}.`,
        { findingId: input.findingId },
      );
    }
    if (finding.supersededAt !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Finding ${finding.id} has been superseded (${finding.supersedeReason}) and is history. ` +
          'Review the finding that replaced it; the record of this one stays exactly as it was.',
        { findingId: finding.id, supersedeReason: finding.supersedeReason ?? 'unknown' },
      );
    }

    const reviewedAt = new Date();
    await updateSplitwiseAuditFindingReview(exec, finding.id, {
      reviewStatus: input.decision,
      reviewedAt,
      reviewedBy: input.audit.actor,
      reviewReason: reason,
    });

    await record({
      entityType: 'splitwise_audit_finding',
      entityId: finding.id,
      action: 'update',
      oldValue: {
        reviewStatus: finding.reviewStatus,
        reviewedBy: finding.reviewedBy,
        reviewedAt: finding.reviewedAt?.toISOString() ?? null,
        reviewReason: finding.reviewReason,
      },
      newValue: {
        reviewStatus: input.decision,
        reviewedBy: input.audit.actor,
        reviewedAt: reviewedAt.toISOString(),
        reviewReason: reason,
        externalWriteAuthorized: false,
      },
      reason,
    });

    return {
      findingId: finding.id,
      reviewStatus: input.decision,
      reviewedBy: input.audit.actor,
      reviewedAt,
    };
  });
}

/* ========================================================================== internals */

async function loadConnectedIntegration(exec: Executor): Promise<ExternalIntegrationRow | null> {
  const ownerUser = await getPrimaryUserPerson(exec);
  if (ownerUser === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'No User exists, so there is no Splitwise integration to audit against ' +
        '(domain-model.md: a User maps to exactly one Person).',
    );
  }
  return getConnectedExternalIntegration(exec, ownerUser.userId, 'splitwise');
}

async function resolveBalances(
  input: RunSplitwiseAuditInput,
): Promise<
  { ok: true; balances: readonly SplitwiseFriendBalance[] } | { ok: false; error: string }
> {
  if (input.prefetchedBalances != null) {
    return input.prefetchedBalances.ok
      ? { ok: true, balances: input.prefetchedBalances.balances }
      : { ok: false, error: input.prefetchedBalances.error };
  }
  try {
    return { ok: true, balances: await input.splitwise.fetchBalances() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads one pair's entries, and records honestly how much of them arrived.
 *
 * A port with no `fetchLedgerEntries` is `unsupported`, not empty: an adapter that cannot list
 * entries has told us nothing about them, and treating its silence as "Splitwise holds none"
 * would manufacture a missing-expense finding for every row this ledger ever synced.
 */
async function readPairEntries(
  splitwise: SplitwisePort,
  friendSplitwiseUserId: string,
  theirNetBalance: Paise | null,
): Promise<ExternalPairObservation> {
  if (typeof splitwise.fetchLedgerEntries !== 'function') {
    return {
      status: 'unsupported',
      detail: 'the configured SplitwisePort does not implement fetchLedgerEntries',
      entries: [],
    };
  }

  let result;
  try {
    result = await splitwise.fetchLedgerEntries({ friendSplitwiseUserId });
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      entries: [],
    };
  }

  const entries: ExternalEntryView[] = result.entries.map((entry) => ({
    externalId: entry.splitwiseEntryId,
    kind: entry.kind,
    description: entry.description,
    totalAmount: entry.totalAmount,
    deleted: entry.deleted,
    occurredAt: entry.occurredAt,
    pairNetBalance: entry.pairNetBalance,
  }));

  return assessExternalListingCompleteness(
    {
      status: result.complete ? 'complete' : 'partial',
      detail: result.incompleteReason ?? null,
      entries,
    },
    theirNetBalance,
  );
}

async function buildExpenseViews(
  exec: Executor,
  input: {
    readonly friendPersonId: PersonId;
    readonly friendSplitwiseUserId: string;
    readonly rows: Awaited<ReturnType<typeof listSplitwiseExpensesPaidByForAudit>>;
    readonly adjustmentIdsByExpense: Awaited<ReturnType<typeof listExpenseAdjustmentIds>>;
    readonly refundBasisByExpense: Awaited<ReturnType<typeof listRefundBasisByExpense>>;
  },
): Promise<readonly LocalSyncedExpenseView[]> {
  const views: LocalSyncedExpenseView[] = [];

  for (const row of input.rows) {
    // The current allocation is already refund-aware after phase 18 (ADR-0045); the audit
    // reads its figures rather than recomputing a net share of its own, because there is
    // exactly one allocation engine in this codebase and this is not it.
    const current = await loadCurrentAllocation(exec, row.expenseId);
    const shares = current === null ? [] : resolveAllocationShares(current);
    const friendShareNow = shares
      .filter((share) => share.beneficiaryId === input.friendPersonId)
      .reduce((total, share) => total + share.amount, 0n) as Paise;

    // Only rows the friend actually participates in belong to this pair's audit — except a
    // fully refunded one, whose zero-valued line (ADR-0013) is exactly the case that must
    // still be compared.
    const participates =
      friendShareNow !== 0n ||
      shares.some((share) => share.beneficiaryId === input.friendPersonId) ||
      snapshotShareFor(row.ourSnapshot, input.friendSplitwiseUserId) !== null;
    if (!participates) continue;

    views.push({
      splitwiseExpenseRowId: row.id,
      expenseId: row.expenseId,
      externalId: row.splitwiseExpenseId,
      syncStatus: row.syncStatus,
      description: row.description,
      friendShareAtSync: snapshotShareFor(row.ourSnapshot, input.friendSplitwiseUserId),
      friendShareNow,
      expenseGrossAmount: row.grossAmount,
      expenseNetAmount: row.netAmount,
      refundBasis: input.refundBasisByExpense.get(row.expenseId) ?? 'none',
      refundedTotal: row.refundedTotal,
      adjustmentIds: input.adjustmentIdsByExpense.get(row.expenseId) ?? [],
    });
  }
  return views;
}

async function buildSettlementViews(
  exec: Executor,
  friendPersonId: PersonId,
): Promise<readonly LocalSettlementView[]> {
  const rows = await listSettlementsForAudit(exec, friendPersonId);
  return rows.map((row) => ({
    settlementId: row.settlementId,
    amount: row.amount,
    direction: row.direction,
    occurredAt: row.occurredAt,
    splitwiseSettlementRowId: row.splitwiseSettlementRowId,
    externalId: row.externalId,
    syncStatus: row.syncStatus,
  }));
}

/**
 * Reads the friend's share out of the payload this ledger actually sent.
 *
 * `our_snapshot` is stored as JSON with money as exact decimal strings, so this parses rather
 * than casts, and returns `null` — not zero — when the share is not in there. An absent
 * snapshot share is unknown, and the engine says "medium confidence" about it rather than
 * pretending the friend was sent nothing.
 */
function snapshotShareFor(snapshot: unknown, splitwiseUserId: string): Paise | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const shares = (snapshot as { shares?: unknown }).shares;
  if (!Array.isArray(shares)) return null;

  let total: bigint | null = null;
  for (const entry of shares) {
    if (typeof entry !== 'object' || entry === null) continue;
    const share = entry as { splitwiseUserId?: unknown; owedAmount?: unknown };
    if (share.splitwiseUserId !== splitwiseUserId) continue;
    if (typeof share.owedAmount !== 'string' || !/^-?\d+$/.test(share.owedAmount)) continue;
    total = (total ?? 0n) + BigInt(share.owedAmount);
  }
  return total === null ? null : (total as Paise);
}

function summariseCrossPayerObligations(
  obligations: ReturnType<typeof computeObligations>,
  userPersonId: PersonId,
  friendPersonId: PersonId,
): { readonly total: Paise; readonly expenseCount: number } {
  const relevant = obligations.filter(
    (obligation) =>
      obligation.debtorId === userPersonId && obligation.creditorId === friendPersonId,
  );
  const expenseIds = new Set<ExpenseId>(relevant.map((obligation) => obligation.expenseId));
  const total = relevant.reduce((sum, obligation) => sum + obligation.amount, 0n) as Paise;
  return { total, expenseCount: expenseIds.size };
}

/**
 * Every pair with a live obligation that the user is not half of.
 *
 * `fetchBalances()` reports the connected account's own friends, so these pairs have no
 * external side at all to compare against — a permanent boundary (`invariants.md` #9b), not a
 * gap a wider read could close.
 */
function collectUnobservablePairs(
  balanceInput: Parameters<typeof computeNetBalance>[0],
  obligations: ReturnType<typeof computeObligations>,
  userPersonId: PersonId,
): readonly UnobservablePairInput[] {
  const pairs = new Map<string, { a: PersonId; b: PersonId; expenses: Set<ExpenseId> }>();

  for (const obligation of obligations) {
    if (obligation.debtorId === userPersonId || obligation.creditorId === userPersonId) continue;
    const [a, b] =
      obligation.debtorId < obligation.creditorId
        ? [obligation.debtorId, obligation.creditorId]
        : [obligation.creditorId, obligation.debtorId];
    const key = toPairKey(a, b);
    const bucket = pairs.get(key) ?? { a, b, expenses: new Set<ExpenseId>() };
    bucket.expenses.add(obligation.expenseId);
    pairs.set(key, bucket);
  }

  return [...pairs.values()].map((pair) => ({
    personAId: pair.a,
    personBId: pair.b,
    netBalance: computeNetBalance(balanceInput, pair.a, pair.b),
    expenseCount: pair.expenses.size,
  }));
}

function balancesFailedFinding(error: string): SplitwiseAuditFindingDraft {
  return {
    kind: 'external_read_failed',
    findingClass: 'incomplete',
    scope: 'integration',
    summary:
      `SplitwisePort.fetchBalances() failed, so no pair was compared this run: ${error}. This ` +
      'is an incomplete audit, not a clean one — nothing here says the two ledgers agree.',
    confidence: 'unknown',
    amount: null,
    balanceImpact: 0n as Paise,
    personAId: null,
    personBId: null,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    localSnapshot: { comparisonsRun: 0 },
    externalSnapshot: { readStatus: 'failed', error },
    evidence: [],
  };
}

interface FinishRunInput {
  readonly integration: ExternalIntegrationRow | null;
  readonly reconciliationRunId: ReconciliationRunId | null;
  readonly readStatus: SplitwiseExternalReadStatus;
  readonly readDetail: string | null;
  readonly balancesSnapshot: unknown;
  readonly drafts: readonly SplitwiseAuditFindingDraft[];
  readonly auditedPairKeys: ReadonlySet<string>;
  readonly completePairKeys: ReadonlySet<string>;
  readonly integrationScopeAudited: boolean;
  readonly pairsAudited: number;
  readonly pairsUnchecked: number;
}

/** Writes the run row, reconciles its findings against the record, and reports the tallies. */
async function finishRun(
  exec: Executor,
  record: AuditContext['record'],
  input: FinishRunInput,
): Promise<RunSplitwiseAuditResult> {
  const auditRunId = await insertSplitwiseAuditRun(exec, {
    reconciliationRunId: input.reconciliationRunId,
    externalIntegrationId: input.integration?.id ?? null,
    externalReadStatus: input.readStatus,
    externalReadDetail: input.readDetail,
    pairsAudited: input.pairsAudited,
    pairsUnchecked: input.pairsUnchecked,
    externalBalancesSnapshot: input.balancesSnapshot,
  });

  const tallies = await reconcileFindings(exec, record, {
    auditRunId,
    reconciliationRunId: input.reconciliationRunId,
    drafts: input.drafts,
    auditedPairKeys: input.auditedPairKeys,
    completePairKeys: input.completePairKeys,
    integrationScopeAudited: input.integrationScopeAudited,
  });

  await updateSplitwiseAuditRunCounts(exec, auditRunId, tallies);
  await record({
    entityType: 'splitwise_audit_run',
    entityId: auditRunId,
    action: 'create',
    newValue: {
      externalReadStatus: input.readStatus,
      externalReadDetail: input.readDetail,
      pairsAudited: input.pairsAudited,
      pairsUnchecked: input.pairsUnchecked,
      reconciliationRunId: input.reconciliationRunId,
      findingsCreated: tallies.findingsCreated,
      findingsReobserved: tallies.findingsReobserved,
      findingsSuperseded: tallies.findingsSuperseded,
    },
  });

  return {
    splitwiseAuditRunId: auditRunId,
    externalReadStatus: input.readStatus,
    externalReadDetail: input.readDetail,
    pairsAudited: input.pairsAudited,
    pairsUnchecked: input.pairsUnchecked,
    ...tallies,
    findings: await listSplitwiseAuditFindings(exec, { limit: 500 }),
  };
}

interface ReconcileTallies {
  readonly findingsCreated: number;
  readonly findingsReobserved: number;
  readonly findingsSuperseded: number;
}

/**
 * Matches this run's findings against the ones already on record.
 *
 * Three outcomes, and the shape of each is the whole idempotency contract:
 *
 *  - **The same comparison again** — only "seen again" is written. No new row, no audit event.
 *  - **A materially different comparison** — the standing row is superseded, naming the new
 *    row that replaces it, and the new one is inserted. Nothing is edited in place, so the
 *    earlier snapshots, evidence and review decision survive exactly as recorded.
 *  - **A finding this run did not reproduce** — closed as `no_longer_observed`, but only when
 *    this run actually had the standing to re-derive it: the pair was audited, and, for a
 *    finding that needed Splitwise's own entries, the read for that pair was complete. A
 *    finding is never retired by a read that failed.
 */
async function reconcileFindings(
  exec: Executor,
  record: AuditContext['record'],
  input: {
    readonly auditRunId: SplitwiseAuditRunId;
    readonly reconciliationRunId: ReconciliationRunId | null;
    readonly drafts: readonly SplitwiseAuditFindingDraft[];
    readonly auditedPairKeys: ReadonlySet<string>;
    readonly completePairKeys: ReadonlySet<string>;
    readonly integrationScopeAudited: boolean;
  },
): Promise<ReconcileTallies> {
  const existing = await listCurrentSplitwiseAuditFindings(exec);
  const existingByFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const seenFingerprints = new Set<string>();

  let findingsCreated = 0;
  let findingsReobserved = 0;
  let findingsSuperseded = 0;

  for (const draft of input.drafts) {
    const fingerprint = findingFingerprint(draft);
    if (seenFingerprints.has(fingerprint)) continue;
    seenFingerprints.add(fingerprint);

    const comparisonDigest = digestOf(draft);
    const standing = existingByFingerprint.get(fingerprint);

    if (standing !== undefined && standing.comparisonDigest === comparisonDigest) {
      await markSplitwiseAuditFindingObserved(exec, standing.id, input.auditRunId);
      findingsReobserved += 1;
      continue;
    }

    // Supersede before inserting: the "one current row per fingerprint" unique index is
    // partial on `superseded_at is null`, and it is doing real work here rather than
    // documenting an intention.
    if (standing !== undefined) {
      await supersedeSplitwiseAuditFinding(exec, standing.id, 'materially_changed');
      findingsSuperseded += 1;
    }

    const findingId = await insertSplitwiseAuditFinding(exec, {
      auditRunId: input.auditRunId,
      reconciliationRunId: input.reconciliationRunId,
      kind: draft.kind,
      findingClass: draft.findingClass,
      scope: draft.scope,
      summary: draft.summary,
      confidence: draft.confidence,
      amount: draft.amount,
      balanceImpact: draft.balanceImpact,
      personAId: draft.personAId,
      personBId: draft.personBId,
      expenseId: draft.expenseId,
      splitwiseExpenseRowId: draft.splitwiseExpenseRowId,
      settlementId: draft.settlementId,
      splitwiseSettlementRowId: draft.splitwiseSettlementRowId,
      externalReference: draft.externalReference,
      localSnapshot: draft.localSnapshot,
      externalSnapshot: draft.externalSnapshot,
      evidence: draft.evidence,
      fingerprint,
      comparisonDigest,
    });
    findingsCreated += 1;

    if (standing !== undefined) {
      await linkSplitwiseAuditFindingSuccessor(exec, standing.id, findingId);
      await record({
        entityType: 'splitwise_audit_finding',
        entityId: standing.id,
        action: 'supersede',
        oldValue: { comparisonDigest: standing.comparisonDigest, summary: standing.summary },
        newValue: {
          supersedeReason: 'materially_changed',
          supersededByFindingId: findingId,
          reviewStatusPreserved: standing.reviewStatus,
        },
      });
    }

    await record({
      entityType: 'splitwise_audit_finding',
      entityId: findingId,
      action: 'create',
      newValue: {
        kind: draft.kind,
        findingClass: draft.findingClass,
        scope: draft.scope,
        confidence: draft.confidence,
        amount: draft.amount === null ? null : draft.amount.toString(),
        balanceImpact: draft.balanceImpact.toString(),
        externalReference: draft.externalReference,
        supersedes: standing?.id ?? null,
      },
    });
  }

  for (const row of existing) {
    if (seenFingerprints.has(row.fingerprint)) continue;
    if (!canRetire(row, input)) continue;

    await supersedeSplitwiseAuditFinding(exec, row.id, 'no_longer_observed');
    findingsSuperseded += 1;
    await record({
      entityType: 'splitwise_audit_finding',
      entityId: row.id,
      action: 'supersede',
      oldValue: { kind: row.kind, summary: row.summary, reviewStatus: row.reviewStatus },
      newValue: { supersedeReason: 'no_longer_observed', auditRunId: input.auditRunId },
    });
  }

  return { findingsCreated, findingsReobserved, findingsSuperseded };
}

/** Whether this run saw enough to say a standing finding no longer holds. */
function canRetire(
  row: SplitwiseAuditFindingRow,
  input: {
    readonly auditedPairKeys: ReadonlySet<string>;
    readonly completePairKeys: ReadonlySet<string>;
    readonly integrationScopeAudited: boolean;
  },
): boolean {
  if (row.scope === 'integration') return input.integrationScopeAudited;
  if (row.personAId === null || row.personBId === null) return false;

  const pairKey = toPairKey(row.personAId, row.personBId);
  if (!input.auditedPairKeys.has(pairKey)) return false;
  if (!findingDependsOnExternalRead(row.kind)) return true;
  return input.completePairKeys.has(pairKey);
}

function digestOf(draft: SplitwiseAuditFindingDraft): string {
  return createHash('sha256').update(findingComparisonSource(draft)).digest('hex');
}

function toPairKey(a: PersonId, b: PersonId): string {
  return `${a}|${b}`;
}

/** The worst status across every pair — one clean pair never speaks for an unread one. */
function worstReadStatus(
  statuses: readonly SplitwiseExternalReadStatus[],
): SplitwiseExternalReadStatus {
  const ranking: readonly SplitwiseExternalReadStatus[] = [
    'failed',
    'unsupported',
    'partial',
    'skipped',
    'complete',
  ];
  for (const candidate of ranking) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'complete';
}

function firstIncompleteDetail(drafts: readonly SplitwiseAuditFindingDraft[]): string | null {
  const incomplete = drafts.find((draft) => draft.findingClass === 'incomplete');
  return incomplete?.summary ?? null;
}
