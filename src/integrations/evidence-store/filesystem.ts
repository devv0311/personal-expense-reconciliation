/**
 * The development evidence store: documents on the local filesystem.
 *
 * `security-model.md` specifies filesystem in development and S3-compatible object storage in
 * production. This is the first half; the second is a sibling file implementing the same port,
 * and nothing above this layer changes when it arrives.
 *
 * Three things it is careful about:
 *
 *  - **A ref never becomes a path unchecked.** Every ref is parsed by
 *    `parseEvidenceStorageRef` first, so a value read out of the database cannot walk out of
 *    the storage root even if the column were somehow written by hand.
 *  - **Writes are atomic.** Bytes go to a temporary file in the same directory and are then
 *    renamed into place, which is atomic on a POSIX filesystem. A crash mid-write leaves a
 *    stray temp file, never a truncated document that a digest claims is complete.
 *  - **An existing object is never rewritten.** Under a content address, an existing object
 *    already holds exactly these bytes, so re-storing them is a no-op — and the one case where
 *    that would not hold, a SHA-256 collision, is not a case to resolve by overwriting.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { extensionForEvidenceMediaType } from '../../domain/index.js';
import type { EvidenceMediaType } from '../../domain/index.js';

import {
  EvidenceStoreError,
  evidenceStorageRef,
  parseEvidenceStorageRef,
  type EvidenceDocument,
  type EvidenceStore,
  type StoredDocument,
} from './store.js';

export interface FilesystemEvidenceStoreOptions {
  /** The storage root, e.g. `./local-data/evidence` (`.env.example`: `EVIDENCE_STORAGE_PATH`). */
  readonly root: string;
}

/**
 * Builds a store rooted at a directory.
 *
 * The directory is created on first write rather than at construction, so wiring a store into
 * an application that never ingests anything does not create a directory that stays empty.
 */
export function createFilesystemEvidenceStore(
  options: FilesystemEvidenceStoreOptions,
): EvidenceStore {
  const { root } = options;

  return {
    async put(bytes: Uint8Array, mediaType: EvidenceMediaType): Promise<StoredDocument> {
      const digest = createHash('sha256').update(bytes).digest('hex');
      const storageRef = evidenceStorageRef(digest, mediaType);
      const path = join(root, layoutFor(digest, mediaType));

      if (!(await exists(path))) {
        await writeAtomically(path, bytes);
      }

      return { storageRef, mediaType, byteSize: bytes.byteLength };
    },

    async get(storageRef: string): Promise<EvidenceDocument> {
      const { digest, mediaType } = parseEvidenceStorageRef(storageRef);
      const path = join(root, layoutFor(digest, mediaType));

      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if (isNotFound(error)) {
          throw new EvidenceStoreError(
            'DOCUMENT_NOT_STORED',
            `No document is stored under "${storageRef}". The evidence row survives a store ` +
              'it was separated from — a database restored without its documents, a ' +
              'misconfigured root — and saying so is more useful than an empty response.',
            { storageRef },
          );
        }
        throw unavailable('read', storageRef, error);
      }

      return { bytes: new Uint8Array(bytes), mediaType };
    },

    async has(storageRef: string): Promise<boolean> {
      const { digest, mediaType } = parseEvidenceStorageRef(storageRef);
      return exists(join(root, layoutFor(digest, mediaType)));
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * `sha256/<aa>/<bb>/<digest>.<ext>` — two levels of fan-out from the digest's own prefix.
 *
 * Layout, not identity: the ref stored in the database is the flat logical key, and an object
 * store implementing the same port can use it verbatim. The fan-out exists because a single
 * directory holding every receipt a person ever photographs is slow to list and unpleasant to
 * back up, and a digest's leading bytes are already uniformly distributed.
 */
function layoutFor(digest: string, mediaType: EvidenceMediaType): string {
  const extension = extensionForEvidenceMediaType(mediaType);
  return join('sha256', digest.slice(0, 2), digest.slice(2, 4), `${digest}.${extension}`);
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${counter()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw unavailable('write', path, error);
  }
}

let sequence = 0;
/** Distinguishes concurrent writes within one process; the rename is what makes it safe. */
function counter(): number {
  sequence += 1;
  return sequence;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw unavailable('read', path, error);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Wraps a filesystem failure without carrying it outward.
 *
 * The underlying message can name a path on the host, which `security-model.md` keeps out of
 * responses; the code is what a caller acts on, and the cause is retained for a log.
 */
function unavailable(operation: 'read' | 'write', subject: string, cause: unknown): Error {
  return new EvidenceStoreError(
    'STORE_UNAVAILABLE',
    `Evidence storage could not ${operation} the document. The ledger row and the document it ` +
      'points at are stored separately by design, and this is the storage half failing.',
    { operation, subject },
    { cause },
  );
}
