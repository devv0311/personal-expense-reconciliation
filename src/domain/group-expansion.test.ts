import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  expandGroupAllocationLine,
  isGroupMembershipActiveAt,
  resolveGroupMembersAsOf,
  validateGroupExpansionSum,
} from './group-expansion.js';
import { asId } from './ids.js';
import type { GroupId, PersonId } from './ids.js';
import { paise, sumPaise } from './money.js';
import type { GroupMembership } from './entities.js';

const dev = asId<'person'>('person_dev');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateB = asId<'person'>('person_flatmate_b');
const flatmateC = asId<'person'>('person_flatmate_c');
const flatmateD = asId<'person'>('person_flatmate_d');
const flat = asId<'group'>('group_flat');
const trip = asId<'group'>('group_goa_trip');

let membershipCounter = 0;
function membership(
  groupId: GroupId,
  personId: PersonId,
  joinedAt: string,
  leftAt: string | null = null,
): GroupMembership {
  membershipCounter += 1;
  return {
    id: asId<'group_membership'>(`membership_${membershipCounter}`),
    groupId,
    personId,
    joinedAt: new Date(joinedAt),
    leftAt: leftAt === null ? null : new Date(leftAt),
  };
}

/** The Flat membership timeline from `fixtures/people-and-groups.json`. */
const flatMemberships: GroupMembership[] = [
  membership(flat, dev, '2025-01-01T00:00:00Z'),
  membership(flat, flatmateA, '2025-01-01T00:00:00Z'),
  membership(flat, flatmateB, '2025-01-01T00:00:00Z', '2026-06-30T00:00:00Z'),
  membership(flat, flatmateC, '2026-07-01T00:00:00Z', '2026-08-31T00:00:00Z'),
  membership(flat, flatmateD, '2026-09-01T00:00:00Z'),
  membership(trip, dev, '2026-05-01T00:00:00Z'),
];

describe('isGroupMembershipActiveAt — half-open [joinedAt, leftAt)', () => {
  const stint = membership(flat, flatmateC, '2026-07-01T00:00:00Z', '2026-08-31T00:00:00Z');

  it('is active on the joining instant', () => {
    expect(isGroupMembershipActiveAt(stint, new Date('2026-07-01T00:00:00Z'))).toBe(true);
  });

  it('is active during the stint', () => {
    expect(isGroupMembershipActiveAt(stint, new Date('2026-07-10T08:00:00Z'))).toBe(true);
  });

  it('is not yet active before joining', () => {
    expect(isGroupMembershipActiveAt(stint, new Date('2026-06-30T23:59:59Z'))).toBe(false);
  });

  it('is no longer active on the leaving instant', () => {
    expect(isGroupMembershipActiveAt(stint, new Date('2026-08-31T00:00:00Z'))).toBe(false);
  });

  it('treats a null leftAt as still active', () => {
    const open = membership(flat, dev, '2025-01-01T00:00:00Z');

    expect(isGroupMembershipActiveAt(open, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('resolveGroupMembersAsOf — scenario §33', () => {
  it('resolves the July flat as Dev, Flatmate A and Flatmate C', () => {
    const members = resolveGroupMembersAsOf(
      flatMemberships,
      flat,
      new Date('2026-07-10T08:00:00Z'),
    );

    expect(members).toEqual([dev, flatmateA, flatmateC]);
  });

  it('excludes Flatmate B, who had already left, and Flatmate D, who had not joined', () => {
    const members = resolveGroupMembersAsOf(
      flatMemberships,
      flat,
      new Date('2026-07-10T08:00:00Z'),
    );

    expect(members).not.toContain(flatmateB);
    expect(members).not.toContain(flatmateD);
  });

  it('resolves the September flat as Dev, Flatmate A and Flatmate D', () => {
    const members = resolveGroupMembersAsOf(
      flatMemberships,
      flat,
      new Date('2026-09-10T08:00:00Z'),
    );

    expect(members).toEqual([dev, flatmateA, flatmateD]);
  });

  it('resolves membership as of the expense date, never as of today', () => {
    const asOfJune = resolveGroupMembersAsOf(
      flatMemberships,
      flat,
      new Date('2026-06-15T00:00:00Z'),
    );

    expect(asOfJune).toEqual([dev, flatmateA, flatmateB]);
  });

  it('ignores memberships of other groups', () => {
    const members = resolveGroupMembersAsOf(
      flatMemberships,
      trip,
      new Date('2026-07-10T08:00:00Z'),
    );

    expect(members).toEqual([dev]);
  });

  it('returns members in ascending id order, so the result is deterministic', () => {
    const shuffled = [...flatMemberships].reverse();

    expect(resolveGroupMembersAsOf(shuffled, flat, new Date('2026-07-10T08:00:00Z'))).toEqual([
      dev,
      flatmateA,
      flatmateC,
    ]);
  });

  it('counts a person who left and re-joined exactly once', () => {
    const rejoined = [
      membership(flat, flatmateB, '2025-01-01T00:00:00Z', '2026-06-30T00:00:00Z'),
      membership(flat, flatmateB, '2026-10-01T00:00:00Z'),
    ];

    expect(resolveGroupMembersAsOf(rejoined, flat, new Date('2026-11-01T00:00:00Z'))).toEqual([
      flatmateB,
    ]);
  });

  it('returns an empty list when nobody was a member at that time', () => {
    expect(
      resolveGroupMembersAsOf(flatMemberships, flat, new Date('2020-01-01T00:00:00Z')),
    ).toEqual([]);
  });
});

describe('expandGroupAllocationLine — matrix case 7: exact division', () => {
  it("splits July's ₹2,100 flat line into three ₹700 shares", () => {
    const rows = expandGroupAllocationLine({
      lineAmount: paise(210000n),
      members: [dev, flatmateA, flatmateC],
    });

    expect(rows).toEqual([
      { personId: dev, amount: 70000n },
      { personId: flatmateA, amount: 70000n },
      { personId: flatmateC, amount: 70000n },
    ]);
  });

  it('sums to the parent line amount exactly', () => {
    const rows = expandGroupAllocationLine({
      lineAmount: paise(210000n),
      members: [dev, flatmateA, flatmateC],
    });

    expect(sumPaise(rows.map((row) => row.amount))).toBe(210000n);
  });
});

describe('expandGroupAllocationLine — matrix case 8: remainder present', () => {
  it('splits ₹1,000 three ways, tie-broken by person_id ascending', () => {
    const rows = expandGroupAllocationLine({
      lineAmount: paise(100000n),
      members: [flatmateC, flatmateA, dev],
    });
    const byPerson = Object.fromEntries(rows.map((row) => [row.personId, row.amount]));

    expect(byPerson[dev]).toBe(33334n); // person_dev sorts first of the three
    expect(byPerson[flatmateA]).toBe(33333n);
    expect(byPerson[flatmateC]).toBe(33333n);
    expect(sumPaise(rows.map((row) => row.amount))).toBe(100000n);
  });

  it('is deterministic regardless of the order members are supplied in', () => {
    const forward = expandGroupAllocationLine({
      lineAmount: paise(100000n),
      members: [dev, flatmateA, flatmateC],
    });
    const reversed = expandGroupAllocationLine({
      lineAmount: paise(100000n),
      members: [flatmateC, flatmateA, dev],
    });

    expect(Object.fromEntries(forward.map((row) => [row.personId, row.amount]))).toEqual(
      Object.fromEntries(reversed.map((row) => [row.personId, row.amount])),
    );
  });
});

describe('expandGroupAllocationLine — user overrides', () => {
  it('uses supplied weights instead of an equal split', () => {
    const rows = expandGroupAllocationLine({
      lineAmount: paise(210000n),
      members: [dev, flatmateA, flatmateC],
      shareWeights: [
        { personId: dev, weight: 2n },
        { personId: flatmateA, weight: 1n },
        { personId: flatmateC, weight: 1n },
      ],
    });

    expect(rows.map((row) => row.amount)).toEqual([105000n, 52500n, 52500n]);
    expect(sumPaise(rows.map((row) => row.amount))).toBe(210000n);
  });

  it('rejects weights that do not cover every resolved member', () => {
    expect(() =>
      expandGroupAllocationLine({
        lineAmount: paise(210000n),
        members: [dev, flatmateA, flatmateC],
        shareWeights: [{ personId: dev, weight: 1n }],
      }),
    ).toThrow(DomainError);
  });

  it('rejects weights naming somebody who was not a member', () => {
    expect(() =>
      expandGroupAllocationLine({
        lineAmount: paise(210000n),
        members: [dev, flatmateA],
        shareWeights: [
          { personId: dev, weight: 1n },
          { personId: flatmateA, weight: 1n },
          { personId: flatmateD, weight: 1n },
        ],
      }),
    ).toThrow(/member/i);
  });
});

describe('expandGroupAllocationLine — boundary cases', () => {
  it('expands a zero-amount group line into zero-amount rows (ADR-0013)', () => {
    const rows = expandGroupAllocationLine({
      lineAmount: paise(0n),
      members: [dev, flatmateA],
    });

    expect(rows.map((row) => row.amount)).toEqual([0n, 0n]);
  });

  it('refuses to expand a group that resolved to nobody', () => {
    let raised: DomainError | undefined;
    try {
      expandGroupAllocationLine({ lineAmount: paise(210000n), members: [] });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('GROUP_EXPANSION_NO_MEMBERS');
  });

  it('rejects a duplicated member', () => {
    expect(() =>
      expandGroupAllocationLine({ lineAmount: paise(100n), members: [dev, dev] }),
    ).toThrow(DomainError);
  });
});

describe('validateGroupExpansionSum — invariant #2b', () => {
  it('passes when the rows sum to the parent line', () => {
    expect(() =>
      validateGroupExpansionSum(paise(210000n), [
        { personId: dev, amount: paise(70000n) },
        { personId: flatmateA, amount: paise(70000n) },
        { personId: flatmateC, amount: paise(70000n) },
      ]),
    ).not.toThrow();
  });

  it('fails when they do not', () => {
    expect(() =>
      validateGroupExpansionSum(paise(210000n), [{ personId: dev, amount: paise(70000n) }]),
    ).toThrow(DomainError);
  });

  it('fails when a group line has no expansion at all', () => {
    let raised: DomainError | undefined;
    try {
      validateGroupExpansionSum(paise(210000n), []);
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('GROUP_EXPANSION_MISSING');
  });
});
