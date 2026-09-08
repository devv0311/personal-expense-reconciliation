/**
 * The background job queue (audit row 51).
 *
 * `system-architecture.md` promised *"a lightweight Postgres-backed job queue"* and nothing
 * implemented it, so every import, classification run and extraction happened inside the
 * request that asked for it — fine for the small synchronous calculations, and not fine once a
 * statement import triggers a classification run against a model that takes a minute.
 *
 * What a job is, precisely: an **orchestration** record. It calls services that already refuse
 * to approve anything without a person, so the worst a job can do unattended is fill the review
 * queue. Nothing here carries an amount, and no `JOB_KINDS` member approves anything.
 *
 * Failure is visible and retryable rather than silent. `attempts`, `last_error` and an explicit
 * `failed` state exist so a job that did not happen is something a person can see and re-run —
 * the same reason `import_batches` keeps a content hash rather than trusting that an import
 * that returned must have worked.
 */

import type { JobKind, JobStatus } from '../domain/index.js';
import {
  cancelJobRow,
  claimNextJob,
  countJobs,
  finishJobRow,
  getJobRow,
  insertJob,
  listJobRows,
  resetJobForRetry,
} from '../db/index.js';
import type { Database, Executor, JobRow } from '../db/index.js';

import type { AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

export type { JobRow } from '../db/index.js';

export interface EnqueueJobInput {
  readonly kind: JobKind;
  /** The job's input. Never document bytes — those stay in the evidence store. */
  readonly payload?: Record<string, unknown>;
  readonly scheduledFor?: Date;
  readonly maxAttempts?: number;
  readonly actor: string;
}

/**
 * Queues one job.
 *
 * Deliberately **not** audited through `runAudited`: queueing work changes no financial state,
 * and writing an `AuditEvent` for it would mix "somebody asked for a classification run" into
 * the same log that answers "who approved this allocation". The job row is its own record, with
 * its own actor and timestamps.
 */
export async function enqueueJob(
  db: Executor,
  input: EnqueueJobInput,
): Promise<{ readonly jobId: string }> {
  const jobId = await insertJob(db, {
    kind: input.kind,
    payload: input.payload ?? {},
    actor: input.actor,
    ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
  });
  return { jobId };
}

export interface JobListResult {
  readonly jobs: readonly JobRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export async function listJobs(
  db: Executor,
  filter: {
    readonly status?: JobStatus;
    readonly kind?: JobKind;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<JobListResult> {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const [jobs, total] = await Promise.all([
    listJobRows(db, { ...filter, limit, offset }),
    countJobs(db, filter),
  ]);
  return { jobs, total, limit, offset };
}

export async function getJob(db: Executor, jobId: string): Promise<JobRow> {
  const job = await getJobRow(db, jobId);
  if (job === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such job.', { jobId });
  }
  return job;
}

/**
 * Re-queues a failed job.
 *
 * Resets `started_at`/`finished_at` and leaves `attempts` where it is, so the record still
 * shows how many times this work has been tried. A retry that pretended to be a first attempt
 * would hide a job failing repeatedly, which is exactly what a person needs to see.
 */
export async function retryJob(
  db: Database,
  input: { readonly jobId: string; readonly audit: AuditMeta },
): Promise<JobRow> {
  const job = await getJob(db, input.jobId);
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `This job is "${job.status}". Only a failed or cancelled job can be retried — retrying a ` +
        'running one would do the same work twice.',
      { jobId: input.jobId, status: job.status },
    );
  }
  await resetJobForRetry(db, input.jobId, new Date());
  return getJob(db, input.jobId);
}

export async function cancelJob(db: Executor, jobId: string, reason: string): Promise<JobRow> {
  const job = await getJob(db, jobId);
  if (job.status === 'succeeded') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This job already finished. Cancelling it would misreport work that actually happened.',
      { jobId },
    );
  }
  await cancelJobRow(db, jobId, reason, new Date());
  return getJob(db, jobId);
}

/** What a worker is handed, and what it reports back. */
export type JobHandler = (job: JobRow) => Promise<Record<string, unknown> | undefined>;

export interface RunNextJobResult {
  readonly ran: boolean;
  readonly job?: JobRow;
  readonly outcome?: 'succeeded' | 'failed';
  readonly error?: string;
}

/**
 * Claims and runs one job, or reports that there was nothing to run.
 *
 * Claiming is a conditional `UPDATE ... RETURNING`, so two workers racing for the same row
 * cannot both get it — the second one's update matches nothing and it moves on. That is the
 * whole of the concurrency design, and it is enough: this is a personal ledger, and a queue
 * that needs more than one row-level guarantee is a queue doing more than this one should.
 *
 * A handler that throws marks the job `failed` with its message, and the job stays in the list
 * for a person to retry. It never silently disappears, and it never retries itself into a loop.
 */
export async function runNextJob(
  db: Database,
  handlers: Readonly<Partial<Record<JobKind, JobHandler>>>,
  now: Date = new Date(),
): Promise<RunNextJobResult> {
  const job = await claimNextJob(db, now);
  if (job === null) return { ran: false };

  const handler = handlers[job.kind];
  if (handler === undefined) {
    const message = `No handler is registered for "${job.kind}".`;
    await finishJobRow(db, job.id, { status: 'failed', lastError: message, finishedAt: now });
    return { ran: true, job, outcome: 'failed', error: message };
  }

  try {
    const result = await handler(job);
    await finishJobRow(db, job.id, {
      status: 'succeeded',
      result: result ?? {},
      finishedAt: new Date(),
    });
    return { ran: true, job, outcome: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJobRow(db, job.id, {
      status: 'failed',
      lastError: message,
      finishedAt: new Date(),
    });
    return { ran: true, job, outcome: 'failed', error: message };
  }
}
