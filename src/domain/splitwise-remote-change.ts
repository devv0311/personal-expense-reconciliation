/**
 * Comparing what Splitwise now holds against what this ledger recorded sending it, and turning
 * every difference into a **proposal a person decides about** (audit row 40, ADR-0056).
 *
 * This module is where "bidirectional" is made safe. Nothing here produces a figure, a
 * correction or an instruction: it produces a description of a disagreement, with both sides
 * recorded as snapshots, and the one bounded thing accepting it would write. The rules it
 * enforces are three:
 *
 *  - **Their number never becomes ours.** Not in this file, not in the service that calls it.
 *    A change says what Splitwise holds; making that true here is a person recording an
 *    `ExpenseAdjustment` with evidence, under `invariants.md` #6.
 *  - **Absence proves nothing under an incomplete read.** A deletion is only ever reported from
 *    a `complete` listing for the pair. Under `partial`/`failed`/`unsupported` the run keeps
 *    its positive observations — an entry seen with a different figure *was* seen — and reports
 *    nothing as missing. ADR-0046's rule, running in the other direction.
 *  - **Nothing here is an inference.** Every kind is a deterministic comparison of two recorded
 *    figures. There is no model on this path and no confidence level; "proposal" means awaiting
 *    a decision, not produced by one.
 *
 * Deterministic, like `auditSplitwisePair`: the same inputs produce the same changes in the
 * same order, which is what lets the service recognise a re-run as a re-run.
 */

import { canonicalJson } from './splitwise-audit.js';
import type {
  PaymentDirection,
  SplitwiseExpenseSyncStatus,
  SplitwiseExternalReadStatus,
  SplitwiseRemoteChangeEffect,
  SplitwiseRemoteChangeKind,
  SplitwiseSettlementSyncStatus,
} from './enums.js';
import type {
  ExpenseId,
  PersonId,
  SettlementId,
  SplitwiseExpenseId,
  SplitwiseSettlementId,
} from './ids.js';
import type { Paise } from './money.js';

/* ============================================================================== inputs */

/** One `SplitwiseExpense` link this ledger holds, as change discovery reads it. */
export interface LinkedExpenseView {
  readonly splitwiseExpenseRowId: SplitwiseExpenseId;
  readonly expenseId: ExpenseId;
  /** Splitwise's own id for the entry, as this ledger recorded it. */
  readonly externalId: string;
  readonly syncStatus: SplitwiseExpenseSyncStatus;
  readonly description: string | null;
  /** The expense's current net — what this ledger says the entry should be worth. */
  readonly expenseNetAmount: Paise;
  /** The total in the payload this ledger last sent. `null` when the snapshot lacks one. */
  readonly syncedAmount: Paise | null;
}

/** One `SplitwiseSettlement` link this ledger holds. */
export interface LinkedSettlementView {
  readonly splitwiseSettlementRowId: SplitwiseSettlementId;
  readonly settlementId: SettlementId;
  readonly externalId: string;
  readonly syncStatus: SplitwiseSettlementSyncStatus;
  readonly amount: Paise;
  /** `debit`: the user paid the friend. `credit`: the friend paid the user. */
  readonly direction: PaymentDirection;
}

/** One entry Splitwise currently reports for the pair. */
export interface RemoteEntryView {
  readonly externalId: string;
  readonly kind: 'expense' | 'payment';
  readonly description: string | null;
  readonly totalAmount: Paise;
  readonly deleted: boolean;
  readonly occurredAt: Date | null;
  /** Positive means the user owes the friend — `computeNetBalance`'s convention throughout. */
  readonly pairNetBalance: Paise;
}

/** What the external read produced for one pair, and how much of it can be relied on. */
export interface RemotePairObservation {
  readonly status: SplitwiseExternalReadStatus;
  /** Why the read is not `complete`, when it is not. Recorded verbatim on every change. */
  readonly detail: string | null;
  readonly entries: readonly RemoteEntryView[];
}

export interface DiscoverRemoteChangesInput {
  readonly userPersonId: PersonId;
  readonly friendPersonId: PersonId;
  readonly friendSplitwiseUserId: string;
  readonly friendDisplayName: string;
  readonly linkedExpenses: readonly LinkedExpenseView[];
  readonly linkedSettlements: readonly LinkedSettlementView[];
  readonly external: RemotePairObservation;
}

/** A Splitwise account the connected user is friends with and this ledger maps to nobody. */
export interface UnmappedSplitwiseUser {
  readonly splitwiseUserId: string;
  /** What Splitwise currently reports owing them, so the size of the gap is visible. */
  readonly reportedNetBalance: Paise;
}

/* ============================================================================= outputs */

/** A pointer to the record a change is about — never a copy of it. */
export interface RemoteChangeSubjectRef {
  readonly type:
    | 'expense'
    | 'settlement'
    | 'splitwise_expense'
    | 'splitwise_settlement'
    | 'external_entry'
    | 'splitwise_user';
  readonly id: string;
  readonly note?: string;
}

/**
 * One discovered change, before it is given an id and written down.
 *
 * `consequence` is prose, composed here rather than by whoever renders it: a surface has to
 * state what accepting will do before a person confirms it, and working that out in the browser
 * would be a second copy of a rule that must agree with the service forever (ADR-0048).
 */
export interface SplitwiseRemoteChangeDraft {
  readonly kind: SplitwiseRemoteChangeKind;
  readonly effect: SplitwiseRemoteChangeEffect;
  readonly summary: string;
  readonly consequence: string;
  /** The read this observation came from — never summarised away into "fine". */
  readonly readStatus: SplitwiseExternalReadStatus;
  readonly readDetail: string | null;
  readonly personAId: PersonId | null;
  readonly personBId: PersonId | null;
  readonly expenseId: ExpenseId | null;
  readonly splitwiseExpenseRowId: SplitwiseExpenseId | null;
  readonly settlementId: SettlementId | null;
  readonly splitwiseSettlementRowId: SplitwiseSettlementId | null;
  /** Splitwise's own id for the entry this is about, when there is one. */
  readonly externalReference: string | null;
  /** The Splitwise account this is about, for a mapping change. */
  readonly externalUserReference: string | null;
  /** The magnitude the change is about, or `null` when it is not about an amount. */
  readonly amount: Paise | null;
  /** What this ledger held at comparison time. */
  readonly localSnapshot: Readonly<Record<string, unknown>>;
  /** What Splitwise reported, uninterpreted. `null` when the read produced nothing. */
  readonly remoteSnapshot: Readonly<Record<string, unknown>> | null;
  readonly subjects: readonly RemoteChangeSubjectRef[];
}

/* ========================================================================== the engine */

/**
 * Which local write accepting a change performs. A closed mapping, and the only one.
 *
 * Deliberately a function of the kind alone: the effect must not depend on the figures, or a
 * screen could quote one consequence while the service performed another.
 */
export function remoteChangeEffect(kind: SplitwiseRemoteChangeKind): SplitwiseRemoteChangeEffect {
  switch (kind) {
    case 'remote_expense_amount_changed':
    case 'remote_settlement_amount_changed':
      return 'record_drift';
    case 'remote_expense_deleted':
    case 'remote_settlement_deleted':
      return 'record_external_deletion';
    case 'remote_expense_unlinked':
      return 'adopt_expense_link';
    case 'remote_settlement_unlinked':
      return 'adopt_settlement_link';
    case 'remote_person_unmapped':
      return 'map_person';
    case 'remote_duplicate_candidate':
      return 'none';
  }
}

/** True when a kind's acceptance needs the caller to name the local record to join to. */
export function remoteChangeNeedsTarget(kind: SplitwiseRemoteChangeKind): boolean {
  const effect = remoteChangeEffect(kind);
  return (
    effect === 'adopt_expense_link' || effect === 'adopt_settlement_link' || effect === 'map_person'
  );
}

/**
 * True when this kind may only be produced from a listing that saw the whole pair.
 *
 * Every absence-based conclusion. An entry missing from a page is an entry nobody looked for,
 * and proposing its deletion would be inventing somebody else's act out of a page boundary.
 */
export function remoteChangeRequiresCompleteRead(kind: SplitwiseRemoteChangeKind): boolean {
  return kind === 'remote_expense_deleted' || kind === 'remote_settlement_deleted';
}

/**
 * Discovers every change one pair's external listing supports.
 *
 * @remarks Sync rows in a state that asserts nothing standing in Splitwise — `pending`,
 * `sync_failed`, `withdrawn`, `externally_deleted` — are skipped: there is no live entry to
 * compare, and reporting one as deleted again would propose the same act twice.
 */
export function discoverRemoteChanges(
  input: DiscoverRemoteChangesInput,
): readonly SplitwiseRemoteChangeDraft[] {
  const drafts: SplitwiseRemoteChangeDraft[] = [];
  const complete = input.external.status === 'complete';
  const byExternalId = new Map(input.external.entries.map((entry) => [entry.externalId, entry]));
  const claimedExternalIds = new Set<string>();

  for (const link of input.linkedExpenses) {
    if (!assertsALiveEntry(link.syncStatus)) continue;
    claimedExternalIds.add(link.externalId);
    const remote = byExternalId.get(link.externalId);

    if (remote === undefined || remote.deleted) {
      // Absent from a partial page is not gone. Only a complete listing can say that, and a
      // remote row explicitly flagged `deleted` says it regardless of how much was read.
      if (remote === undefined && !complete) continue;
      drafts.push(deletedExpenseDraft(input, link, remote ?? null));
      continue;
    }

    const theirs = remote.totalAmount;
    const ours = link.syncedAmount ?? link.expenseNetAmount;
    if (theirs !== ours) drafts.push(changedExpenseDraft(input, link, remote));
  }

  for (const link of input.linkedSettlements) {
    if (!assertsALiveSettlement(link.syncStatus)) continue;
    claimedExternalIds.add(link.externalId);
    const remote = byExternalId.get(link.externalId);

    if (remote === undefined || remote.deleted) {
      if (remote === undefined && !complete) continue;
      drafts.push(deletedSettlementDraft(input, link, remote ?? null));
      continue;
    }
    if (remote.totalAmount !== link.amount) {
      drafts.push(changedSettlementDraft(input, link, remote));
    }
  }

  const unlinked = input.external.entries.filter(
    (entry) => !entry.deleted && !claimedExternalIds.has(entry.externalId),
  );
  for (const entry of unlinked) {
    drafts.push(unlinkedDraft(input, entry));
  }
  drafts.push(...duplicateCandidateDrafts(input, unlinked));

  return drafts;
}

/**
 * The mapping half: a Splitwise account this ledger has no `Person` for.
 *
 * Separate from the pair walk above because it is what makes that walk possible at all —
 * an unmapped account has no pair to read, so every comparison involving it is missing rather
 * than agreeing, and saying so in terms somebody can act on is the whole point.
 */
export function discoverUnmappedPeople(
  users: readonly UnmappedSplitwiseUser[],
  readStatus: SplitwiseExternalReadStatus,
  readDetail: string | null,
): readonly SplitwiseRemoteChangeDraft[] {
  return users.map((user) => ({
    kind: 'remote_person_unmapped' as const,
    effect: remoteChangeEffect('remote_person_unmapped'),
    summary:
      `Splitwise account ${user.splitwiseUserId} is a friend of the connected account and no ` +
      'person in this ledger is mapped to it.',
    consequence:
      'Accepting maps this Splitwise account onto a person you name. It writes that person’s ' +
      'splitwise_user_id and nothing else — no expense, no settlement and no balance changes — ' +
      'and it does not create a person: who somebody is, is master data you enter, never ' +
      'something a friends list decides. Until it is mapped, every comparison involving them ' +
      'is an unread gap rather than agreement.',
    readStatus,
    readDetail,
    personAId: null,
    personBId: null,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: null,
    externalUserReference: user.splitwiseUserId,
    amount: null,
    localSnapshot: { mappedPersonId: null },
    remoteSnapshot: {
      splitwiseUserId: user.splitwiseUserId,
      reportedNetBalance: user.reportedNetBalance.toString(),
    },
    subjects: [{ type: 'splitwise_user' as const, id: user.splitwiseUserId }],
  }));
}

/* ============================================================ identity and materiality */

/**
 * The stable identity of a change across discovery runs.
 *
 * Excludes every amount, exactly as `findingFingerprint` does: a change is "the same change"
 * when it is the same kind about the same record, even after the numbers move again. That is
 * what makes a re-run recognise its predecessor instead of piling a second row beside it.
 */
export function remoteChangeFingerprint(draft: SplitwiseRemoteChangeDraft): string {
  const subject =
    draft.externalReference ??
    draft.externalUserReference ??
    draft.splitwiseExpenseRowId ??
    draft.splitwiseSettlementRowId ??
    draft.subjects.map((entry) => entry.id).join('+');
  return [draft.kind, draft.personAId ?? '', draft.personBId ?? '', subject].join('|');
}

/**
 * Everything that makes a re-run **materially different** from its predecessor.
 *
 * The read's own status is deliberately absent: a pair read that degrades from `complete` to
 * `partial` while reporting the identical entry has not changed what anybody is deciding
 * about, and superseding on it would churn a decided row for a reason nobody could act on.
 */
export function remoteChangeComparisonSource(draft: SplitwiseRemoteChangeDraft): string {
  return canonicalJson({
    kind: draft.kind,
    effect: draft.effect,
    amount: draft.amount === null ? null : draft.amount.toString(),
    localSnapshot: draft.localSnapshot,
    remoteSnapshot: draft.remoteSnapshot,
  });
}

/* ====================================================================== draft builders */

function changedExpenseDraft(
  input: DiscoverRemoteChangesInput,
  link: LinkedExpenseView,
  remote: RemoteEntryView,
): SplitwiseRemoteChangeDraft {
  const ours = link.syncedAmount ?? link.expenseNetAmount;
  return {
    kind: 'remote_expense_amount_changed',
    effect: remoteChangeEffect('remote_expense_amount_changed'),
    summary:
      `${input.friendDisplayName}'s Splitwise entry for this expense now reads ` +
      `${remote.totalAmount.toString()} paise where this ledger sent ${ours.toString()}.`,
    consequence:
      'Accepting records what Splitwise now holds on the sync row and marks it drifted. Your ' +
      'expense, its allocation and every balance stay exactly as they are — this ledger is ' +
      'still the canonical one. To make their figure true here, record an adjustment with ' +
      'evidence; to push ours back over theirs, use the repair.',
    readStatus: input.external.status,
    readDetail: input.external.detail,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: link.expenseId,
    splitwiseExpenseRowId: link.splitwiseExpenseRowId,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: link.externalId,
    externalUserReference: null,
    amount: absolute(remote.totalAmount - ours),
    localSnapshot: {
      expenseId: link.expenseId,
      description: link.description,
      syncedAmount: ours.toString(),
      currentNetAmount: link.expenseNetAmount.toString(),
      syncStatus: link.syncStatus,
    },
    remoteSnapshot: remoteSnapshotOf(remote),
    subjects: [
      { type: 'expense', id: link.expenseId },
      { type: 'splitwise_expense', id: link.splitwiseExpenseRowId },
      { type: 'external_entry', id: link.externalId },
    ],
  };
}

function deletedExpenseDraft(
  input: DiscoverRemoteChangesInput,
  link: LinkedExpenseView,
  remote: RemoteEntryView | null,
): SplitwiseRemoteChangeDraft {
  return {
    kind: 'remote_expense_deleted',
    effect: remoteChangeEffect('remote_expense_deleted'),
    summary: `The Splitwise entry for this expense is gone — ${
      remote === null
        ? 'it was not in a complete listing of the pair'
        : 'Splitwise reports it deleted'
    }.`,
    consequence:
      'Accepting marks the sync row externally deleted, keeping the external id it held so ' +
      'past audit findings can still be explained. Your expense is untouched and still ' +
      'asserts its share; the repair will offer to put an entry back in Splitwise.',
    readStatus: input.external.status,
    readDetail: input.external.detail,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: link.expenseId,
    splitwiseExpenseRowId: link.splitwiseExpenseRowId,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: link.externalId,
    externalUserReference: null,
    amount: link.expenseNetAmount,
    localSnapshot: {
      expenseId: link.expenseId,
      description: link.description,
      currentNetAmount: link.expenseNetAmount.toString(),
      syncStatus: link.syncStatus,
    },
    remoteSnapshot: remote === null ? { present: false } : remoteSnapshotOf(remote),
    subjects: [
      { type: 'expense', id: link.expenseId },
      { type: 'splitwise_expense', id: link.splitwiseExpenseRowId },
      { type: 'external_entry', id: link.externalId },
    ],
  };
}

function changedSettlementDraft(
  input: DiscoverRemoteChangesInput,
  link: LinkedSettlementView,
  remote: RemoteEntryView,
): SplitwiseRemoteChangeDraft {
  return {
    kind: 'remote_settlement_amount_changed',
    effect: remoteChangeEffect('remote_settlement_amount_changed'),
    summary:
      `The Splitwise payment for this settlement now reads ${remote.totalAmount.toString()} ` +
      `paise where this ledger recorded ${link.amount.toString()}.`,
    consequence:
      'Accepting records what Splitwise now holds on the sync row and marks it drifted. The ' +
      'settlement and the payment behind it are unchanged — a repayment is evidenced by a ' +
      'Payment here, and an edit on their side is not that evidence.',
    readStatus: input.external.status,
    readDetail: input.external.detail,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: link.settlementId,
    splitwiseSettlementRowId: link.splitwiseSettlementRowId,
    externalReference: link.externalId,
    externalUserReference: null,
    amount: absolute(remote.totalAmount - link.amount),
    localSnapshot: {
      settlementId: link.settlementId,
      amount: link.amount.toString(),
      direction: link.direction,
      syncStatus: link.syncStatus,
    },
    remoteSnapshot: remoteSnapshotOf(remote),
    subjects: [
      { type: 'settlement', id: link.settlementId },
      { type: 'splitwise_settlement', id: link.splitwiseSettlementRowId },
      { type: 'external_entry', id: link.externalId },
    ],
  };
}

function deletedSettlementDraft(
  input: DiscoverRemoteChangesInput,
  link: LinkedSettlementView,
  remote: RemoteEntryView | null,
): SplitwiseRemoteChangeDraft {
  return {
    kind: 'remote_settlement_deleted',
    effect: remoteChangeEffect('remote_settlement_deleted'),
    summary: `The Splitwise payment for this settlement is gone — ${
      remote === null
        ? 'it was not in a complete listing of the pair'
        : 'Splitwise reports it deleted'
    }.`,
    consequence:
      'Accepting marks the sync row externally deleted, keeping the external id. The ' +
      'settlement stays recorded here: a repayment that happened does not un-happen because ' +
      'somebody removed its Splitwise entry.',
    readStatus: input.external.status,
    readDetail: input.external.detail,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: link.settlementId,
    splitwiseSettlementRowId: link.splitwiseSettlementRowId,
    externalReference: link.externalId,
    externalUserReference: null,
    amount: link.amount,
    localSnapshot: {
      settlementId: link.settlementId,
      amount: link.amount.toString(),
      direction: link.direction,
      syncStatus: link.syncStatus,
    },
    remoteSnapshot: remote === null ? { present: false } : remoteSnapshotOf(remote),
    subjects: [
      { type: 'settlement', id: link.settlementId },
      { type: 'splitwise_settlement', id: link.splitwiseSettlementRowId },
      { type: 'external_entry', id: link.externalId },
    ],
  };
}

function unlinkedDraft(
  input: DiscoverRemoteChangesInput,
  entry: RemoteEntryView,
): SplitwiseRemoteChangeDraft {
  const isPayment = entry.kind === 'payment';
  const kind: SplitwiseRemoteChangeKind = isPayment
    ? 'remote_settlement_unlinked'
    : 'remote_expense_unlinked';
  return {
    kind,
    effect: remoteChangeEffect(kind),
    summary:
      `Splitwise holds ${isPayment ? 'a payment' : 'an expense'} with ` +
      `${input.friendDisplayName} that this ledger has no link for: ` +
      `${entry.description ?? 'no description'}, ${entry.totalAmount.toString()} paise.`,
    consequence: isPayment
      ? 'Accepting joins this Splitwise payment to a settlement you name — an id linked to an ' +
        'id, no money moved. It cannot create a settlement: one is always discharged by a ' +
        'Payment this ledger observed, and there is no such payment behind an entry somebody ' +
        'typed into Splitwise. If none exists here, record the payment first.'
      : 'Accepting joins this Splitwise entry to an approved expense you name — an id linked ' +
        'to an id. It cannot create an expense, so if none exists here, author it first and ' +
        'then adopt the entry against it.',
    readStatus: input.external.status,
    readDetail: input.external.detail,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    expenseId: null,
    splitwiseExpenseRowId: null,
    settlementId: null,
    splitwiseSettlementRowId: null,
    externalReference: entry.externalId,
    externalUserReference: null,
    amount: entry.totalAmount,
    localSnapshot: { linked: false },
    remoteSnapshot: remoteSnapshotOf(entry),
    subjects: [{ type: 'external_entry', id: entry.externalId }],
  };
}

/**
 * Two or more unlinked entries that are indistinguishable from one another.
 *
 * A warning, with no effect to accept: which of them is the duplicate is a fact about
 * somebody else's ledger, and this system does not delete another person's records to tidy a
 * comparison (ADR-0046, carried into ADR-0056). Adoption of an individual entry stays
 * available — the person names the local expense, and a local expense may hold only one link,
 * so the refusal lands where the ambiguity actually is.
 */
function duplicateCandidateDrafts(
  input: DiscoverRemoteChangesInput,
  unlinked: readonly RemoteEntryView[],
): readonly SplitwiseRemoteChangeDraft[] {
  const groups = new Map<string, RemoteEntryView[]>();
  for (const entry of unlinked) {
    const key = canonicalJson({
      kind: entry.kind,
      totalAmount: entry.totalAmount.toString(),
      description: (entry.description ?? '').trim().toLowerCase(),
      day: entry.occurredAt === null ? null : entry.occurredAt.toISOString().slice(0, 10),
    });
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [entry]);
    else bucket.push(entry);
  }

  const drafts: SplitwiseRemoteChangeDraft[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const ids = bucket.map((entry) => entry.externalId).sort(compareText);
    const first = bucket[0]!;
    drafts.push({
      kind: 'remote_duplicate_candidate',
      effect: remoteChangeEffect('remote_duplicate_candidate'),
      summary:
        `Splitwise holds ${bucket.length} indistinguishable unlinked entries with ` +
        `${input.friendDisplayName}: ${first.description ?? 'no description'}, ` +
        `${first.totalAmount.toString()} paise each.`,
      consequence:
        'There is nothing to accept. Which of these is the duplicate is a fact about their ' +
        'ledger, and this system never deletes somebody else’s record to make a check come ' +
        'out clean. Resolve it in Splitwise, or adopt whichever entry is real against the ' +
        'local expense it belongs to.',
      readStatus: input.external.status,
      readDetail: input.external.detail,
      personAId: input.userPersonId,
      personBId: input.friendPersonId,
      expenseId: null,
      splitwiseExpenseRowId: null,
      settlementId: null,
      splitwiseSettlementRowId: null,
      externalReference: ids[0] ?? null,
      externalUserReference: null,
      amount: first.totalAmount,
      localSnapshot: { linked: false, matchingLocalRecords: 0 },
      remoteSnapshot: { entries: bucket.map(remoteSnapshotOf) },
      subjects: ids.map((id) => ({ type: 'external_entry' as const, id })),
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------------- internals */

/** True when this sync status means Splitwise should currently be holding a live entry. */
function assertsALiveEntry(status: SplitwiseExpenseSyncStatus): boolean {
  return status === 'synced' || status === 'drifted' || status === 'stale';
}

function assertsALiveSettlement(status: SplitwiseSettlementSyncStatus): boolean {
  return status === 'synced' || status === 'drifted';
}

function remoteSnapshotOf(entry: RemoteEntryView): Readonly<Record<string, unknown>> {
  return {
    externalId: entry.externalId,
    kind: entry.kind,
    description: entry.description,
    totalAmount: entry.totalAmount.toString(),
    deleted: entry.deleted,
    occurredAt: entry.occurredAt === null ? null : entry.occurredAt.toISOString(),
    pairNetBalance: entry.pairNetBalance.toString(),
  };
}

function absolute(value: bigint): Paise {
  return (value < 0n ? -value : value) as Paise;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
