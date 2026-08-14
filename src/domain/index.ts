/**
 * `src/domain` — pure, deterministic financial logic.
 *
 * No I/O, no framework imports, no AI, no database. Everything exported here is a plain
 * function over plain data, testable with a direct call and no mocks
 * (`docs/architecture/system-architecture.md`, Layering).
 *
 * This barrel is the layer's public surface: `src/services` imports from here, never from
 * an individual file, so the boundary stays visible in every import statement.
 */

export * from './allocation.js';
export * from './adjustment.js';
export * from './balance.js';
export * from './entities.js';
export * from './enums.js';
export * from './errors.js';
export * from './evidence.js';
export * from './expense.js';
export * from './group-expansion.js';
export * from './ids.js';
export * from './immutability.js';
export * from './lifecycle.js';
export * from './money.js';
export * from './payment.js';
export * from './reconciliation.js';
export * from './rounding.js';
