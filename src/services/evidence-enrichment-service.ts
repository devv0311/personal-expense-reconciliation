/**
 * Evidence enrichment and context re-attachment — `data-flow.md` step 4, phase 17 (ADR-0044).
 *
 * ```
 * services.recordEvidenceNotification ─▶ domain.parseNotificationText
 *                                     ─▶ db.insertEvidence + db.insertEvidenceObservation
 * services.matchEvidenceContext       ─▶ db.listMatchablePayments{Near,ByReference}
 *                                     ─▶ domain.matchEvidenceToPayments
 *                                     ─▶ db.insert/updateEvidenceMatchCandidate…
 * services.decideEvidenceMatch        ─▶ domain.assertEvidenceLinkOnce
 *                                     ─▶ services.applyEvidenceLink (phase 10's own write)
 * services.getPaymentContext          ─▶ domain.deriveReattachedContext   (a read)
 * ```
 *
 * What this layer adds to the pipeline is the other half of pillar 1: a bank statement line
 * that decayed to `UPI-BLINKIT9821PAYTM` and the push notification that knows it was Blinkit
 * are matched to each other, and the context is re-attached **beside** the narration.
 *
 * Four rules govern everything below, and none of them is negotiable by a confidence level:
 *
 *  1. **Matching produces candidates, never links** (ADR-0037, carried forward). Even a
 *     `deterministic` candidate — a matching UTR with nothing contradicting it — waits for
 *     `decideEvidenceMatch`, because `evidence` linkage is write-once and a wrong link cannot
 *     be undone (ADR-0034).
 *  2. **A re-run that finds nothing new writes nothing.** No row, no `updated_at` bump, no
 *     audit event. The plan is computed first and the transaction is opened only if the plan
 *     is non-empty, so idempotency is structural rather than a promise.
 *  3. **A human decision outranks the matcher.** A candidate already `accepted` or `dismissed`
 *     is never rewritten by a later run; only `proposed` rows move.
 *  4. **Nothing here touches money or narration.** No amount, no `Payment.raw_description`, no
 *     `cash_flow_category`, no `cash_flow_state`. Enrichment explains a movement; it never
 *     restates one (`invariants.md` #4, ADR-0017 (cash balance)).
 */

import {
  assertEvidenceLinkOnce,
  deriveReattachedContext,
  notificationDedupeKey,
  matchEvidenceToPayments,
  normalizeReference,
  parseDecisionActor,
  parseNotificationText,
  validateEvidenceObservation,
  validateEvidencePayload,
  DEFAULT_EVIDENCE_CAPTURE_WINDOW_DAYS,
  DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS,
} from '../domain/index.js';
import type {
  ConfidenceLevel,
  EvidenceId,
  EvidenceMatchAssessment,
  EvidenceMatchCandidateId,
  EvidenceMatchSignalResult,
  EvidenceMatchStatus,
  EvidenceMatchStrength,
  EvidenceObservationDerivation,
  EvidenceObservationFields,
  EvidenceType,
  ExpenseId,
  MatchablePayment,
  Paise,
  PaymentDirection,
  PaymentId,
  PaymentReferenceType,
  ReattachedContext,
} from '../domain/index.js';
import {
  findEvidenceByNotificationKey,
  getEvidenceMatchCandidateById,
  getEvidenceObservationByEvidenceId,
  getPaymentById,
  getPrimaryUserPerson,
  getReceiptByEvidenceId,
  getMerchantById,
  insertEvidence,
  insertEvidenceMatchCandidate,
  insertEvidenceObservation,
  listEvidenceContextSourcesForPayment,
  listEvidenceMatchCandidatesByEvidence,
  listMatchablePaymentsByReference,
  listMatchablePaymentsNear,
  updateEvidenceMatchCandidateAssessment,
  updateEvidenceMatchCandidateStatus,
  updateEvidenceObservation,
} from '../db/index.js';
import type {
  Database,
  EvidenceMatchCandidateRow,
  EvidenceObservationRow,
  EvidenceRow,
  Executor,
  MatchablePaymentRow,
} from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import {
  applyEvidenceLink,
  assertEvidenceLinkTargetsExist,
  requireEvidenceRow,
} from './evidence-service.js';

/**
 * Which matcher produced a candidate.
 *
 * Stored on every row so that a re-run under changed matching rules is distinguishable from a
 * re-run over a changed ledger. Bump it when a signal's meaning changes, not when a comment
 * does: it exists to explain a diff, and a version that changes for cosmetic reasons explains
 * nothing.
 */
export const EVIDENCE_MATCHER_VERSION = 'evidence-match/1';

/** The evidence types a notification may be recorded as. Both are payment-side records. */
export const NOTIFICATION_EVIDENCE_TYPES = ['bank_line', 'upi_notification'] as const;
export type NotificationEvidenceType = (typeof NOTIFICATION_EVIDENCE_TYPES)[number];

/* ---------------------------------------------------------------------------- views */

/** An observation as a caller sees it. The raw evidence text stays where it is. */
export interface EvidenceObservationView {
  readonly evidenceId: EvidenceId;
  readonly observedAmount: Paise | null;
  readonly observedDirection: PaymentDirection | null;
  readonly observedReference: string | null;
  readonly observedReferenceType: PaymentReferenceType | null;
  readonly observedAccountHint: string | null;
  readonly observedMerchantText: string | null;
  readonly observedOccurredAt: Date | null;
  readonly derivation: EvidenceObservationDerivation;
}

/** One recorded candidate, with everything a reviewer needs to agree or disagree with it. */
export interface EvidenceMatchCandidateView {
  readonly candidateId: EvidenceMatchCandidateId;
  readonly evidenceId: EvidenceId;
  readonly paymentId: PaymentId;
  readonly strength: EvidenceMatchStrength;
  /** A summary of the signal set. Never an approval (ADR-0024). */
  readonly confidence: ConfidenceLevel;
  readonly matchedSignals: readonly string[];
  readonly conflictingSignals: readonly string[];
  readonly signals: unknown;
  readonly reviewReasons: readonly string[];
  readonly status: EvidenceMatchStatus;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  /**
   * Always `true`, and stated rather than implied.
   *
   * There is no code path in this system by which a candidate becomes a link without a person
   * (or an already-approved `Rule`) saying so. A surface reading this field is reading a
   * property of the design, not a computed threshold (ADR-0034/0037/0044).
   */
  readonly requiresReview: true;
  readonly matcherVersion: string;
}

/* ------------------------------------------------------- recording a notification */

export interface ObservedMovementInput {
  readonly observedAmount?: Paise | null;
  readonly observedDirection?: PaymentDirection | null;
  readonly observedReference?: string | null;
  readonly observedReferenceType?: PaymentReferenceType | null;
  readonly observedAccountHint?: string | null;
  readonly observedMerchantText?: string | null;
  readonly observedOccurredAt?: Date | null;
}

export interface RecordEvidenceNotificationInput extends ObservedMovementInput {
  readonly type: NotificationEvidenceType;
  /** The notification exactly as it arrived. SOURCE — stored verbatim, never normalized. */
  readonly text: string;
  readonly capturedAt: Date;
  readonly linkedPaymentId?: PaymentId | null;
  readonly linkedExpenseId?: ExpenseId | null;
  readonly audit: AuditMeta;
}

export interface RecordEvidenceNotificationResult {
  readonly evidenceId: EvidenceId;
  readonly observation: EvidenceObservationView;
  /**
   * `already_recorded` when this exact movement was already observed.
   *
   * The rule `ingestEvidenceDocument` applies to bytes, applied to text that has no content
   * address of its own: an SMS export re-imported, or a notification forwarded twice, is the
   * one record it is rather than two a reviewer has to dismiss separately.
   */
  readonly outcome: 'recorded' | 'already_recorded';
}

/**
 * Records a bank SMS or UPI push notification as evidence, with what it says about a movement.
 *
 * The raw text is stored untouched — it is SOURCE, and everything downstream is allowed to
 * disagree with the parse but never with the text (`invariants.md` #4). The structured reading
 * lands beside it in `evidence_observations`, marked `parsed_from_text` when this function read
 * it and `caller_supplied` when an importer already had the fields as structured data.
 *
 * No model is involved and none may be: reading `Rs.450.00 debited … UPI Ref 402312345678` off
 * a bank's own SMS with a fixed grammar is parsing (`ai-boundary.md`'s division of labour).
 */
export async function recordEvidenceNotification(
  db: Database,
  input: RecordEvidenceNotificationInput,
): Promise<RecordEvidenceNotificationResult> {
  const parsed = parseNotificationText(input.text);
  const callerSupplied = hasCallerSuppliedFields(input);
  const fields: EvidenceObservationFields = {
    observedAmount: pick(input.observedAmount, parsed.observedAmount),
    observedDirection: pick(input.observedDirection, parsed.observedDirection),
    observedReference: pick(input.observedReference, parsed.observedReference),
    observedReferenceType: pick(input.observedReferenceType, parsed.observedReferenceType),
    observedAccountHint: pick(input.observedAccountHint, parsed.observedAccountHint),
    observedMerchantText: pick(input.observedMerchantText, parsed.observedMerchantText),
    observedOccurredAt: pick(input.observedOccurredAt, null),
    derivation: callerSupplied ? 'caller_supplied' : 'parsed_from_text',
  };
  validateEvidenceObservation(fields);

  const links = {
    linkedPaymentId: input.linkedPaymentId ?? null,
    linkedExpenseId: input.linkedExpenseId ?? null,
  };
  await assertEvidenceLinkTargetsExist(db, links);

  const notificationKey = notificationDedupeKey({
    evidenceType: input.type,
    capturedAt: input.capturedAt,
    rawText: input.text,
    fields,
  });

  const existing = await findEvidenceByNotificationKey(db, notificationKey);
  if (existing !== null) {
    return {
      evidenceId: existing.evidence.id,
      observation: observationRowView(existing.observation),
      outcome: 'already_recorded',
    };
  }

  const draft = {
    type: input.type as EvidenceType,
    noteKind: null,
    storageRef: null,
    mediaType: null,
    byteSize: null,
    rawText: input.text,
    capturedAt: input.capturedAt,
    ...links,
  };
  validateEvidencePayload(draft);

  const evidenceId = await runAudited(db, input.audit, async (ctx) => {
    const id = await insertEvidence(ctx.exec, draft);
    await ctx.record({
      entityType: 'evidence',
      entityId: id,
      action: 'create',
      newValue: {
        type: draft.type,
        capturedAt: draft.capturedAt.toISOString(),
        linkedPaymentId: draft.linkedPaymentId,
        linkedExpenseId: draft.linkedExpenseId,
      },
    });
    await writeObservation(ctx, id, fields, notificationKey);
    return id;
  });

  return {
    evidenceId,
    observation: observationFieldsView(evidenceId, fields),
    outcome: 'recorded',
  };
}

export interface RecordEvidenceObservationInput extends ObservedMovementInput {
  readonly evidenceId: EvidenceId;
  readonly audit: AuditMeta;
}

export interface RecordEvidenceObservationResult {
  readonly observation: EvidenceObservationView;
  /** `unchanged` writes nothing at all — no row, no `updated_at`, no audit event. */
  readonly outcome: 'recorded' | 'updated' | 'unchanged';
}

/**
 * Records, or refines, the structured reading of an existing evidence record.
 *
 * This is how a human corrects a parse the grammar got wrong, and how an importer supplies the
 * fields a photograph never had. It replaces the reading rather than appending one: an evidence
 * record has one current interpretation, and two would leave the matcher choosing between them.
 * The `Evidence` row itself is untouched — a correction to an interpretation is not a
 * correction to the source.
 */
export async function recordEvidenceObservation(
  db: Database,
  input: RecordEvidenceObservationInput,
): Promise<RecordEvidenceObservationResult> {
  const evidence = await requireEvidenceRow(db, input.evidenceId);
  const existing = await getEvidenceObservationByEvidenceId(db, input.evidenceId);

  const parsed = evidence.rawText === null ? null : parseNotificationText(evidence.rawText);
  const fields: EvidenceObservationFields = {
    observedAmount: pick(input.observedAmount, parsed?.observedAmount ?? null),
    observedDirection: pick(input.observedDirection, parsed?.observedDirection ?? null),
    observedReference: pick(input.observedReference, parsed?.observedReference ?? null),
    observedReferenceType: pick(input.observedReferenceType, parsed?.observedReferenceType ?? null),
    observedAccountHint: pick(input.observedAccountHint, parsed?.observedAccountHint ?? null),
    observedMerchantText: pick(input.observedMerchantText, parsed?.observedMerchantText ?? null),
    observedOccurredAt: pick(input.observedOccurredAt, null),
    derivation: hasCallerSuppliedFields(input) ? 'caller_supplied' : 'parsed_from_text',
  };
  validateEvidenceObservation(fields);

  if (existing !== null && observationUnchanged(existing, fields)) {
    return { observation: observationRowView(existing), outcome: 'unchanged' };
  }

  await runAudited(db, input.audit, async (ctx) => {
    if (existing === null) {
      // A reading of evidence that already exists carries no notification key: this row's own
      // id is its identity, and a movement-shaped key here would collide with any other
      // document describing the same amount (ADR-0044).
      await writeObservation(ctx, input.evidenceId, fields, null);
      return;
    }
    // The key describes the notification as it arrived, not the reading. A correction to the
    // reading must not change it, or re-recording the same notification would produce a
    // second evidence row.
    await updateEvidenceObservation(ctx.exec, existing.id, {
      ...toObservationDraft(fields),
      notificationKey: existing.notificationKey,
    });
    await ctx.record({
      entityType: 'evidence_observation',
      entityId: existing.id,
      action: 'update',
      oldValue: observationAuditValue(existing),
      newValue: observationAuditValue(fields),
    });
  });

  return {
    observation: observationFieldsView(input.evidenceId, fields),
    outcome: existing === null ? 'recorded' : 'updated',
  };
}

/* ---------------------------------------------------------------------- the matching */

export interface MatchEvidenceContextInput {
  readonly evidenceId: EvidenceId;
  readonly audit: AuditMeta;
  readonly captureWindowDays?: number;
  readonly instantSkewHours?: number;
}

export interface MatchEvidenceContextResult {
  readonly evidenceId: EvidenceId;
  readonly observation: EvidenceObservationView | null;
  /** The recorded candidates, strongest first. Empty is a real answer, not a failure. */
  readonly candidates: readonly EvidenceMatchCandidateView[];
  /** More than one candidate: the evidence does not distinguish them, so a person must. */
  readonly ambiguous: boolean;
  readonly outcome:
    | 'matched'
    /** A re-run over an unchanged ledger. Nothing was written — not even a timestamp. */
    | 'unchanged'
    /** Nothing could be read off this evidence, so there is nothing to match on. */
    | 'no_observation'
    /** Already attached. Linkage is write-once, so there is no candidate worth offering. */
    | 'already_linked';
}

/**
 * Finds, records and explains the payments one evidence record could be about.
 *
 * The database work is a **pre-filter only** — payments inside a generous date window, plus
 * any payment whose reference overlaps the observed one regardless of date, because a UTR
 * identifies a transaction whenever the evidence for it turned up. Every window, every
 * comparison and every verdict is then re-derived by `domain.matchEvidenceToPayments`, which
 * is where the rule actually lives.
 *
 * Writes are computed before the transaction opens, so a run that finds exactly what is
 * already recorded returns `unchanged` having written nothing. That is what makes repeated
 * enrichment safe to schedule, and it is why `runAudited` — which rolls back a mutating unit
 * of work that recorded no audit event — is never entered on a no-op.
 */
export async function matchEvidenceContext(
  db: Database,
  input: MatchEvidenceContextInput,
): Promise<MatchEvidenceContextResult> {
  const evidence = await requireEvidenceRow(db, input.evidenceId);

  const stored = await getEvidenceObservationByEvidenceId(db, input.evidenceId);
  const derived = stored === null ? await deriveObservation(db, evidence) : null;
  const fields: EvidenceObservationFields | null =
    stored === null ? derived : toObservationFields(stored);

  if (fields === null) {
    return {
      evidenceId: input.evidenceId,
      observation: null,
      candidates: [],
      ambiguous: false,
      outcome: 'no_observation',
    };
  }

  if (evidence.linkedPaymentId !== null) {
    // Attached already. Offering a candidate here would be offering a decision that
    // `assertEvidenceLinkOnce` refuses to carry out, which is worse than offering none.
    const existing = await listEvidenceMatchCandidatesByEvidence(db, input.evidenceId);
    return {
      evidenceId: input.evidenceId,
      // Whatever is recorded, and nothing more: this path writes nothing, so reporting the
      // reading that was derived on the way here would describe a row that does not exist.
      observation: stored === null ? null : observationRowView(stored),
      candidates: existing.map(toCandidateView),
      ambiguous: false,
      outcome: 'already_linked',
    };
  }

  const userPerson = await getPrimaryUserPerson(db);
  const payments = await loadMatchablePayments(db, evidence, fields, input);
  const result = matchEvidenceToPayments(
    {
      evidenceId: evidence.id,
      capturedAt: evidence.capturedAt,
      observation: fields,
    },
    payments.map((payment) => toMatchablePayment(payment, userPerson?.userId ?? null)),
    {
      ...(input.captureWindowDays === undefined
        ? {}
        : { captureWindowDays: input.captureWindowDays }),
      ...(input.instantSkewHours === undefined ? {} : { instantSkewHours: input.instantSkewHours }),
    },
  );

  const existing = await listEvidenceMatchCandidatesByEvidence(db, input.evidenceId);
  const plan = planCandidateWrites(existing, result.candidates, stored === null ? fields : null);

  if (plan.isEmpty) {
    const unchanged = await listEvidenceMatchCandidatesByEvidence(db, input.evidenceId);
    return {
      evidenceId: input.evidenceId,
      observation: stored === null ? null : observationRowView(stored),
      candidates: orderCandidateViews(unchanged.map(toCandidateView), result.candidates),
      ambiguous: result.ambiguous,
      outcome: 'unchanged',
    };
  }

  await runAudited(db, input.audit, async (ctx) => {
    if (plan.observationToWrite !== null) {
      // No notification key: this reading is of an `Evidence` row that already exists, whose
      // own id is its identity. A movement-shaped key here would collide with every other
      // document describing the same amount — two receipts for ₹1,240 are two readings, not
      // one (ADR-0044).
      await writeObservation(ctx, evidence.id, plan.observationToWrite, null);
    }

    for (const insert of plan.inserts) {
      const candidateId = await insertEvidenceMatchCandidate(ctx.exec, {
        evidenceId: evidence.id,
        paymentId: insert.paymentId as PaymentId,
        ...assessmentToDraft(insert),
      });
      await ctx.record({
        entityType: 'evidence_match_candidate',
        entityId: candidateId,
        action: 'create',
        newValue: candidateAuditValue(insert),
      });
    }

    for (const update of plan.updates) {
      await updateEvidenceMatchCandidateAssessment(
        ctx.exec,
        update.row.id,
        assessmentToDraft(update.assessment),
      );
      await ctx.record({
        entityType: 'evidence_match_candidate',
        entityId: update.row.id,
        action: 'update',
        oldValue: rowAuditValue(update.row),
        newValue: candidateAuditValue(update.assessment),
      });
    }

    for (const row of plan.supersedes) {
      await updateEvidenceMatchCandidateStatus(ctx.exec, row.id, 'superseded', null);
      await ctx.record({
        entityType: 'evidence_match_candidate',
        entityId: row.id,
        action: 'supersede',
        oldValue: rowAuditValue(row),
        newValue: { status: 'superseded', matcherVersion: EVIDENCE_MATCHER_VERSION },
        reason:
          'The matcher no longer offers this payment for this evidence. Superseded rather ' +
          'than deleted: how the ledger came to look this way stays answerable.',
      });
    }
  });

  const written = await listEvidenceMatchCandidatesByEvidence(db, input.evidenceId);
  const observation = await getEvidenceObservationByEvidenceId(db, input.evidenceId);
  return {
    evidenceId: input.evidenceId,
    observation: observation === null ? null : observationRowView(observation),
    candidates: orderCandidateViews(written.map(toCandidateView), result.candidates),
    ambiguous: result.ambiguous,
    outcome: 'matched',
  };
}

/** Every candidate recorded for one evidence record, strongest first. A read. */
export async function listEvidenceMatches(
  exec: Executor,
  evidenceId: EvidenceId,
): Promise<readonly EvidenceMatchCandidateView[]> {
  const rows = await listEvidenceMatchCandidatesByEvidence(exec, evidenceId);
  return rows.map(toCandidateView);
}

/* --------------------------------------------------------------------- the decision */

export interface DecideEvidenceMatchInput {
  readonly candidateId: EvidenceMatchCandidateId;
  readonly decision: 'accept' | 'dismiss';
  readonly audit: AuditMeta;
}

export interface DecideEvidenceMatchResult {
  readonly candidate: EvidenceMatchCandidateView;
  readonly evidence: EvidenceRow;
  /** `unchanged` when the same decision was already recorded — a retry is not a failure. */
  readonly outcome: 'accepted' | 'dismissed' | 'unchanged';
}

/**
 * Attaches evidence to the payment a candidate names, or records that it does not belong there.
 *
 * Accepting is the **only** way a candidate becomes a link, and it goes through phase 10's own
 * write (`services.applyEvidenceLink`) and phase 10's own rule (`domain.assertEvidenceLinkOnce`)
 * rather than a second path to the one column ADR-0034 governs. So re-attaching evidence that
 * is already linked elsewhere fails here exactly as it fails everywhere else: `null → id` is
 * allowed, `id → a different id` is not, and the remedy is superseding evidence.
 *
 * The actor is parsed before anything is written. A match decision is a financial decision —
 * everything extracted from this document inherits the link — so it is attributable to a person
 * or to an approved `Rule`, never to the system and never to a model (`invariants.md` #17).
 *
 * Accepting also supersedes the candidate's siblings: once the evidence has a home, the other
 * offers are answered, and leaving them `proposed` would leave the queue asking a question that
 * can no longer be answered either way.
 */
export async function decideEvidenceMatch(
  db: Database,
  input: DecideEvidenceMatchInput,
): Promise<DecideEvidenceMatchResult> {
  parseDecisionActor(input.audit.actor);

  const candidate = await getEvidenceMatchCandidateById(db, input.candidateId);
  if (candidate === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No evidence match candidate with id ${input.candidateId}.`,
      {
        candidateId: input.candidateId,
      },
    );
  }
  const evidence = await requireEvidenceRow(db, candidate.evidenceId);

  if (input.decision === 'dismiss') {
    if (candidate.status === 'dismissed') {
      return { candidate: toCandidateView(candidate), evidence, outcome: 'unchanged' };
    }
    assertCandidateUndecided(candidate);
    await runAudited(db, input.audit, async (ctx) => {
      await updateEvidenceMatchCandidateStatus(ctx.exec, candidate.id, 'dismissed', {
        decidedAt: new Date(),
        decidedBy: input.audit.actor,
      });
      await ctx.record({
        entityType: 'evidence_match_candidate',
        entityId: candidate.id,
        action: 'update',
        oldValue: rowAuditValue(candidate),
        newValue: { status: 'dismissed', decidedBy: input.audit.actor },
        reason:
          'A person judged that this evidence is not about this payment. Recorded rather ' +
          'than deleted, so a later run does not offer it again as if nobody had looked.',
      });
    });
    const updated = await getEvidenceMatchCandidateById(db, candidate.id);
    return { candidate: toCandidateView(updated ?? candidate), evidence, outcome: 'dismissed' };
  }

  const proposed = {
    linkedPaymentId: candidate.paymentId,
    linkedExpenseId: evidence.linkedExpenseId,
  };

  // A retried acceptance of the link that already exists is a no-op, not a failure — the same
  // reading `services.linkEvidence` gives a re-stated link (ADR-0034).
  if (evidence.linkedPaymentId === candidate.paymentId && candidate.status === 'accepted') {
    return { candidate: toCandidateView(candidate), evidence, outcome: 'unchanged' };
  }

  assertCandidateUndecided(candidate);
  assertEvidenceLinkOnce(evidence, proposed);
  await assertEvidenceLinkTargetsExist(db, proposed);

  const siblings = (await listEvidenceMatchCandidatesByEvidence(db, candidate.evidenceId)).filter(
    (row) => row.id !== candidate.id && row.status === 'proposed',
  );

  await runAudited(db, input.audit, async (ctx) => {
    await applyEvidenceLink(ctx, evidence, proposed);
    await updateEvidenceMatchCandidateStatus(ctx.exec, candidate.id, 'accepted', {
      decidedAt: new Date(),
      decidedBy: input.audit.actor,
    });
    await ctx.record({
      entityType: 'evidence_match_candidate',
      entityId: candidate.id,
      action: 'update',
      oldValue: rowAuditValue(candidate),
      newValue: {
        status: 'accepted',
        decidedBy: input.audit.actor,
        paymentId: candidate.paymentId,
        strength: candidate.strength,
        confidence: candidate.confidence,
      },
      reason:
        'A person attached this evidence to this payment. The strength and confidence are ' +
        'recorded as what was in front of them, not as what authorised it (ADR-0044).',
    });
    for (const sibling of siblings) {
      await updateEvidenceMatchCandidateStatus(ctx.exec, sibling.id, 'superseded', null);
      await ctx.record({
        entityType: 'evidence_match_candidate',
        entityId: sibling.id,
        action: 'supersede',
        oldValue: rowAuditValue(sibling),
        newValue: { status: 'superseded' },
        reason: 'The evidence was attached to a different payment, answering this offer.',
      });
    }
  });

  const updated = await getEvidenceMatchCandidateById(db, candidate.id);
  return {
    candidate: toCandidateView(updated ?? candidate),
    evidence: { ...evidence, ...proposed },
    outcome: 'accepted',
  };
}

/* ----------------------------------------------------------------- the re-attachment */

export interface PaymentContextResult {
  readonly context: ReattachedContext;
}

/**
 * What the evidence attached to one payment says about it, beside its own narration.
 *
 * A read: no writes, no arithmetic, nothing cached. The narration comes through verbatim and
 * the reconstruction sits in its own fields, so no caller can mistake the second for the first
 * (`invariants.md` #4). Several evidence records enrich one movement, and where two of them
 * disagree the context says so and names both rather than choosing.
 */
export async function getPaymentContext(
  exec: Executor,
  paymentId: PaymentId,
): Promise<PaymentContextResult> {
  const payment = await getPaymentById(exec, paymentId);
  if (payment === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No payment with id ${paymentId}.`, { paymentId });
  }
  const merchant =
    payment.counterpartyType === 'merchant' && payment.counterpartyId !== null
      ? await getMerchantById(exec, payment.counterpartyId as never)
      : null;
  const sources = await listEvidenceContextSourcesForPayment(exec, paymentId);

  return {
    context: deriveReattachedContext(
      {
        paymentId: payment.id,
        amount: payment.amount,
        direction: payment.direction,
        occurredAt: payment.occurredAt,
        rawDescription: payment.rawDescription,
        externalReference: payment.externalReference,
        merchantName: merchant?.canonicalName ?? null,
      },
      sources.map((source) => ({
        evidenceId: source.evidence.id,
        evidenceType: source.evidence.type,
        capturedAt: source.evidence.capturedAt,
        observation: source.observation === null ? null : toObservationFields(source.observation),
      })),
    ),
  };
}

/* ------------------------------------------------------------------------ internals */

function pick<T>(supplied: T | null | undefined, fallback: T | null): T | null {
  return supplied === undefined ? fallback : supplied;
}

function hasCallerSuppliedFields(input: ObservedMovementInput): boolean {
  return (
    input.observedAmount !== undefined ||
    input.observedDirection !== undefined ||
    input.observedReference !== undefined ||
    input.observedReferenceType !== undefined ||
    input.observedAccountHint !== undefined ||
    input.observedMerchantText !== undefined ||
    input.observedOccurredAt !== undefined
  );
}

/**
 * The observation an evidence record implies when nobody has recorded one.
 *
 * Two sources, in order. A `Receipt` extracted in phase 11 already carries the figure the
 * matcher needs, so a photographed bill enriches through the same engine as an SMS rather than
 * through a second candidate rule — which is what keeps ADR-0037's receipt shortcut and this
 * phase's general matcher from becoming two disagreeing opinions about one document. Failing
 * that, the evidence's own raw text is parsed.
 *
 * `null` means the document has been stored but never read: no total, no text. That is an
 * outcome (`no_observation`), not an error — extraction may simply not have run yet.
 */
async function deriveObservation(
  exec: Executor,
  evidence: EvidenceRow,
): Promise<EvidenceObservationFields | null> {
  const receipt = await getReceiptByEvidenceId(exec, evidence.id);
  if (receipt !== null && receipt.total !== null) {
    const merchant =
      receipt.merchantId === null ? null : await getMerchantById(exec, receipt.merchantId);
    return {
      observedAmount: receipt.total,
      // A merchant's receipt documents money leaving; a refund is an ExpenseAdjustment with
      // its own credit Payment, never a receipt (ADR-0008).
      observedDirection: 'debit',
      observedReference: null,
      observedReferenceType: null,
      observedAccountHint: null,
      observedMerchantText: merchant?.canonicalName ?? null,
      observedOccurredAt: null,
      derivation: 'parsed_from_text',
    };
  }

  if (evidence.rawText === null) return null;
  const parsed = parseNotificationText(evidence.rawText);
  const fields: EvidenceObservationFields = {
    ...parsed,
    observedOccurredAt: null,
    derivation: 'parsed_from_text',
  };
  try {
    validateEvidenceObservation(fields);
  } catch {
    // Text that says nothing about a movement is not a failure of this operation — it is the
    // honest answer that this document cannot be matched on yet.
    return null;
  }
  return fields;
}

/** The pre-filter: a date window, plus anything sharing the reference regardless of date. */
async function loadMatchablePayments(
  exec: Executor,
  evidence: EvidenceRow,
  fields: EvidenceObservationFields,
  options: { readonly captureWindowDays?: number; readonly instantSkewHours?: number },
): Promise<readonly MatchablePaymentRow[]> {
  const captureWindowMs =
    (options.captureWindowDays ?? DEFAULT_EVIDENCE_CAPTURE_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const instantSkewMs =
    (options.instantSkewHours ?? DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS) * 60 * 60 * 1000;
  const anchor = fields.observedOccurredAt ?? evidence.capturedAt;
  // The wider of the two windows, so the pre-filter can never be narrower than the rule.
  const spanMs = Math.max(captureWindowMs, instantSkewMs);

  const near = await listMatchablePaymentsNear(exec, {
    from: new Date(anchor.getTime() - spanMs),
    to: new Date(anchor.getTime() + spanMs),
  });

  const normalized = normalizeReference(fields.observedReference);
  const byReference =
    normalized === null ? [] : await listMatchablePaymentsByReference(exec, normalized);

  const byId = new Map<string, MatchablePaymentRow>();
  for (const payment of [...near, ...byReference]) byId.set(payment.id, payment);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function toMatchablePayment(row: MatchablePaymentRow, userId: string | null): MatchablePayment {
  return {
    paymentId: row.id,
    amount: row.amount,
    direction: row.direction,
    occurredAt: row.occurredAt,
    externalReference: row.externalReference,
    accountLast4: row.accountLast4,
    // No `User` seeded at all means nothing can be shown to be the user's, and the honest
    // reading of that is "not mine", not "everyone's".
    accountOwnedByUser: userId !== null && row.accountOwnerUserId === userId,
    merchantName: row.merchantName,
    rawDescription: row.rawDescription,
  };
}

interface CandidateWritePlan {
  readonly inserts: readonly EvidenceMatchAssessment[];
  readonly updates: readonly {
    readonly row: EvidenceMatchCandidateRow;
    readonly assessment: EvidenceMatchAssessment;
  }[];
  readonly supersedes: readonly EvidenceMatchCandidateRow[];
  readonly observationToWrite: EvidenceObservationFields | null;
  readonly isEmpty: boolean;
}

/**
 * What this run would change, computed before anything is opened.
 *
 * The plan exists so that "nothing changed" is a state this function can *report* rather than
 * a transaction that has to be rolled back. `runAudited` refuses to commit a mutating unit of
 * work that recorded no audit event, so entering it on a no-op would turn an idempotent re-run
 * into an error — and writing an audit event to avoid that would be recording that nothing
 * happened, in the log whose job is to record what did.
 *
 * A candidate a person already accepted or dismissed is left exactly as it is. The matcher's
 * opinion does not get to overwrite a decision, and re-proposing something already dismissed
 * would ask the same question again every time the job ran.
 */
function planCandidateWrites(
  existing: readonly EvidenceMatchCandidateRow[],
  candidates: readonly EvidenceMatchAssessment[],
  observationToWrite: EvidenceObservationFields | null,
): CandidateWritePlan {
  const byPayment = new Map(existing.map((row) => [row.paymentId as string, row]));
  const inserts: EvidenceMatchAssessment[] = [];
  const updates: { row: EvidenceMatchCandidateRow; assessment: EvidenceMatchAssessment }[] = [];

  for (const assessment of candidates) {
    const row = byPayment.get(assessment.paymentId);
    if (row === undefined) {
      inserts.push(assessment);
      continue;
    }
    if (row.status === 'accepted' || row.status === 'dismissed') continue;
    if (candidateMatchesRow(row, assessment)) continue;
    updates.push({ row, assessment });
  }

  const offered = new Set(candidates.map((assessment) => assessment.paymentId));
  const supersedes = existing.filter(
    (row) => row.status === 'proposed' && !offered.has(row.paymentId as string),
  );

  return {
    inserts,
    updates,
    supersedes,
    observationToWrite,
    isEmpty:
      inserts.length === 0 &&
      updates.length === 0 &&
      supersedes.length === 0 &&
      observationToWrite === null,
  };
}

/** Whether a stored candidate already says exactly what this run would say. */
function candidateMatchesRow(
  row: EvidenceMatchCandidateRow,
  assessment: EvidenceMatchAssessment,
): boolean {
  return (
    row.status === 'proposed' &&
    row.strength === assessment.strength &&
    row.confidence === assessment.confidence &&
    row.matcherVersion === EVIDENCE_MATCHER_VERSION &&
    sameList(row.matchedSignals, assessment.matchedSignals) &&
    sameList(row.conflictingSignals, assessment.conflictingSignals) &&
    sameList(row.reviewReasons, assessment.reasons) &&
    sameSignals(row.signals, assessment.signals)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Whether the stored signal provenance says the same thing as this run's.
 *
 * Compared field by field rather than by serializing both sides. PostgreSQL's `jsonb`
 * normalizes object key order on the way in, so `JSON.stringify` of a row read back and of the
 * value just computed differ for two identical objects — which would make every re-run look
 * like a change, write a row, record an audit event, and quietly destroy the idempotency this
 * phase is built around.
 */
function sameSignals(stored: unknown, computed: readonly EvidenceMatchSignalResult[]): boolean {
  if (!Array.isArray(stored) || stored.length !== computed.length) return false;
  return computed.every((signal, index) => {
    const entry = stored[index] as Partial<EvidenceMatchSignalResult> | undefined;
    return (
      entry !== undefined &&
      entry.signal === signal.signal &&
      entry.verdict === signal.verdict &&
      (entry.evidenceValue ?? null) === signal.evidenceValue &&
      (entry.paymentValue ?? null) === signal.paymentValue &&
      entry.detail === signal.detail
    );
  });
}

function assessmentToDraft(assessment: EvidenceMatchAssessment) {
  return {
    strength: assessment.strength,
    confidence: assessment.confidence,
    matchedSignals: [...assessment.matchedSignals],
    conflictingSignals: [...assessment.conflictingSignals],
    signals: assessment.signals,
    reviewReasons: [...assessment.reasons],
    matcherVersion: EVIDENCE_MATCHER_VERSION,
  };
}

function candidateAuditValue(assessment: EvidenceMatchAssessment) {
  return {
    paymentId: assessment.paymentId,
    strength: assessment.strength,
    confidence: assessment.confidence,
    matchedSignals: [...assessment.matchedSignals],
    conflictingSignals: [...assessment.conflictingSignals],
    reviewReasons: [...assessment.reasons],
    matcherVersion: EVIDENCE_MATCHER_VERSION,
    status: 'proposed',
  };
}

function rowAuditValue(row: EvidenceMatchCandidateRow) {
  return {
    paymentId: row.paymentId,
    strength: row.strength,
    confidence: row.confidence,
    matchedSignals: [...row.matchedSignals],
    conflictingSignals: [...row.conflictingSignals],
    reviewReasons: [...row.reviewReasons],
    matcherVersion: row.matcherVersion,
    status: row.status,
  };
}

function assertCandidateUndecided(candidate: EvidenceMatchCandidateRow): void {
  if (candidate.status === 'proposed') return;
  throw new ServiceError(
    'PRECONDITION_FAILED',
    `This match candidate is "${candidate.status}" and cannot be decided again. A decision is ` +
      'a recorded act with an actor behind it; re-deciding one would overwrite whoever made ' +
      'it (invariants.md #21).',
    { candidateId: candidate.id, status: candidate.status },
  );
}

async function writeObservation(
  ctx: AuditContext,
  evidenceId: EvidenceId,
  fields: EvidenceObservationFields,
  notificationKey: string | null,
): Promise<void> {
  const observationId = await insertEvidenceObservation(ctx.exec, {
    evidenceId,
    ...toObservationDraft(fields),
    notificationKey,
  });
  await ctx.record({
    entityType: 'evidence_observation',
    entityId: observationId,
    action: 'create',
    newValue: observationAuditValue(fields),
  });
}

function toObservationDraft(fields: EvidenceObservationFields) {
  return {
    observedAmount: fields.observedAmount,
    observedDirection: fields.observedDirection,
    observedReference: fields.observedReference,
    observedReferenceNormalized: normalizeReference(fields.observedReference),
    observedReferenceType: fields.observedReferenceType,
    observedAccountHint: fields.observedAccountHint,
    observedMerchantText: fields.observedMerchantText,
    observedOccurredAt: fields.observedOccurredAt,
    derivation: fields.derivation,
  };
}

function observationAuditValue(fields: EvidenceObservationFields) {
  return {
    observedAmount: fields.observedAmount === null ? null : fields.observedAmount.toString(),
    observedDirection: fields.observedDirection,
    observedReference: fields.observedReference,
    observedReferenceType: fields.observedReferenceType,
    observedAccountHint: fields.observedAccountHint,
    observedMerchantText: fields.observedMerchantText,
    observedOccurredAt:
      fields.observedOccurredAt === null ? null : fields.observedOccurredAt.toISOString(),
    derivation: fields.derivation,
  };
}

function observationUnchanged(
  row: EvidenceObservationRow,
  fields: EvidenceObservationFields,
): boolean {
  return (
    row.observedAmount === fields.observedAmount &&
    row.observedDirection === fields.observedDirection &&
    row.observedReference === fields.observedReference &&
    row.observedReferenceType === fields.observedReferenceType &&
    row.observedAccountHint === fields.observedAccountHint &&
    row.observedMerchantText === fields.observedMerchantText &&
    sameInstant(row.observedOccurredAt, fields.observedOccurredAt) &&
    row.derivation === fields.derivation
  );
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

function toObservationFields(row: EvidenceObservationRow): EvidenceObservationFields {
  return {
    observedAmount: row.observedAmount,
    observedDirection: row.observedDirection,
    observedReference: row.observedReference,
    observedReferenceType: row.observedReferenceType,
    observedAccountHint: row.observedAccountHint,
    observedMerchantText: row.observedMerchantText,
    observedOccurredAt: row.observedOccurredAt,
    derivation: row.derivation,
  };
}

/** A stored observation, as a caller sees it. */
function observationRowView(row: EvidenceObservationRow): EvidenceObservationView {
  return { evidenceId: row.evidenceId, ...toObservationFields(row) };
}

/** An in-memory reading, as a caller sees it — the shape before it is written. */
function observationFieldsView(
  evidenceId: EvidenceId,
  fields: EvidenceObservationFields,
): EvidenceObservationView {
  return { evidenceId, ...fields };
}

function toCandidateView(row: EvidenceMatchCandidateRow): EvidenceMatchCandidateView {
  return {
    candidateId: row.id,
    evidenceId: row.evidenceId,
    paymentId: row.paymentId,
    strength: row.strength,
    confidence: row.confidence,
    matchedSignals: row.matchedSignals,
    conflictingSignals: row.conflictingSignals,
    signals: row.signals,
    reviewReasons: row.reviewReasons,
    status: row.status,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    requiresReview: true,
    matcherVersion: row.matcherVersion,
  };
}

/**
 * Puts the stored rows back into the matcher's own order.
 *
 * The database returns candidates by insertion; the order that means something is the
 * matcher's — strongest first — and a surface should not have to re-derive it. Rows the
 * matcher no longer offers (superseded, or decided) keep their relative order at the end.
 */
function orderCandidateViews(
  views: readonly EvidenceMatchCandidateView[],
  ordered: readonly EvidenceMatchAssessment[],
): readonly EvidenceMatchCandidateView[] {
  const rank = new Map(ordered.map((assessment, index) => [assessment.paymentId, index]));
  return [...views].sort((a, b) => {
    const rankA = rank.get(a.paymentId) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(b.paymentId) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });
}
