/**
 * The audit mechanism (`invariants.md` #21, #22).
 *
 * The invariant is that every mutation to APPROVED- or user-facing DERIVED data writes an
 * `AuditEvent`, *"not opt-in per call site — enforced structurally in the service layer so
 * it can't be forgotten."*
 *
 * Enforcement here has two parts:
 *
 *  1. **Every authoritative write happens inside `runAudited`**, which opens one database
 *     transaction and hands the body an {@link AuditContext}. The repositories take an
 *     `Executor`, and inside `runAudited` the only executor in scope is the transaction, so
 *     writing outside the audited unit means visibly reaching for a different handle.
 *  2. **A mutating transaction that records nothing is rolled back.** `runAudited` counts
 *     the events written in its scope and throws `AUDIT_EVENT_MISSING` at the end if the
 *     count is zero — so "I forgot the audit event" fails the operation instead of quietly
 *     producing unaudited financial state. That is the part a code review would otherwise
 *     have to catch by eye.
 *
 * Actor and source are supplied once per unit of work rather than per event, because they
 * describe *who did this and what triggered it* — the same answer for every row a single
 * decision touches.
 */

import type { AuditAction, AuditableEntityType } from '../domain/index.js';
import type { AuditEventDraft, Database, Executor } from '../db/index.js';
import { insertAuditEvent } from '../db/index.js';

import { ServiceError } from './errors.js';

/** Who performed the change, and what triggered it. */
export interface AuditMeta {
  /** `'user'`, `'rule:<rule_id>'`, or `'system'` — never `'ai'` (`ai-boundary.md`). */
  readonly actor: string;
  /** The operation that triggered it, e.g. `'services.approveAllocation'`. */
  readonly source: string;
  /** Free-text explanation carried onto every event in this unit of work. */
  readonly reason?: string | null;
}

/** What a service body is given: a transaction, and the way to record what it did. */
export interface AuditContext {
  /** The open transaction. Every read and write in the unit of work uses this. */
  readonly exec: Executor;
  /** Records one audit event. At least one is required before the unit of work commits. */
  readonly record: (event: {
    readonly entityType: AuditableEntityType;
    readonly entityId: string;
    readonly action: AuditAction;
    readonly oldValue?: unknown;
    readonly newValue: unknown;
    readonly reason?: string | null;
  }) => Promise<void>;
}

/**
 * Runs one mutating unit of work in a transaction, refusing to commit it unaudited.
 *
 * @throws ServiceError `AUDIT_EVENT_MISSING` if the body recorded no audit event — the
 *   transaction is rolled back, so no unaudited state survives.
 */
export async function runAudited<T>(
  db: Database,
  meta: AuditMeta,
  body: (context: AuditContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    let recorded = 0;

    const context: AuditContext = {
      exec: tx,
      record: async (event) => {
        const draft: AuditEventDraft = {
          entityType: event.entityType,
          entityId: event.entityId,
          action: event.action,
          oldValue: event.oldValue ?? null,
          newValue: event.newValue,
          actor: meta.actor,
          source: meta.source,
          reason: event.reason ?? meta.reason ?? null,
        };
        await insertAuditEvent(tx, draft);
        recorded += 1;
      },
    };

    const result = await body(context);

    if (recorded === 0) {
      throw new ServiceError(
        'AUDIT_EVENT_MISSING',
        `${meta.source} completed without recording an AuditEvent. Every mutation to ` +
          'APPROVED- or user-facing DERIVED data must be auditable (invariants.md #21), so ' +
          'this unit of work is rolled back rather than committed unaudited.',
        { source: meta.source, actor: meta.actor },
      );
    }
    return result;
  });
}
