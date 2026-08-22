/**
 * An in-memory `EvidenceStore`, and synthetic documents to put in it.
 *
 * The same shape as `tests/support/ai.ts`: the real adapter has its own unit tests
 * (`src/integrations/evidence-store/filesystem.test.ts`), and everything above it should be
 * exercised without touching a disk. Content addressing is reproduced exactly — same bytes,
 * same ref — because that is the property the ingestion path depends on.
 */

import { createHash } from 'node:crypto';

import { extensionForEvidenceMediaType } from '../../src/domain/index.js';
import type { EvidenceMediaType } from '../../src/domain/index.js';
import {
  EvidenceStoreError,
  parseEvidenceStorageRef,
} from '../../src/integrations/evidence-store/index.js';
import type {
  EvidenceDocument,
  EvidenceStore,
  StoredDocument,
} from '../../src/integrations/evidence-store/index.js';

export interface MemoryEvidenceStore extends EvidenceStore {
  /** How many distinct documents are held — the assertion "this was not stored twice". */
  readonly size: () => number;
  /** Drops everything, for the case where a database outlives its object store. */
  readonly clear: () => void;
}

export function createMemoryEvidenceStore(): MemoryEvidenceStore {
  const documents = new Map<string, Uint8Array>();

  return {
    put(bytes: Uint8Array, mediaType: EvidenceMediaType): Promise<StoredDocument> {
      const digest = createHash('sha256').update(bytes).digest('hex');
      const storageRef = `sha256/${digest}.${extensionForEvidenceMediaType(mediaType)}`;
      if (!documents.has(storageRef)) {
        documents.set(storageRef, Uint8Array.from(bytes));
      }
      return Promise.resolve({ storageRef, mediaType, byteSize: bytes.byteLength });
    },

    get(storageRef: string): Promise<EvidenceDocument> {
      const { mediaType } = parseEvidenceStorageRef(storageRef);
      const bytes = documents.get(storageRef);
      if (bytes === undefined) {
        return Promise.reject(
          new EvidenceStoreError(
            'DOCUMENT_NOT_STORED',
            `No document is stored under "${storageRef}".`,
            { storageRef },
          ),
        );
      }
      return Promise.resolve({ bytes, mediaType });
    },

    has(storageRef: string): Promise<boolean> {
      parseEvidenceStorageRef(storageRef);
      return Promise.resolve(documents.has(storageRef));
    },

    size: () => documents.size,
    clear: () => documents.clear(),
  };
}

/**
 * A synthetic document with distinguishable bytes.
 *
 * Real receipts are financial documents and never enter this repository
 * (`fixtures/README.md`); a PNG signature followed by a label is enough for every property
 * these tests assert, all of which are about addressing and linkage rather than about pixels.
 */
export function syntheticDocument(label: string): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return Uint8Array.from([...signature, ...Buffer.from(label, 'utf8')]);
}
