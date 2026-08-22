/**
 * Evidence document storage.
 *
 * The port every ingestion path writes through, and the filesystem adapter development runs
 * on. See `store.ts` for what a `storage_ref` means and `README.md` for the boundary.
 */

export * from './store.js';
export * from './filesystem.js';
