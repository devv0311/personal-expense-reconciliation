/**
 * `src/integrations/document-text` — taking text off a stored receipt's bytes (audit row 14).
 *
 * A generated PDF is read locally and never leaves the machine. A photograph needs optical
 * extraction, which this build can only do through a multimodal model, which means the bytes
 * crossing the local boundary — a deliberate, configured, opt-in decision recorded in
 * ADR-0051 and refused by default.
 */

export * from './composite.js';
export * from './local.js';
export * from './port.js';
export * from './vision.js';
