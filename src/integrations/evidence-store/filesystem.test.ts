import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFilesystemEvidenceStore } from './filesystem.js';
import { isEvidenceStoreError, type EvidenceStore } from './store.js';

/** Tiny synthetic documents. Nothing in `fixtures/` is real, and neither are these. */
const RECEIPT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const OTHER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03, 0x04]);

let root: string;
let store: EvidenceStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evidence-store-'));
  store = createFilesystemEvidenceStore({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the filesystem evidence store', () => {
  it('stores a document and reads it back byte for byte', async () => {
    const stored = await store.put(RECEIPT, 'image/png');

    expect(stored.storageRef).toMatch(/^sha256\/[0-9a-f]{64}\.png$/);
    expect(stored.byteSize).toBe(RECEIPT.byteLength);
    expect(stored.mediaType).toBe('image/png');

    const read = await store.get(stored.storageRef);
    expect(read.mediaType).toBe('image/png');
    expect([...read.bytes]).toEqual([...RECEIPT]);
  });

  it('addresses the same bytes at the same ref, so re-storing is not a second copy', async () => {
    const first = await store.put(RECEIPT, 'image/png');
    const second = await store.put(RECEIPT, 'image/png');

    expect(second.storageRef).toBe(first.storageRef);
    expect(await countStoredFiles(root)).toBe(1);
  });

  it('gives different bytes different refs', async () => {
    const first = await store.put(RECEIPT, 'image/png');
    const second = await store.put(OTHER, 'image/png');

    expect(second.storageRef).not.toBe(first.storageRef);
    expect(await countStoredFiles(root)).toBe(2);
  });

  it('addresses the same bytes separately per format', async () => {
    // The digest is the same; the extension is what a reader needs to open the document.
    const png = await store.put(RECEIPT, 'image/png');
    const pdf = await store.put(RECEIPT, 'application/pdf');

    expect(pdf.storageRef).not.toBe(png.storageRef);
    expect((await store.get(pdf.storageRef)).mediaType).toBe('application/pdf');
  });

  it('reports a ref it has nothing stored under, rather than an empty document', async () => {
    const missing = `sha256/${'b'.repeat(64)}.jpg`;

    expect(await store.has(missing)).toBe(false);

    let raised: unknown;
    try {
      await store.get(missing);
    } catch (error) {
      raised = error;
    }
    expect(isEvidenceStoreError(raised) && raised.code).toBe('DOCUMENT_NOT_STORED');
  });

  it('never resolves a malformed ref to a location', async () => {
    // The guard is the point: a value out of the database must not be able to walk out of the
    // storage root.
    await expect(store.get('sha256/../../../etc/passwd')).rejects.toThrow(/storage ref/i);
    await expect(store.has('../outside.jpg')).rejects.toThrow(/storage ref/i);
  });

  it('leaves an existing document untouched', async () => {
    const stored = await store.put(RECEIPT, 'image/png');
    await store.put(RECEIPT, 'image/png');

    // Content addressing means an existing object already holds exactly these bytes; the one
    // case where that would not hold is a SHA-256 collision, which overwriting would not fix.
    expect([...(await store.get(stored.storageRef)).bytes]).toEqual([...RECEIPT]);
  });

  it('creates its root on first write rather than at construction', async () => {
    const unusedRoot = join(root, 'not-yet');
    const lazy = createFilesystemEvidenceStore({ root: unusedRoot });

    await expect(readdir(unusedRoot)).rejects.toThrow();

    const stored = await lazy.put(RECEIPT, 'image/png');
    expect(await lazy.has(stored.storageRef)).toBe(true);
  });

  it('reports a storage failure as a storage failure, without naming a host path', async () => {
    // A file where the shard directory needs to be: the write cannot succeed, and the caller
    // gets a store failure rather than a domain error about the document.
    const blocked = createFilesystemEvidenceStore({ root: join(root, 'blocked') });
    await writeFile(join(root, 'blocked'), 'not a directory');

    let raised: unknown;
    try {
      await blocked.put(RECEIPT, 'image/png');
    } catch (error) {
      raised = error;
    }
    expect(isEvidenceStoreError(raised) && raised.code).toBe('STORE_UNAVAILABLE');
    expect((raised as Error).message).not.toContain(root);
  });
});

async function countStoredFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).length;
}
