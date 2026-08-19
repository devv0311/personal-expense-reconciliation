/**
 * `src/services` — orchestration.
 *
 * The only layer allowed to write APPROVED-classified data, and where the "every mutation
 * writes an AuditEvent" rule is enforced structurally rather than left to each call site
 * (`invariants.md` #21 — see `audit.ts`).
 *
 * Depends on `src/domain` for every financial rule and on `src/db` for persistence. There
 * is no arithmetic in this layer: if a calculation appears here rather than being called
 * from `domain`, that is a bug in the layering, not a shortcut.
 */

export * from './audit.js';
export * from './errors.js';
export * from './loaders.js';
export * from './import-service.js';
export * from './normalization-service.js';
export * from './classification-service.js';
export * from './inference-decision-service.js';
export * from './review-service.js';
export * from './review-action-service.js';
export * from './expense-service.js';
export * from './allocation-service.js';
export * from './settlement-service.js';
export * from './adjustment-service.js';
export * from './balance-service.js';

/**
 * The two handles every service call needs, re-exported so a caller — `src/api`, a future
 * server — depends on this layer alone rather than reaching past it into `src/db` and
 * `src/ai` for a type (`system-architecture.md`, "dependency direction is inward").
 */
export type { Database } from '../db/index.js';
export type { AiService } from '../ai/index.js';
