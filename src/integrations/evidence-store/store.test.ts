import { describe, expect, it } from 'vitest';

import { evidenceStorageRef, isEvidenceStoreError, parseEvidenceStorageRef } from './store.js';

const DIGEST = 'a'.repeat(64);

describe('evidence storage refs are content addresses, not paths', () => {
  it('builds a ref from a digest and a media type', () => {
    expect(evidenceStorageRef(DIGEST, 'image/jpeg')).toBe(`sha256/${DIGEST}.jpg`);
    expect(evidenceStorageRef(DIGEST, 'application/pdf')).toBe(`sha256/${DIGEST}.pdf`);
  });

  it('round-trips a ref back to its digest and media type', () => {
    const parsed = parseEvidenceStorageRef(evidenceStorageRef(DIGEST, 'image/png'));
    expect(parsed).toEqual({ digest: DIGEST, extension: 'png', mediaType: 'image/png' });
  });

  it.each([
    ['a traversal', 'sha256/../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a traversal hidden in the digest', `sha256/..${'a'.repeat(62)}.jpg`],
    ['trailing junk', `sha256/${DIGEST}.jpg.png`],
    ['uppercase hex, which this store never produces', `sha256/${'A'.repeat(64)}.jpg`],
    ['a short digest', 'sha256/abc.jpg'],
    ['a different scheme', `md5/${DIGEST}.jpg`],
    ['no extension', `sha256/${DIGEST}`],
    ['a legacy-looking key', 'evidence/2026/07/receipt-001.jpg'],
    ['an empty ref', ''],
  ])('refuses %s', (_label, storageRef) => {
    let raised: unknown;
    try {
      parseEvidenceStorageRef(storageRef);
    } catch (error) {
      raised = error;
    }
    expect(isEvidenceStoreError(raised) && raised.code).toBe('STORAGE_REF_MALFORMED');
  });

  it('refuses a well-shaped ref naming a format this system does not store', () => {
    // The pattern alone would accept it; reading it back would hand the caller a document
    // with a media type nothing validated.
    expect(() => parseEvidenceStorageRef(`sha256/${DIGEST}.exe`)).toThrow(
      /does not store|not a format/i,
    );
  });
});
