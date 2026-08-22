/**
 * The evidence store: what a document store must do, and what a `storage_ref` means.
 *
 * `Evidence.storage_ref` points outside the database — filesystem in development,
 * S3-compatible object storage in production (`security-model.md`, `system-architecture.md`).
 * This file is the seam between those two: a port narrow enough that a second adapter is a new
 * file rather than a change to anything that ingests evidence.
 *
 * **Refs are content-addressed.** A ref is `sha256/<digest>.<ext>`, derived from the bytes
 * themselves, which buys three properties the ledger would otherwise have to enforce by
 * policy:
 *
 *  - A ref can never come to point at different bytes. `Evidence` is immutable
 *    (`invariants.md` #4), and with a content address that immutability is a property of the
 *    layout rather than a rule someone has to remember.
 *  - Storing the same photograph twice is free and deterministic — the same bytes produce the
 *    same ref — so re-ingesting a receipt cannot quietly produce a second copy of it.
 *  - Nothing about the user is encoded in the path. A merchant name or an original filename in
 *    a storage key leaks financial context into a system whose access is deliberately governed
 *    separately from the database's (`security-model.md`).
 *
 * The ref is a **logical key**, not a path: the `sha256/` prefix names the addressing scheme,
 * and how an adapter lays that out underneath — sharded directories, a flat object key — is
 * the adapter's business and never the database's.
 *
 * There is no `delete`. Evidence is never deleted while it is referenced, so the port does not
 * offer the verb; an adapter that cannot express deletion cannot be talked into it.
 */

import {
  evidenceMediaTypeForExtension,
  extensionForEvidenceMediaType,
} from '../../domain/index.js';
import type { EvidenceMediaType } from '../../domain/index.js';

/** Stable reasons the store refused or failed, so callers branch on a code, not a message. */
export type EvidenceStoreErrorCode =
  /** The ref is not a well-formed content address this system could have produced. */
  | 'STORAGE_REF_MALFORMED'
  /** The ref is well-formed, but no document is stored under it. */
  | 'DOCUMENT_NOT_STORED'
  /** The underlying storage could not be read or written. */
  | 'STORE_UNAVAILABLE';

export class EvidenceStoreError extends Error {
  public readonly code: EvidenceStoreErrorCode;
  public readonly details: Readonly<Record<string, string>>;

  constructor(
    code: EvidenceStoreErrorCode,
    message: string,
    details: Record<string, string> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EvidenceStoreError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isEvidenceStoreError(error: unknown): error is EvidenceStoreError {
  return error instanceof EvidenceStoreError;
}

/** What a stored document is, from the ledger's point of view: a ref and two facts about it. */
export interface StoredDocument {
  /** Goes into `evidence.storage_ref`. */
  readonly storageRef: string;
  readonly mediaType: EvidenceMediaType;
  readonly byteSize: number;
}

/** A document read back out. */
export interface EvidenceDocument {
  readonly bytes: Uint8Array;
  readonly mediaType: EvidenceMediaType;
}

/**
 * The document store, as everything above it sees it.
 *
 * Injected into the services that need it rather than imported, so a test runs against memory,
 * development runs against the filesystem, and production runs against object storage without
 * any of them being a different code path (the same shape ADR-0025 uses for the model
 * transport).
 */
export interface EvidenceStore {
  /**
   * Stores bytes and returns their address.
   *
   * Idempotent by construction: the same bytes yield the same ref, and storing them again is a
   * no-op rather than a second copy.
   */
  put(bytes: Uint8Array, mediaType: EvidenceMediaType): Promise<StoredDocument>;
  /** @throws EvidenceStoreError `DOCUMENT_NOT_STORED` if nothing is stored under the ref. */
  get(storageRef: string): Promise<EvidenceDocument>;
  has(storageRef: string): Promise<boolean>;
}

/* --------------------------------------------------------------------------- the ref */

const STORAGE_SCHEME = 'sha256';

/**
 * `sha256/<64 lowercase hex>.<extension>`, and nothing else.
 *
 * Anchored and exact because this pattern is the only thing standing between a value read
 * out of the database and a filesystem path. `..`, an absolute path, a NUL byte, or a
 * plausible-looking key from a different system all fail here rather than at whichever
 * adapter happens to be configured (`security-model.md`).
 */
const STORAGE_REF_PATTERN = /^sha256\/([0-9a-f]{64})\.([a-z0-9]{2,5})$/;

/** A parsed ref: the digest that addresses the bytes, and what they are. */
export interface ParsedStorageRef {
  readonly digest: string;
  readonly extension: string;
  readonly mediaType: EvidenceMediaType;
}

/** Builds the ref for a digest and a media type. */
export function evidenceStorageRef(digest: string, mediaType: EvidenceMediaType): string {
  return `${STORAGE_SCHEME}/${digest}.${extensionForEvidenceMediaType(mediaType)}`;
}

/**
 * Reads a ref, or refuses it.
 *
 * @throws EvidenceStoreError `STORAGE_REF_MALFORMED` for anything this system could not have
 *   produced — including a well-shaped ref whose extension names a format no longer stored,
 *   which would otherwise be read back with a media type nobody validated.
 */
export function parseEvidenceStorageRef(storageRef: string): ParsedStorageRef {
  const match = STORAGE_REF_PATTERN.exec(storageRef);
  if (match === null) {
    throw new EvidenceStoreError(
      'STORAGE_REF_MALFORMED',
      `"${storageRef}" is not an evidence storage ref. Expected sha256/<64 hex>.<extension>, ` +
        'which is the only shape this store produces and the only one it will resolve to a ' +
        'location.',
      { storageRef },
    );
  }

  const [, digest, extension] = match as unknown as [string, string, string];
  const mediaType = evidenceMediaTypeForExtension(extension);
  if (mediaType === null) {
    throw new EvidenceStoreError(
      'STORAGE_REF_MALFORMED',
      `"${storageRef}" names the extension "${extension}", which is not a format this system ` +
        'stores. Reading it back would hand the caller a document with an unvalidated type.',
      { storageRef, extension },
    );
  }

  return { digest, extension, mediaType };
}
