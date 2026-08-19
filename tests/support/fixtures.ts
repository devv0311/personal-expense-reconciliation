/**
 * Loading synthetic fixtures without letting a float near a monetary value.
 *
 * `fixtures/*.json` records rupee amounts as JSON numbers (`"amount_inr": 900.0`) because
 * they were written to be read by humans. `JSON.parse` turns those into IEEE-754 doubles,
 * and `900.0 * 100` is exact but `8.29 * 100` is `828.9999999999999` — so converting after
 * parsing would reintroduce, in the test harness, exactly the class of error
 * `invariants.md` #12 exists to prevent.
 *
 * Instead, the raw text of every `*_inr` value is quoted **before** parsing, so it arrives
 * as an exact decimal string and goes through `domain.parseMajorUnitsToPaise`. No fixture
 * had to change; the loader adapts to them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMajorUnitsToPaise } from '../../src/domain/index.js';
import type { Paise } from '../../src/domain/index.js';

const FIXTURES_DIR = join(process.cwd(), 'fixtures');

/**
 * Matches a JSON number that is the value of a key ending in `_inr`.
 *
 * Anchored on the quoted key and the `:` so it cannot touch a number appearing anywhere
 * else in the document.
 */
const RUPEE_VALUE = /("(?:[A-Za-z0-9_]*_inr)"\s*:\s*)(-?\d+(?:\.\d+)?)/g;

/**
 * Reads a fixture, returning every `*_inr` value as an exact decimal **string**.
 *
 * Use {@link fixturePaise} to turn one into {@link Paise}.
 */
export function loadFixture<T>(fileName: string): T {
  const raw = readFileSync(join(FIXTURES_DIR, fileName), 'utf8');
  return JSON.parse(raw.replace(RUPEE_VALUE, '$1"$2"')) as T;
}

/** Converts a fixture's `*_inr` string to exact paise. */
export function fixturePaise(majorUnits: unknown): Paise {
  if (typeof majorUnits !== 'string') {
    throw new Error(
      `Expected a fixture rupee amount to have been loaded as a string, got ` +
        `${typeof majorUnits}. Load the file with loadFixture() so the value never passes ` +
        'through a float.',
    );
  }
  return parseMajorUnitsToPaise(majorUnits);
}

/** The shape of `fixtures/people-and-groups.json` this suite relies on. */
export interface PeopleAndGroupsFixture {
  people: Array<{ id: string; display_name: string; linked_user_id?: string; notes?: string }>;
  groups: Array<{ id: string; name: string; type: string }>;
  group_memberships: Array<{
    group_id: string;
    person_id: string;
    joined_at: string;
    left_at: string | null;
  }>;
  accounts: Array<{
    id: string;
    owner_person_id: string;
    name: string;
    type: string;
    institution?: string;
    last4?: string;
  }>;
}

export function loadPeopleAndGroups(): PeopleAndGroupsFixture {
  return loadFixture<PeopleAndGroupsFixture>('people-and-groups.json');
}

/** The shape of `fixtures/merchants.json`. */
export interface MerchantsFixture {
  merchants: Array<{
    id: string;
    canonical_name: string;
    default_category?: string;
    aliases: string[];
  }>;
}

export function loadMerchants(): MerchantsFixture {
  return loadFixture<MerchantsFixture>('merchants.json');
}

/** The shape of `fixtures/ai-classification-proposals.json`. */
export interface ClassificationProposalsFixture {
  model: { provider: string; model: string };
  responses: Array<{ redacted_description: string; why: string; response: unknown }>;
}

export function loadClassificationProposals(): ClassificationProposalsFixture {
  return loadFixture<ClassificationProposalsFixture>('ai-classification-proposals.json');
}
