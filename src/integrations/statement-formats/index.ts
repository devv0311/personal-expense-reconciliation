/**
 * `src/integrations/statement-formats` — reading a real statement, whatever shape it arrived in.
 *
 * The audit's row 02 in one module: bank-specific CSV column maps, UPI app exports, card
 * statements, XLSX workbooks and generated-PDF text layers. `integrations/bank-csv` remains
 * beside it, unchanged, as the one synthetic five-column format phase 6 shipped — this package
 * neither replaces nor re-implements it.
 */

export * from './formats.js';
export * from './parse.js';
export * from './pdf-text.js';
export * from './table.js';
export * from './types.js';
export * from './xlsx.js';
