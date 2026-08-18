# Phase 7 Transaction Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move an imported payment to `normalized`, refining `channel` from `reference_type` and resolving a known merchant by exact alias match — deterministically, with no AI and no classification.

**Architecture:** Two pure functions in `src/domain/normalization.ts` hold every rule. Three query functions in `src/db/repositories.ts` hold every SQL statement. One service, `src/services/normalization-service.ts`, orchestrates them inside `runAudited` so the whole run is one audited transaction. The merchant catalog is a synthetic fixture seeded by the test harness, matching how `people-and-groups.json` already works.

**Tech Stack:** TypeScript (strict), Node 20+, Drizzle ORM, PostgreSQL 16 (PGlite fallback locally), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-phase-7-transaction-normalization-design.md`

## Global Constraints

- All monetary values are integer minor-unit `bigint` (`Paise`). This phase writes no monetary column, so no arithmetic is introduced — if you find yourself computing a number, stop, you are off-plan.
- `src/domain` may not import from `src/db`, `src/services`, `src/api`, or `src/integrations`. Dependencies point inward.
- `src/services` writes through `runAudited` only. **`runAudited` throws `AUDIT_EVENT_MISSING` and rolls back if the body records zero audit events** — see Task 5, which handles this deliberately rather than by accident.
- SOURCE columns are never written: `payments.amount`, `occurred_at`, `raw_description`, `account_id` (`invariants.md` #4). This phase writes only `channel`, `counterparty_type`, `counterparty_id`, `state`.
- The only `counterparty_type` this phase ever writes is `'merchant'`. Never `internal_account`, never `investment_instrument`, never `person`.
- `PAYMENT_CHANNELS` is `['upi','bank_transfer','card','cash','other']`. There is no `cheque` channel; do not add one.
- Before every commit: `npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test` must all pass.
- No schema migration. Every column and transition this phase needs already exists.

---

## File Structure

| File                                                | Responsibility                                                                             | Task    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| `src/domain/normalization.ts`                       | `refineChannel()`, `merchantAliasKey()` — pure rules                                       | 1, 2    |
| `src/domain/normalization.test.ts`                  | Unit tests for both                                                                        | 1, 2    |
| `src/domain/index.ts`                               | Add the barrel export                                                                      | 1       |
| `fixtures/merchants.json`                           | Synthetic merchant catalog                                                                 | 3       |
| `fixtures/README.md`                                | One table row for the new fixture                                                          | 3       |
| `tests/support/fixtures.ts`                         | `loadMerchants()`                                                                          | 3       |
| `tests/support/ledger.ts`                           | `seedMerchants()`                                                                          | 3       |
| `src/db/repositories.ts`                            | `listPaymentsAwaitingNormalization`, `findMerchantByAliasKey`, `applyPaymentNormalization` | 4       |
| `src/services/normalization-service.ts`             | `normalizePayments()`                                                                      | 5, 6    |
| `src/services/index.ts`                             | Add the barrel export                                                                      | 5       |
| `tests/integration/normalization.test.ts`           | End-to-end behaviour                                                                       | 5, 6    |
| `docs/decisions/0020-*.md` … `0022-*.md`            | Three ADRs                                                                                 | 1, 5, 7 |
| `docs/roadmap.md`, `docs/architecture/data-flow.md` | Phase status and the AI-leg deferral                                                       | 7       |

**Deliberately not created:** `insertMerchant` / `insertMerchantAlias` repository functions. The catalog is seeded by the test harness writing rows directly, exactly as `tests/support/ledger.ts` already does for people, groups, and accounts ("These helpers write rows directly. They deliberately do **not** go through `src/services`"). There is no production seeding entry point in this phase and no caller for those functions — adding them would be speculative abstraction, which CLAUDE.md rules out.

---

### Task 1: Channel refinement rule

**Files:**

- Create: `src/domain/normalization.ts`
- Create: `src/domain/normalization.test.ts`
- Modify: `src/domain/index.ts` (add one export line)
- Create: `docs/decisions/0020-reference-type-as-channel-evidence.md`

**Interfaces:**

- Consumes: `PaymentChannel`, `PaymentReferenceType` from `./enums.js`
- Produces: `refineChannel(referenceType: PaymentReferenceType | null, currentChannel: PaymentChannel): PaymentChannel`

- [ ] **Step 1: Write the failing test**

Create `src/domain/normalization.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { refineChannel } from './normalization.js';

describe('refineChannel — the channel a reference type proves', () => {
  it('refines a UPI reference to the upi channel', () => {
    expect(refineChannel('upi_utr', 'bank_transfer')).toBe('upi');
    expect(refineChannel('upi_rrn', 'bank_transfer')).toBe('upi');
  });

  it('refines a card reference to the card channel', () => {
    expect(refineChannel('card_reference', 'bank_transfer')).toBe('card');
  });

  it('leaves the adapter’s channel alone when the reference proves nothing', () => {
    // A bank reference says "this went through the banking system", which is what
    // bank_transfer already records. Refining it would add no information.
    expect(refineChannel('bank_reference', 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel('merchant_order_id', 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel('other', 'bank_transfer')).toBe('bank_transfer');
  });

  it('leaves the channel alone for a cheque, which has no channel to refine to', () => {
    // PAYMENT_CHANNELS has no `cheque` member. Mapping to `other` would be less
    // accurate than the transport the adapter actually recorded.
    expect(refineChannel('cheque_number', 'bank_transfer')).toBe('bank_transfer');
  });

  it('leaves the channel alone when the source carried no reference at all', () => {
    expect(refineChannel(null, 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel(null, 'cash')).toBe('cash');
  });

  it('never downgrades a channel the source already stated precisely', () => {
    expect(refineChannel('upi_utr', 'upi')).toBe('upi');
    expect(refineChannel('bank_reference', 'card')).toBe('card');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/normalization.test.ts`
Expected: FAIL — `Failed to resolve import "./normalization.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/normalization.ts`:

```ts
/**
 * Deterministic normalization rules (`data-flow.md` step 2, deterministic leg only).
 *
 * Pure: values in, values out. No I/O, no database, no clock. What a payment *is* — an
 * expense, a settlement, a transfer, an investment — is not decided here and has no code
 * path from here; that is classification (`lifecycle.md`, phase 8).
 */

import type { PaymentChannel, PaymentReferenceType } from './enums.js';

/**
 * The channel each reference type proves, where it proves one.
 *
 * Partial on purpose. A `bank_reference` says only "this went through the banking system",
 * which is exactly what the adapter already recorded as `bank_transfer`; and there is no
 * `cheque` member of `PAYMENT_CHANNELS` for `cheque_number` to map to. A type absent from
 * this table refines nothing, which is different from mapping it to `other`.
 */
const CHANNEL_BY_REFERENCE_TYPE: Partial<Record<PaymentReferenceType, PaymentChannel>> = {
  upi_utr: 'upi',
  upi_rrn: 'upi',
  card_reference: 'card',
};

/**
 * Refines a payment's channel from the reference the adapter extracted.
 *
 * `reference_type` is the *only* evidence consulted — deliberately not `raw_description`
 * (ADR-0020). It is a typed field produced by the adapter that owns format knowledge, so
 * matching a description here would duplicate that knowledge in a second layer, and reading
 * meaning out of a description is a heuristic, which `ai-boundary.md` assigns to inference.
 *
 * Falls back to the channel already recorded, never to a default: a source that carries no
 * reference yields no refinement, which is the correct answer rather than a gap.
 */
export function refineChannel(
  referenceType: PaymentReferenceType | null,
  currentChannel: PaymentChannel,
): PaymentChannel {
  if (referenceType === null) return currentChannel;
  return CHANNEL_BY_REFERENCE_TYPE[referenceType] ?? currentChannel;
}
```

- [ ] **Step 4: Add the barrel export**

In `src/domain/index.ts`, add the line in alphabetical position (between `./money.js` and `./payment.js`):

```ts
export * from './normalization.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/normalization.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write ADR-0020**

Create `docs/decisions/0020-reference-type-as-channel-evidence.md`, following the format of the existing ADRs (`docs/decisions/0019-import-time-duplicate-handling.md` is the closest model — read it first). It must state: status `Accepted`; the context that phase 6's importer sets `channel = bank_transfer` for every bank-statement row as the transport that captured it; the decision that `reference_type` is the sole deterministic evidence for refining it; that `raw_description` matching was rejected because it duplicates the adapter's format knowledge in the service layer and reads meaning out of a string, which is inference; and the consequence that a reference-less source yields no refinement by design.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
git add src/domain/normalization.ts src/domain/normalization.test.ts src/domain/index.ts docs/decisions/0020-reference-type-as-channel-evidence.md
git commit -m "Refine payment channel from reference_type, deterministically"
```

---

### Task 2: Merchant alias key

**Files:**

- Modify: `src/domain/normalization.ts` (append)
- Modify: `src/domain/normalization.test.ts` (append)

**Interfaces:**

- Consumes: nothing from earlier tasks
- Produces: `merchantAliasKey(rawDescription: string): string`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/normalization.test.ts`:

```ts
describe('merchantAliasKey — the canonical form a description matches on', () => {
  it('is unchanged for a description already canonical', () => {
    expect(merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD')).toBe(
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
  });

  it('ignores casing', () => {
    expect(merchantAliasKey('upi-blinkit9821paytm-blinkit india pvt ltd')).toBe(
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
  });

  it('ignores leading and trailing whitespace', () => {
    expect(merchantAliasKey('   ELECTRICITY BOARD BBPS BILLPAY  ')).toBe(
      'ELECTRICITY BOARD BBPS BILLPAY',
    );
  });

  it('collapses runs of internal whitespace, including tabs and newlines', () => {
    expect(merchantAliasKey('ELECTRICITY   BOARD\tBBPS\nBILLPAY')).toBe(
      'ELECTRICITY BOARD BBPS BILLPAY',
    );
  });

  it('maps descriptions differing only in casing and spacing onto one key', () => {
    expect(merchantAliasKey('  zomato0091   sample  ')).toBe(merchantAliasKey('ZOMATO0091 SAMPLE'));
  });

  it('does not collide descriptions that genuinely differ', () => {
    expect(merchantAliasKey('UPI-ZOMATO0091-A')).not.toBe(merchantAliasKey('UPI-ZOMATO0091-B'));
  });

  it('is empty for a description that is only whitespace', () => {
    // The importer rejects an empty description, so this cannot arrive from an import —
    // it is pinned so the function stays total rather than throwing on an odd input.
    expect(merchantAliasKey('   ')).toBe('');
  });
});
```

Update the existing import at the top of the file to:

```ts
import { merchantAliasKey, refineChannel } from './normalization.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/normalization.test.ts`
Expected: FAIL — `merchantAliasKey is not a function` (the import resolves, the export does not exist).

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/normalization.ts`:

```ts
/**
 * Reduces a raw statement description to the key an alias is matched on.
 *
 * `toUpperCase()`, never `toLocaleUpperCase()`: the former is locale-independent, and the
 * same statement normalized on a developer's machine and on a CI runner must produce the
 * same key — the same reason `integrations/bank-csv/parse.ts` fixes dates at UTC.
 *
 * This function produces the key on **both** sides: it is used when an alias is seeded and
 * again when a payment is matched, so `merchant_aliases.raw_pattern` always holds a
 * canonical key. A change to how keys are formed is therefore one change, in one place.
 * (Two copies of one rule drifting apart is a defect this project has already shipped —
 * ADR-0019's amendment.)
 */
export function merchantAliasKey(rawDescription: string): string {
  return rawDescription.trim().replace(/\s+/g, ' ').toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/normalization.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
git add src/domain/normalization.ts src/domain/normalization.test.ts
git commit -m "Add the canonical merchant alias key"
```

---

### Task 3: Merchant catalog fixture and seeding

**Files:**

- Create: `fixtures/merchants.json`
- Modify: `fixtures/README.md` (one row in the fixture table)
- Modify: `tests/support/fixtures.ts` (append loader)
- Modify: `tests/support/ledger.ts` (append seeder)
- Modify: `tests/support/fixtures.test.ts` (append a test)

**Interfaces:**

- Consumes: `merchantAliasKey` (Task 2), `loadFixture` from `tests/support/fixtures.ts`
- Produces: `loadMerchants(): MerchantsFixture`, `seedMerchants(db: Database): Promise<Record<string, MerchantId>>`

- [ ] **Step 1: Write the failing test**

Append to `tests/support/fixtures.test.ts`:

```ts
describe('fixtures/merchants.json', () => {
  it('covers every merchant description in the bank-statement fixture', () => {
    const fixture = loadMerchants();
    const aliasKeys = new Set(
      fixture.merchants.flatMap((merchant) => merchant.aliases.map(merchantAliasKey)),
    );

    // The five statement rows that name a merchant. The two self-transfers and the
    // person-to-person UPI row are deliberately absent: neither is a merchant, and
    // resolving them is not this phase's job.
    expect(aliasKeys).toContain(merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD'));
    expect(aliasKeys).toContain(merchantAliasKey('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD'));
    expect(aliasKeys).toContain(merchantAliasKey('ACH REFUND SAMPLE ELECTRONICS STORE'));
    expect(aliasKeys).toContain(merchantAliasKey('ELECTRICITY BOARD BBPS BILLPAY'));
    expect(aliasKeys).not.toContain(merchantAliasKey('NEFT TRANSFER TO SELF A/C X4821'));
    expect(aliasKeys).not.toContain(merchantAliasKey('UPI-FRIENDA-TRANSFER'));
  });

  it('gives every merchant a distinct id and every alias a distinct key', () => {
    const fixture = loadMerchants();
    const ids = fixture.merchants.map((merchant) => merchant.id);
    const aliasKeys = fixture.merchants.flatMap((merchant) =>
      merchant.aliases.map(merchantAliasKey),
    );

    // merchant_aliases.raw_pattern is UNIQUE — a duplicate here would fail at insert,
    // and would mean two merchants claiming one description.
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(aliasKeys).size).toBe(aliasKeys.length);
  });
});
```

Add to that file's imports:

```ts
import { merchantAliasKey } from '../../src/domain/index.js';
import { loadMerchants } from './fixtures.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/support/fixtures.test.ts`
Expected: FAIL — `loadMerchants` is not exported.

- [ ] **Step 3: Create the fixture**

Create `fixtures/merchants.json`:

```json
{
  "note": "Synthetic merchant catalog for deterministic normalization (phase 7). Every alias is the full raw description a statement row carries, matched exactly after canonicalization — never a prefix or a pattern.",
  "merchants": [
    {
      "id": "merchant_blinkit",
      "canonical_name": "Blinkit",
      "default_category": "groceries",
      "aliases": ["UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD"]
    },
    {
      "id": "merchant_sample_restaurant",
      "canonical_name": "Sample Restaurant",
      "default_category": "dining",
      "aliases": ["UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD"]
    },
    {
      "id": "merchant_sample_electronics",
      "canonical_name": "Sample Electronics Store",
      "default_category": "electronics",
      "aliases": ["ACH REFUND SAMPLE ELECTRONICS STORE"]
    },
    {
      "id": "merchant_electricity_board",
      "canonical_name": "Electricity Board",
      "default_category": "utilities",
      "aliases": ["ELECTRICITY BOARD BBPS BILLPAY"]
    }
  ]
}
```

- [ ] **Step 4: Add the loader**

Append to `tests/support/fixtures.ts`:

```ts
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
```

- [ ] **Step 5: Add the seeder**

Append to `tests/support/ledger.ts`:

```ts
/**
 * Inserts the synthetic merchant catalog, returning fixture id → database id.
 *
 * Alias patterns are stored as canonical keys, produced by the same `merchantAliasKey` the
 * normalization service matches with — the stored value *is* the key, so seeding and
 * matching cannot drift apart.
 */
export async function seedMerchants(db: Database): Promise<Record<string, MerchantId>> {
  const fixture = loadMerchants();
  const merchant: Record<string, MerchantId> = {};

  for (const entry of fixture.merchants) {
    const [row] = await db
      .insert(schema.merchants)
      .values({
        canonicalName: entry.canonical_name,
        defaultCategory: entry.default_category ?? null,
      })
      .returning({ id: schema.merchants.id });
    const merchantId = asId<'merchant'>(row!.id);
    merchant[entry.id] = merchantId;

    for (const alias of entry.aliases) {
      await db.insert(schema.merchantAliases).values({
        merchantId,
        rawPattern: merchantAliasKey(alias),
      });
    }
  }

  return merchant;
}
```

Add `MerchantId` to the existing `import type { … } from '../../src/domain/index.js';` block, add `merchantAliasKey` to the existing value import from that module, and add `loadMerchants` to the existing `from './fixtures.js'` import.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/support/fixtures.test.ts`
Expected: PASS.

- [ ] **Step 7: Document the fixture**

In `fixtures/README.md`, add a row to the fixture table (the one listing `bank-statement.csv`, `upi-transactions.json`, …):

```markdown
| `merchants.json` | Synthetic merchant catalog — canonical names and the exact raw descriptions that resolve to them (phase 7 normalization) |
```

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
git add fixtures/merchants.json fixtures/README.md tests/support/fixtures.ts tests/support/ledger.ts tests/support/fixtures.test.ts
git commit -m "Add a synthetic merchant catalog fixture and its seeding helper"
```

---

### Task 4: Repository queries

**Files:**

- Modify: `src/db/repositories.ts` (append to the payments section)
- Create: `tests/integration/normalization.test.ts` (repository-level tests only; the service tests land in Tasks 5–6)

**Interfaces:**

- Consumes: `merchantAliasKey` (Task 2), `seedMerchants` (Task 3)
- Produces:
  - `listPaymentsAwaitingNormalization(exec: Executor, importBatchId?: ImportBatchId): Promise<PaymentRow[]>`
  - `findMerchantByAliasKey(exec: Executor, aliasKey: string): Promise<MerchantId | null>`
  - `applyPaymentNormalization(exec: Executor, paymentId: PaymentId, next: { channel: PaymentChannel; counterpartyType: PaymentCounterpartyType; counterpartyId: MerchantId | null }): Promise<void>`

Note: `PaymentRow` already carries `id`, `amount`, `direction`, `counterpartyType`, `state`, `ignoredReason`, `occurredAt`, `externalReference`, `accountId`. It does **not** carry `channel`, `referenceType`, or `rawDescription`, which normalization needs. Extend `PaymentRow` with those three fields and add them to **both** existing selects (`getPaymentById` and `findPaymentsByExternalReference`) so the interface stays honest — the same change shape Task 5 of the duplicate-chain fix used when it added `ignoredReason`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/normalization.test.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { merchantAliasKey } from '../../src/domain/index.js';
import type { AccountId, MerchantId } from '../../src/domain/index.js';
import {
  findMerchantByAliasKey,
  listPaymentsAwaitingNormalization,
  schema,
} from '../../src/db/index.js';
import { importBankStatementCsv } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;
let merchant: Record<string, MerchantId>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
  merchant = await seedMerchants(database.db);
});

function importFixture(content: string = FIXTURE) {
  return importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: content,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
}

/**
 * One payment's id, by its external reference.
 *
 * Keyed on the reference rather than the description because two statement rows share the
 * Blinkit description — they are distinct transactions, and only the reference tells them
 * apart. `NEFT/N072026001` is shared by the two legs of one transfer, so callers wanting a
 * specific leg must not use it; the tests below use it only where either leg would do.
 */
async function paymentIdByReference(externalReference: string): Promise<PaymentId> {
  const [row] = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.externalReference, externalReference))
    .orderBy(asc(schema.payments.direction));
  return asId<'payment'>(row!.id);
}

describe('listPaymentsAwaitingNormalization', () => {
  it('returns every imported payment, with the fields normalization reads', async () => {
    await importFixture();

    const awaiting = await listPaymentsAwaitingNormalization(database.db);

    expect(awaiting).toHaveLength(8);
    expect(awaiting.every((row) => row.state === 'imported')).toBe(true);
    // The three columns normalization needs, which PaymentRow did not previously carry.
    expect(awaiting.every((row) => row.channel === 'bank_transfer')).toBe(true);
    expect(awaiting.every((row) => typeof row.rawDescription === 'string')).toBe(true);
    expect(awaiting.filter((row) => row.referenceType === 'upi_utr')).toHaveLength(4);
  });

  it('excludes a duplicate ignored at import', async () => {
    await importFixture();
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
    ].join('\n');
    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });

    const awaiting = await listPaymentsAwaitingNormalization(database.db);

    // 9 rows exist; the 9th is `ignored` and must never be offered for normalization.
    expect(await database.db.select({ id: schema.payments.id }).from(schema.payments)).toHaveLength(
      9,
    );
    expect(awaiting).toHaveLength(8);
    expect(awaiting.every((row) => row.state === 'imported')).toBe(true);
  });

  it('scopes to one import batch when asked', async () => {
    const first = await importFixture();
    if (first.outcome !== 'imported') throw new Error('expected an import');
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,UPI-NEWMERCHANT-SAMPLE,300.00,DEBIT,UPI/2607201234/NEW',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');

    expect(await listPaymentsAwaitingNormalization(database.db, second.importBatchId)).toHaveLength(
      1,
    );
    expect(await listPaymentsAwaitingNormalization(database.db, first.importBatchId)).toHaveLength(
      8,
    );
  });
});

describe('findMerchantByAliasKey', () => {
  it('finds a merchant by the canonical key of its alias', async () => {
    const found = await findMerchantByAliasKey(
      database.db,
      merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD'),
    );

    expect(found).toBe(merchant['merchant_blinkit']);
  });

  it('finds the same merchant from a differently-cased, differently-spaced description', async () => {
    const found = await findMerchantByAliasKey(
      database.db,
      merchantAliasKey('  upi-blinkit9821paytm-blinkit   india pvt ltd '),
    );

    expect(found).toBe(merchant['merchant_blinkit']);
  });

  it('returns null for a description no alias covers', async () => {
    expect(
      await findMerchantByAliasKey(
        database.db,
        merchantAliasKey('NEFT TRANSFER TO SELF A/C X4821'),
      ),
    ).toBeNull();
  });

  it('does not match on a prefix', async () => {
    // Exact equality only. A prefix match would let "UPI-BLINKIT" claim every Blinkit-like
    // description, which is a guess, not a deterministic resolution.
    expect(await findMerchantByAliasKey(database.db, merchantAliasKey('UPI-BLINKIT'))).toBeNull();
  });
});
```

Add to the imports at the top: `import { readFileSync } from 'node:fs';` and `import { join } from 'node:path';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: FAIL — `listPaymentsAwaitingNormalization` and `findMerchantByAliasKey` are not exported from `src/db/index.js`.

- [ ] **Step 3: Extend `PaymentRow` and both existing selects**

In `src/db/repositories.ts`, add three fields to `PaymentRow`:

```ts
export interface PaymentRow {
  readonly id: PaymentId;
  readonly amount: Paise;
  readonly direction: 'debit' | 'credit';
  readonly counterpartyType: string;
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  readonly accountId: string;
  /** Read by normalization to refine it (`domain.refineChannel`). */
  readonly channel: string;
  /** The evidence normalization refines `channel` from (ADR-0020). */
  readonly referenceType: string | null;
  /** Matched against `merchant_aliases.raw_pattern`, canonicalized first. */
  readonly rawDescription: string;
}
```

Then add these three lines to the `.select({ … })` of **both** `getPaymentById` and `findPaymentsByExternalReference`, so every producer of a `PaymentRow` fills the interface:

```ts
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
```

- [ ] **Step 4: Write the three new queries**

Append to the payments section of `src/db/repositories.ts` (after `findPaymentsByExternalReference`):

```ts
/**
 * Payments eligible for normalization: those still at `imported`.
 *
 * The state filter is the idempotency rule (ADR-0021), not an optimisation — a payment that
 * has already been normalized must not be offered again, or a re-run would silently rewrite
 * a counterparty someone may have since acted on. `ignored` rows are excluded by the same
 * filter, which is what keeps a duplicate discarded at import from being resurrected.
 *
 * The `(occurred_at, id)` ordering ties for same-day rows and is settled by a random UUID —
 * the same shape as two defects this project has already fixed. It is harmless *here* and
 * deliberately left alone: each payment is normalized independently of every other, so
 * processing order cannot change any stored result. Only the order of `normalizedPaymentIds`
 * in the return value varies, and nothing depends on it. If a future change ever makes one
 * payment's normalization depend on another's, this ordering stops being safe.
 */
export async function listPaymentsAwaitingNormalization(
  exec: Executor,
  importBatchId?: ImportBatchId,
): Promise<PaymentRow[]> {
  const rows = await exec
    .select({
      id: payments.id,
      amount: payments.amount,
      direction: payments.direction,
      counterpartyType: payments.counterpartyType,
      state: payments.state,
      ignoredReason: payments.ignoredReason,
      occurredAt: payments.occurredAt,
      externalReference: payments.externalReference,
      accountId: payments.accountId,
      channel: payments.channel,
      referenceType: payments.referenceType,
      rawDescription: payments.rawDescription,
    })
    .from(payments)
    .where(
      importBatchId === undefined
        ? eq(payments.state, 'imported')
        : and(eq(payments.state, 'imported'), eq(payments.importBatchId, importBatchId)),
    )
    .orderBy(asc(payments.occurredAt), asc(payments.id));
  return rows as PaymentRow[];
}

/**
 * The merchant an already-canonical alias key resolves to, if any.
 *
 * Exact equality only — never a prefix, substring, or similarity match. `raw_pattern` stores
 * the canonical key produced by `domain.merchantAliasKey`, so the caller must canonicalize
 * before calling; passing a raw description here will simply not match.
 */
export async function findMerchantByAliasKey(
  exec: Executor,
  aliasKey: string,
): Promise<MerchantId | null> {
  const [row] = await exec
    .select({ merchantId: merchantAliases.merchantId })
    .from(merchantAliases)
    .where(eq(merchantAliases.rawPattern, aliasKey));
  return row === undefined ? null : (row.merchantId as MerchantId);
}

/**
 * Writes the DERIVED results of normalization and moves the payment to `normalized`.
 *
 * Touches no SOURCE column: `amount`, `occurred_at`, `raw_description` and `account_id` are
 * write-once (`invariants.md` #4) and are deliberately absent from this update.
 */
export async function applyPaymentNormalization(
  exec: Executor,
  paymentId: PaymentId,
  next: {
    readonly channel: PaymentChannel;
    readonly counterpartyType: PaymentCounterpartyType;
    readonly counterpartyId: MerchantId | null;
  },
): Promise<void> {
  await exec
    .update(payments)
    .set({
      channel: next.channel,
      counterpartyType: next.counterpartyType,
      counterpartyId: next.counterpartyId,
      state: 'normalized',
    })
    .where(eq(payments.id, paymentId));
}
```

Add `merchantAliases` to the existing `schema` import in that file, and `MerchantId`, `PaymentChannel`, `PaymentCounterpartyType` to its domain type imports. Confirm `and` is already imported from `drizzle-orm` (it is, used by `computeUnexplained`'s period filter).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test
git add src/db/repositories.ts tests/integration/normalization.test.ts
git commit -m "Add the queries normalization reads and writes through"
```

---

### Task 5: The normalization service — channel, state, audit, idempotency

**Files:**

- Create: `src/services/normalization-service.ts`
- Modify: `src/services/index.ts` (add one export line)
- Modify: `tests/integration/normalization.test.ts` (append)
- Create: `docs/decisions/0021-normalization-acts-only-on-imported-payments.md`

**Interfaces:**

- Consumes: `refineChannel` (Task 1), the three queries (Task 4), `runAudited`/`AuditMeta` from `./audit.js`
- Produces:

```ts
export interface NormalizePaymentsInput {
  readonly importBatchId?: ImportBatchId;
  readonly audit: AuditMeta;
}

export interface NormalizePaymentsResult {
  readonly normalizedPaymentIds: readonly PaymentId[];
  readonly channelRefinedCount: number;
  readonly merchantResolvedCount: number;
}

export function normalizePayments(
  db: Database,
  input: NormalizePaymentsInput,
): Promise<NormalizePaymentsResult>;
```

**Critical constraint discovered while planning:** `runAudited` throws `AUDIT_EVENT_MISSING` and rolls back when its body records **zero** audit events. A `normalizePayments` call with nothing to do would therefore throw rather than return an empty result. The service must query eligibility **before** opening the transaction and return early when there is nothing to do — mirroring how `importBankStatementCsv` checks the content hash outside `runAudited`. Every eligible payment always produces at least one event (its state changes even when nothing else does), so the guard is exactly "no eligible payments".

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/normalization.test.ts`:

```ts
describe('normalizePayments — channel, state, and audit', () => {
  it('moves every imported payment to normalized', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    expect(result.normalizedPaymentIds).toHaveLength(8);
    const rows = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .orderBy(asc(schema.payments.occurredAt));
    expect(rows.every((row) => row.state === 'normalized')).toBe(true);
  });

  it('refines only the channels a reference proves, leaving the rest as imported', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    const rows = await database.db
      .select({ channel: schema.payments.channel, referenceType: schema.payments.referenceType })
      .from(schema.payments);
    expect(rows.filter((row) => row.channel === 'upi')).toHaveLength(4);
    expect(rows.filter((row) => row.channel === 'bank_transfer')).toHaveLength(4);
    expect(rows.every((row) => (row.referenceType === 'upi_utr') === (row.channel === 'upi'))).toBe(
      true,
    );
    expect(result.channelRefinedCount).toBe(4);
  });

  it('never touches a SOURCE column', async () => {
    await importFixture();
    const before = await database.db
      .select({
        id: schema.payments.id,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        rawDescription: schema.payments.rawDescription,
        accountId: schema.payments.accountId,
      })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));

    await normalizePayments(database.db, { audit: AS_USER });

    const after = await database.db
      .select({
        id: schema.payments.id,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        rawDescription: schema.payments.rawDescription,
        accountId: schema.payments.accountId,
      })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));

    expect(after).toEqual(before);
  });

  it('records one update event per payment, carrying old and new values', async () => {
    const imported = await importFixture();
    if (imported.outcome !== 'imported') throw new Error('expected an import');

    await normalizePayments(database.db, { audit: AS_USER });

    // listAuditEvents is per-entity: (exec, entityType, entityId). Each payment should
    // now carry exactly two events — the importer's `create`, then this `update`.
    for (const paymentId of imported.paymentIds) {
      const events = await listAuditEvents(database.db, 'payment', paymentId);
      expect(events.map((event) => event.action)).toEqual(['create', 'update']);
    }

    // The Blinkit row is one whose channel actually changed, so both sides are visible.
    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const [, update] = await listAuditEvents(database.db, 'payment', blinkit);
    expect(update?.oldValue).toMatchObject({ state: 'imported', channel: 'bank_transfer' });
    expect(update?.newValue).toMatchObject({ state: 'normalized', channel: 'upi' });

    // A row whose channel is not refined still records the state change, with channel equal
    // on both sides — the event says what happened, not only what differed.
    const utility = await paymentIdByReference('BBPS/EB220711');
    const [, utilityUpdate] = await listAuditEvents(database.db, 'payment', utility);
    expect(utilityUpdate?.oldValue).toMatchObject({ state: 'imported', channel: 'bank_transfer' });
    expect(utilityUpdate?.newValue).toMatchObject({
      state: 'normalized',
      channel: 'bank_transfer',
    });
  });

  it('is a no-op on a second run, rewriting nothing', async () => {
    await importFixture();
    await normalizePayments(database.db, { audit: AS_USER });
    const afterFirst = await database.db
      .select({ id: schema.payments.id, channel: schema.payments.channel })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));
    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const eventsAfterFirst = (await listAuditEvents(database.db, 'payment', blinkit)).length;

    const second = await normalizePayments(database.db, { audit: AS_USER });

    // No eligible payments: returns empty rather than throwing AUDIT_EVENT_MISSING,
    // and writes no second audit event.
    expect(second.normalizedPaymentIds).toEqual([]);
    expect(second.channelRefinedCount).toBe(0);
    expect(await listAuditEvents(database.db, 'payment', blinkit)).toHaveLength(eventsAfterFirst);
    expect(
      await database.db
        .select({ id: schema.payments.id, channel: schema.payments.channel })
        .from(schema.payments)
        .orderBy(asc(schema.payments.id)),
    ).toEqual(afterFirst);
  });

  it('leaves a duplicate ignored at import untouched', async () => {
    await importFixture();
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
    ].join('\n');
    const repeat = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });
    if (repeat.outcome !== 'imported') throw new Error('expected an import');
    const ignoredId = repeat.duplicates[0]!.paymentId;

    await normalizePayments(database.db, { audit: AS_USER });

    const [ignored] = await database.db
      .select({ state: schema.payments.state, ignoredReason: schema.payments.ignoredReason })
      .from(schema.payments)
      .where(eq(schema.payments.id, ignoredId));
    expect(ignored?.state).toBe('ignored');
    expect(ignored?.ignoredReason).toMatch(/^duplicate_of:/);
  });

  it('normalizes only the batch it was scoped to', async () => {
    const first = await importFixture();
    if (first.outcome !== 'imported') throw new Error('expected an import');
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,UPI-NEWMERCHANT-SAMPLE,300.00,DEBIT,UPI/2607201234/NEW',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');

    const result = await normalizePayments(database.db, {
      importBatchId: second.importBatchId,
      audit: AS_USER,
    });

    expect(result.normalizedPaymentIds).toHaveLength(1);
    expect(await listPaymentsAwaitingNormalization(database.db, first.importBatchId)).toHaveLength(
      8,
    );
  });
});
```

Add `listAuditEvents` to the existing `from '../../src/db/index.js'` import, `normalizePayments` to the existing `from '../../src/services/index.js'` import, and `asId` plus the `PaymentId` type to the existing `from '../../src/domain/index.js'` imports (`asId` is a value, `PaymentId` a type — they go on separate import lines, as `tests/integration/import.test.ts` already does).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: FAIL — `normalizePayments` is not exported from `src/services/index.js`.

- [ ] **Step 3: Write the service**

Create `src/services/normalization-service.ts`:

````ts
/**
 * Transaction normalization — the second step of the pipeline (`data-flow.md`, step 2).
 *
 * ```
 * api ─▶ services.normalizePayments ─▶ domain.refineChannel / domain.merchantAliasKey
 *                                   ─▶ db.findMerchantByAliasKey / db.applyPaymentNormalization
 * ```
 *
 * Gives an imported payment the meaning that can be established **deterministically from
 * evidence already in the row**, and nothing more. It does not decide what the payment *is*:
 * no expense/settlement/transfer/investment classification, no person resolution, no AI call.
 * Those are `data-flow.md` step 3 and have no code path from here.
 *
 * The deterministic leg only (ADR-0022). `data-flow.md` step 2 also describes an
 * `ai.normalizeMerchant()` leg producing a pending `AIInference` for anything unresolved;
 * that arrives with the rest of the AI boundary in phase 8, and until then an unresolved
 * counterparty simply stays `unknown` — a recorded outcome, not a gap.
 */

import { merchantAliasKey, refineChannel } from '../domain/index.js';
import { assertPaymentTransition } from '../domain/index.js';
import type {
  ImportBatchId,
  MerchantId,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentId,
  PaymentReferenceType,
} from '../domain/index.js';
import {
  applyPaymentNormalization,
  findMerchantByAliasKey,
  listPaymentsAwaitingNormalization,
} from '../db/index.js';
import type { Database } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';

export interface NormalizePaymentsInput {
  /** Scope to one import batch. Omitted means every payment still awaiting normalization. */
  readonly importBatchId?: ImportBatchId;
  readonly audit: AuditMeta;
}

export interface NormalizePaymentsResult {
  /** Every payment moved `imported → normalized`, in the order processed. */
  readonly normalizedPaymentIds: readonly PaymentId[];
  /** Payments whose stored `channel` actually changed — not those the rule merely ran on. */
  readonly channelRefinedCount: number;
  /** Payments whose counterparty was resolved to a merchant. */
  readonly merchantResolvedCount: number;
}

/**
 * Normalizes every eligible payment in one audited transaction.
 *
 * Eligibility is read **before** the transaction opens, and an empty result returns without
 * opening one at all. That is deliberate: `runAudited` refuses to commit a unit of work that
 * recorded no audit event, so entering it with nothing to do would throw `AUDIT_EVENT_MISSING`
 * rather than answer "there was nothing to normalize". Every eligible payment does produce an
 * event — its `state` changes even when neither channel nor counterparty does — so "no
 * eligible payments" is the only case that needs the early return.
 */
export async function normalizePayments(
  db: Database,
  input: NormalizePaymentsInput,
): Promise<NormalizePaymentsResult> {
  const awaiting = await listPaymentsAwaitingNormalization(db, input.importBatchId);
  if (awaiting.length === 0) {
    return { normalizedPaymentIds: [], channelRefinedCount: 0, merchantResolvedCount: 0 };
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const normalizedPaymentIds: PaymentId[] = [];
    let channelRefinedCount = 0;
    const merchantResolvedCount = 0;

    for (const payment of awaiting) {
      // PaymentRow types these as plain strings (the columns are `text` with CHECK
      // constraints, not enums), so the narrowing happens here, at the one place the
      // domain rule is called.
      const channel = refineChannel(
        payment.referenceType as PaymentReferenceType | null,
        payment.channel as PaymentChannel,
      );
      const counterpartyType: PaymentCounterpartyType = 'unknown';
      const counterpartyId: MerchantId | null = null;

      assertPaymentTransition('imported', 'normalized');
      await applyPaymentNormalization(exec, payment.id, {
        channel,
        counterpartyType,
        counterpartyId,
      });

      await record({
        entityType: 'payment',
        entityId: payment.id,
        action: 'update',
        oldValue: {
          state: 'imported',
          channel: payment.channel,
          counterpartyType: payment.counterpartyType,
        },
        newValue: { state: 'normalized', channel, counterpartyType },
      });

      normalizedPaymentIds.push(payment.id);
      if (channel !== payment.channel) channelRefinedCount += 1;
    }

    return { normalizedPaymentIds, channelRefinedCount, merchantResolvedCount };
  });
}
````

- [ ] **Step 4: Add the barrel export**

In `src/services/index.ts`, add after the `import-service.js` line:

```ts
export * from './normalization-service.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: PASS for every test in this task's describe block. The Task 6 merchant assertions do not exist yet.

- [ ] **Step 6: Write ADR-0021**

Create `docs/decisions/0021-normalization-acts-only-on-imported-payments.md`, following the existing ADR format. It must state: status `Accepted`; the context that normalization writes DERIVED fields a user may later act on; the decision that only `state = 'imported'` payments are eligible, so a re-run is a no-op rather than a silent rewrite, satisfying "approved financial decisions do not silently change" without a version table for derived fields; that re-deriving a normalization deliberately has no entry point in this phase; and the consequence that the service must check eligibility outside `runAudited`, because `runAudited` rolls back a transaction that records no audit event.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test
git add src/services/normalization-service.ts src/services/index.ts tests/integration/normalization.test.ts docs/decisions/0021-normalization-acts-only-on-imported-payments.md
git commit -m "Normalize payments: refine channel, move imported to normalized, audited"
```

---

### Task 6: Merchant resolution

**Files:**

- Modify: `src/services/normalization-service.ts`
- Modify: `tests/integration/normalization.test.ts` (append)

**Interfaces:**

- Consumes: `merchantAliasKey` (Task 2), `findMerchantByAliasKey` (Task 4), the service from Task 5
- Produces: no new exported names — `NormalizePaymentsResult.merchantResolvedCount` becomes non-zero

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/normalization.test.ts`:

```ts
describe('normalizePayments — merchant resolution', () => {
  it('resolves every catalogued merchant and leaves the rest unknown', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    const rows = await database.db
      .select({
        rawDescription: schema.payments.rawDescription,
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
      })
      .from(schema.payments);
    const byDescription = new Map(rows.map((row) => [row.rawDescription, row]));

    expect(byDescription.get('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_blinkit'],
    });
    expect(byDescription.get('ELECTRICITY BOARD BBPS BILLPAY')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_electricity_board'],
    });
    // A credit resolves on the same terms as a debit. Whether it is a refund is
    // classification, not normalization.
    expect(byDescription.get('ACH REFUND SAMPLE ELECTRONICS STORE')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_sample_electronics'],
    });

    expect(result.merchantResolvedCount).toBe(5);
  });

  it('leaves the obvious self-transfer unknown — recognising it is classification', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const transfers = await database.db
      .select({ counterpartyType: schema.payments.counterpartyType })
      .from(schema.payments)
      .where(eq(schema.payments.externalReference, 'NEFT/N072026001'));
    expect(transfers).toHaveLength(2);
    expect(transfers.every((row) => row.counterpartyType === 'unknown')).toBe(true);
  });

  it('leaves a person-to-person payment unknown — a person is not a merchant', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const [p2p] = await database.db
      .select({
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
        state: schema.payments.state,
      })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'UPI-FRIENDA-TRANSFER'));
    expect(p2p).toMatchObject({ counterpartyType: 'unknown', counterpartyId: null });
    // Still normalized: the bar is "resolution attempted", not "resolved".
    expect(p2p?.state).toBe('normalized');
  });

  it('writes no counterparty when the catalog is empty', async () => {
    await database.truncateAll();
    cast = await seedCast(database.db);
    accountId = cast.account['account_hdfc_savings']!;
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    expect(result.merchantResolvedCount).toBe(0);
    expect(result.normalizedPaymentIds).toHaveLength(8);
    const rows = await database.db
      .select({ counterpartyType: schema.payments.counterpartyType })
      .from(schema.payments);
    expect(rows.every((row) => row.counterpartyType === 'unknown')).toBe(true);
  });

  it('records the resolved merchant in the audit event', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const [, resolvedUpdate] = await listAuditEvents(database.db, 'payment', blinkit);
    expect(resolvedUpdate?.oldValue).toMatchObject({ counterpartyType: 'unknown' });
    expect(resolvedUpdate?.newValue).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_blinkit'],
    });

    // The self-transfer's event records that resolution was attempted and found nothing —
    // an unresolved counterparty is an outcome, not a missing event.
    const transfer = await paymentIdByReference('NEFT/N072026001');
    const [, transferUpdate] = await listAuditEvents(database.db, 'payment', transfer);
    expect(transferUpdate?.newValue).toMatchObject({
      state: 'normalized',
      counterpartyType: 'unknown',
      counterpartyId: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: FAIL — counterparties are all `unknown`; `expected 'unknown' to be 'merchant'` and `expected 0 to be 5`.

- [ ] **Step 3: Resolve the merchant in the service**

In `src/services/normalization-service.ts`, replace the two placeholder lines inside the loop:

```ts
const counterpartyType: PaymentCounterpartyType = 'unknown';
const counterpartyId: MerchantId | null = null;
```

with the lookup:

```ts
// Exact match on the canonical key — never a prefix or a similarity. A miss leaves the
// counterparty `unknown`, which is a recorded outcome rather than a failure to retry.
const merchantId = await findMerchantByAliasKey(exec, merchantAliasKey(payment.rawDescription));
// `merchant` is the only counterparty type this phase ever writes. A payment that is
// plainly a self-transfer stays `unknown`: recognising that is classification (phase 8).
const counterpartyType: PaymentCounterpartyType = merchantId === null ? 'unknown' : 'merchant';
const counterpartyId: MerchantId | null = merchantId;
```

Change the counter declaration from `const merchantResolvedCount = 0;` to `let merchantResolvedCount = 0;`, add the merchant to the recorded values, and increment the counter. The audit `newValue` becomes:

```ts
        newValue: { state: 'normalized', channel, counterpartyType, counterpartyId },
```

and after `normalizedPaymentIds.push(payment.id);` add:

```ts
if (merchantId !== null) merchantResolvedCount += 1;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/normalization.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test
git add src/services/normalization-service.ts tests/integration/normalization.test.ts
git commit -m "Resolve a payment's counterparty to a catalogued merchant by exact alias"
```

---

### Task 7: Documentation

**Files:**

- Create: `docs/decisions/0022-phase-7-deterministic-only-scope.md`
- Modify: `docs/architecture/data-flow.md` (step 2)
- Modify: `docs/roadmap.md` (phase status and next phase)
- Modify: `src/services/README.md` and `src/domain/README.md` if either enumerates its modules — check first; if they describe responsibilities only, leave them alone.

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write ADR-0022**

Create `docs/decisions/0022-phase-7-deterministic-only-scope.md`. Status `Accepted`. It must state: the context that `data-flow.md` step 2 describes normalization as two legs, deterministic and `ai.normalizeMerchant()`; the decision that phase 7 ships only the deterministic leg; the reasoning that `src/ai/` is an empty directory and building the AI leg means designing the whole AI service boundary (interface, structured-proposal contract, confidence handling, the validation gate) which `ai-boundary.md` specifies and phase 8 needs in full, so doing it here would design that boundary twice; and the consequence that an unresolved counterparty ends at `normalized`/`unknown` with **no `AIInference` row**, leaving `ai_inferences` empty until phase 8.

- [ ] **Step 2: Amend `data-flow.md` step 2**

Add a note under step 2 recording which leg exists as of phase 7 and which is deferred, cross-referencing ADR-0022. Keep the existing two-leg description — it is the target state, not a lie — and mark the AI leg as not yet built rather than deleting it.

- [ ] **Step 3: Update `docs/roadmap.md`**

Mark phase 7 done. Rewrite the "Recommended next phase" section for phase 8 (classification), and carry forward the two items phase 7 leaves behind: the `ai.normalizeMerchant()` leg (ADR-0022) and the fact that possible-duplicate surfacing is still phase 9's. State that the merchant catalog is currently seeded only by the test harness, so a production seeding path is still unbuilt.

- [ ] **Step 4: Verify and commit**

```bash
npm run format:check && npm test
git add docs/
git commit -m "Record phase 7's scope decisions and mark the phase done"
```

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task: the two rules → Tasks 1–2; the catalog fixture → Task 3; the component table → Tasks 1–6; boundary 1 (idempotency) → Task 5 step 1 test 5 + ADR-0021; boundary 2 (`ignored` terminal) → Task 4 test 2 and Task 5 test 6; boundary 3 (SOURCE untouched) → Task 5 test 3; boundary 4 (no classification) → Task 6 test 2; boundary 5 (person ≠ merchant) → Task 6 test 3; boundary 6 (direction irrelevant) → Task 6 test 1's credit assertion; the acceptance table → Tasks 5–6 together; the three ADRs → Tasks 1, 5, 7.

**2. Placeholder scan.** No "TBD", "TODO", or "handle edge cases". The three ADR steps specify required content rather than showing prose, which is deliberate — an ADR is written against the existing ADR format in the repo, and Task 1 step 6 names ADR-0019 as the model to read first.

**3. Type consistency.** `merchantAliasKey` and `refineChannel` keep their names and signatures across Tasks 1–6. `PaymentRow` gains `channel`/`referenceType`/`rawDescription` in Task 4 before Task 5 reads them. `MerchantId | null` is the return of `findMerchantByAliasKey` in Task 4 and the type consumed in Task 6. `merchantResolvedCount` is declared `const … = 0` in Task 5 and explicitly changed to `let` in Task 6 step 3 — flagged because it would otherwise be a compile error a task-scoped implementer could not predict.

**One deviation from the spec, recorded deliberately.** The spec's service-interface section says an empty run "succeeds and returns empty"; it did not say how. `runAudited` rolls back any unit of work recording zero audit events, so that behaviour requires checking eligibility outside the transaction. Task 5 states this and its test asserts it.
