/**
 * The job queue's data access (audit row 51).
 *
 * One thing here is load-bearing beyond ordinary CRUD: {@link claimNextJob} is a conditional
 * `UPDATE ... RETURNING`, so claiming a job is atomic against another worker doing the same.
 * A `SELECT` followed by an `UPDATE` would let two workers run the same import twice, and this
 * system's whole reason for existing is not counting money twice.
 */

import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { JobKind, JobStatus } from '../domain/enums.js';
import type { JobId } from '../domain/ids.js';

import type { Executor } from './repositories.js';
import { jobs } from './schema.js';

export interface JobRow {
  readonly id: JobId;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly payload: Record<string, unknown>;
  readonly result: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly actor: string;
  readonly scheduledFor: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

function toRow(row: typeof jobs.$inferSelect): JobRow {
  return {
    id: row.id as JobId,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    result: row.result,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    actor: row.actor,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export async function insertJob(
  exec: Executor,
  draft: {
    readonly kind: JobKind;
    readonly payload: Record<string, unknown>;
    readonly actor: string;
    readonly scheduledFor?: Date;
    readonly maxAttempts?: number;
  },
): Promise<JobId> {
  const [row] = await exec
    .insert(jobs)
    .values({
      kind: draft.kind,
      payload: draft.payload,
      actor: draft.actor,
      // Stamped from *this* process's clock, not left to the column's `now()` default.
      //
      // `claimNextJob` asks whether `scheduled_for <= now`, where `now` is a `Date` the caller
      // made. Taking the two sides of that comparison from two different clocks — the database
      // server's and the application's — means a job queued "now" can be a few milliseconds in
      // the future as far as the worker is concerned, and a `runNextJob` immediately after an
      // enqueue reports there is nothing to run. Both ends now come from the same clock.
      scheduledFor: draft.scheduledFor ?? new Date(),
      ...(draft.maxAttempts === undefined ? {} : { maxAttempts: draft.maxAttempts }),
    })
    .returning({ id: jobs.id });
  if (row === undefined) throw new Error('Insert into jobs returned no row.');
  return row.id as JobId;
}

function jobConditions(filter: { readonly status?: JobStatus; readonly kind?: JobKind }): SQL[] {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) conditions.push(eq(jobs.status, filter.status));
  if (filter.kind !== undefined) conditions.push(eq(jobs.kind, filter.kind));
  return conditions;
}

export async function listJobRows(
  exec: Executor,
  filter: {
    readonly status?: JobStatus;
    readonly kind?: JobKind;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<JobRow[]> {
  const conditions = jobConditions(filter);
  const base = exec.select().from(jobs);
  const rows = await (conditions.length === 0 ? base : base.where(and(...conditions)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
  return rows.map(toRow);
}

export async function countJobs(
  exec: Executor,
  filter: { readonly status?: JobStatus; readonly kind?: JobKind } = {},
): Promise<number> {
  const conditions = jobConditions(filter);
  const query = exec.select({ total: sql<number>`count(*)::int` }).from(jobs);
  const [row] = await (conditions.length === 0 ? query : query.where(and(...conditions)));
  return Number(row?.total ?? 0);
}

export async function getJobRow(exec: Executor, jobId: string): Promise<JobRow | null> {
  const [row] = await exec.select().from(jobs).where(eq(jobs.id, jobId));
  return row === undefined ? null : toRow(row);
}

/**
 * Claims the oldest due, queued job — atomically.
 *
 * One statement: the `WHERE` re-checks `status = 'queued'` at write time, so if another worker
 * claimed this row a microsecond earlier the update matches nothing and this returns `null`.
 * No advisory locks, no `FOR UPDATE SKIP LOCKED`, no second round-trip to lose a race in.
 */
export async function claimNextJob(exec: Executor, now: Date): Promise<JobRow | null> {
  const [next] = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lte(jobs.scheduledFor, now)))
    .orderBy(asc(jobs.scheduledFor), asc(jobs.createdAt))
    .limit(1);
  if (next === undefined) return null;

  const claimed = await exec
    .update(jobs)
    .set({
      status: 'running',
      startedAt: now,
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')))
    .returning();
  const row = claimed[0];
  return row === undefined ? null : toRow(row);
}

export async function finishJobRow(
  exec: Executor,
  jobId: JobId,
  outcome: {
    readonly status: Extract<JobStatus, 'succeeded' | 'failed'>;
    readonly result?: unknown;
    readonly lastError?: string;
    readonly finishedAt: Date;
  },
): Promise<void> {
  await exec
    .update(jobs)
    .set({
      status: outcome.status,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.lastError === undefined ? {} : { lastError: outcome.lastError }),
      finishedAt: outcome.finishedAt,
      updatedAt: outcome.finishedAt,
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Puts a failed job back in the queue.
 *
 * `attempts` is deliberately left where it is: a retry that reset the count would hide a job
 * failing over and over, which is exactly the thing worth seeing.
 */
export async function resetJobForRetry(exec: Executor, jobId: string, now: Date): Promise<void> {
  await exec
    .update(jobs)
    .set({
      status: 'queued',
      // Cleared because the constraint says a queued job has not started — and because the
      // next run's `started_at` is the one that describes it. `attempts` carries the history.
      startedAt: null,
      finishedAt: null,
      scheduledFor: now,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['failed', 'cancelled'])));
}

export async function cancelJobRow(
  exec: Executor,
  jobId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await exec
    .update(jobs)
    .set({ status: 'cancelled', lastError: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])));
}
