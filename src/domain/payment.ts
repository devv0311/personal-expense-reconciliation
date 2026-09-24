/**
 * Payment-level rules: what a payment is allowed to fund, how much of it is explained,
 * and when two payments are the same real-world transaction seen twice.
 */

import { isNonSpendCounterparty } from './enums.js';
import type { PaymentCounterpartyType, PaymentDirection } from './enums.js';
import { DomainError } from './errors.js';
import { referencesMatch } from './evidence-observation.js';
import { sumPaise } from './money.js';
import { isTaxComponentLine, readStatementRow } from './purpose.js';
import type { RowNature } from './purpose.js';
import type { Paise } from './money.js';

/* ------------------------------------------------------- payment explanation budget */

export interface PaymentExplanationInput {
  readonly paymentAmount: Paise;
  /** `PaymentExpenseLink.amount` for every expense drawing on this payment. */
  readonly linkAmounts: readonly Paise[];
  /** `Settlement.amount` for every settlement drawing on the same payment (ADR-0007). */
  readonly settlementAmounts: readonly Paise[];
}

export interface PaymentExplanation {
  readonly explained: Paise;
  /** Never silently dropped — surfaced as unexplained (`invariants.md` #20). */
  readonly unexplained: Paise;
}

/**
 * Expense links and settlements draw on **one** budget: a payment's own amount.
 *
 * Over-drawing is an error; under-drawing is not — the remainder is explicitly tracked as
 * unexplained rather than assumed to be a rounding artefact
 * (`domain-model.md`, `PaymentExpenseLink`).
 */
export function validatePaymentExplanationBudget(
  input: PaymentExplanationInput,
): PaymentExplanation {
  const explained = sumPaise([...input.linkAmounts, ...input.settlementAmounts]);
  if (explained > input.paymentAmount) {
    throw new DomainError(
      'PAYMENT_BUDGET_EXCEEDED',
      `Expense links and settlements against this payment total ${explained} paise, more than ` +
        `the payment's own ${input.paymentAmount} paise. A payment cannot explain more money ` +
        'than it moved (domain-model.md, PaymentExpenseLink; ADR-0007).',
      { explained: explained.toString(), paymentAmount: input.paymentAmount.toString() },
    );
  }
  return { explained, unexplained: (input.paymentAmount - explained) as Paise };
}

/**
 * Invariant #7: an internal transfer or an investment purchase is never spending and must
 * never be linked to an `Expense`.
 */
export function assertPaymentCanFundExpense(counterpartyType: PaymentCounterpartyType): void {
  if (isNonSpendCounterparty(counterpartyType)) {
    throw new DomainError(
      'NON_SPEND_PAYMENT_LINKED',
      `A payment with counterparty_type "${counterpartyType}" is not spending and must never ` +
        'be linked to an Expense. It is excluded from spend totals by this classification ' +
        'alone, and may remain at state "normalized" indefinitely (invariants.md #7, ADR-0011).',
      { counterpartyType },
    );
  }
}

/* ------------------------------------------------------------- duplicate_of reasons */

/**
 * Prefix of the `payments.ignored_reason` written for a confirmed duplicate (`lifecycle.md`).
 *
 * Lives here, in `domain`, because two callers now write and read it: the importer, which
 * confirms a duplicate deterministically at import time (ADR-0019), and the review queue,
 * which confirms one a human identified (ADR-0030). One format, one place — two copies of a
 * string rule drifting apart is a defect this project has already shipped once.
 */
export const DUPLICATE_OF_REASON_PREFIX = 'duplicate_of:';

/** The `ignored_reason` naming the canonical payment a discarded copy duplicates. */
export function duplicateOfReason(canonicalPaymentId: string): string {
  return `${DUPLICATE_OF_REASON_PREFIX}${canonicalPaymentId}`;
}

/**
 * The payment id a `duplicate_of:` reason names, or `null` for any other reason.
 *
 * A payment ignored as `out_of_scope` returns `null` here and is *not* a chain link — but it
 * is still the first copy this ledger saw, which is why chain-walking stops at it rather than
 * skipping it (`invariants.md` #10).
 */
export function parseDuplicateOfReason(ignoredReason: string | null): string | null {
  if (ignoredReason === null || !ignoredReason.startsWith(DUPLICATE_OF_REASON_PREFIX)) return null;
  const id = ignoredReason.slice(DUPLICATE_OF_REASON_PREFIX.length);
  return id.length === 0 ? null : id;
}

/* --------------------------------------------------------------- duplicate detection */

/** The fields duplicate detection compares. */
export interface DuplicateCandidate {
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  /**
   * Part of the match, and load-bearing.
   *
   * The two legs of a transfer between the user's own accounts share one reference, one
   * amount and one timestamp, differing only in direction — `fixtures/bank-statement.csv`
   * rows 2 and 3 are exactly this. Without direction in the match they collapse into one
   * "duplicate" and half a real transfer is discarded.
   */
  readonly direction: PaymentDirection;
  /**
   * Present for diagnostics only. Deliberately **not** part of the match: the same
   * real-world transaction can legitimately land under two different `Account` rows when
   * two import channels capture it (ADR-0010's amendment, `scenario-analysis.md` §13).
   */
  readonly accountId?: string;
  /**
   * What kind of identifier `externalReference` is — `upi_utr`, `card_reference`, and so on.
   *
   * Used only to tell two movements **apart**: two references of one known kind that are
   * different identifiers name two transactions (ADR-0070). A reference whose kind is unknown,
   * or `other`, says nothing either way.
   */
  readonly referenceType?: string | null;
  /**
   * The line's own words: they tell a tax component from a purchase, and they carry the name
   * and the kind of line the possible-duplicate rule compares (ADR-0070).
   *
   * Optional because a caller that has no description still gets a rule: unknown words are
   * never a difference, so a missing description can only add a question. Every caller in this
   * repository supplies it.
   */
  readonly rawDescription?: string;
  /**
   * The import batch that delivered this row — one statement, one export, or one hand entry.
   *
   * Optional for the same reason as `rawDescription`: without it the rule asks about every
   * resemblance, as it always did. Supplying it, with `rawDescription`, is what lets the rule
   * tell two lines of one statement from one movement captured twice.
   */
  readonly importBatchId?: string;
}

export interface DuplicateMatchOptions {
  /** Tolerated clock skew between two captures of one transaction. Default 60 seconds. */
  readonly windowSeconds?: number;
}

const DEFAULT_DUPLICATE_WINDOW_SECONDS = 60;

/**
 * A deterministic duplicate: same **direction**, same amount, matching non-null
 * `external_reference`, and timestamps within a small window (`invariants.md` #10).
 *
 * A UTR/RRN/bank reference already identifies the real-world transaction on its own;
 * amount and timestamp proximity corroborate it. Anything short of this is not
 * deterministic — see {@link isPossibleDuplicate}.
 */
export function isDeterministicDuplicate(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DuplicateMatchOptions = {},
): boolean {
  if (a.direction !== b.direction) return false;
  if (a.externalReference === null || b.externalReference === null) return false;
  if (a.externalReference !== b.externalReference) return false;
  if (a.amount !== b.amount) return false;
  return withinWindow(a, b, options);
}

/**
 * A *possible* duplicate: one movement that may have been recorded twice, which only a person
 * can settle (`invariants.md` #10, ADR-0070).
 *
 * Two payments are one transaction for duplicate purposes when they move the **same amount**
 * the **same way** on the **same calendar day** and **name the same or a sufficiently similar
 * payee** — or, where a line names nobody, are the **same kind of line** — whichever accounts
 * they came from (the owner's policy, ADR-0070). A reference decides it outright where there is
 * one: the same identifier in two packagings is one movement whatever the names say, and two
 * different identifiers of one kind are two. A tax line is only ever the same tax again, from
 * another import.
 *
 * Surfaced for human confirmation — never silently merged, and never silently kept as two.
 * No similarity score and no spelling distance: every step is a yes/no a person can check
 * against the two lines.
 */
export function isPossibleDuplicate(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  // Money leaving is never a duplicate of money arriving, however alike they otherwise look.
  if (a.direction !== b.direction) return false;
  if (a.amount !== b.amount) return false;
  // One movement is dated once. A statement prints a date, not a time, so two captures of one
  // transaction share a calendar day; the next printed date is the next day's movement, however
  // close in hours. The 24-hour window this replaces paired every line with the day after it —
  // on an ordinary month of a bank account and a card, most of the questions it raised.
  if (!isSameCalendarDay(a.occurredAt, b.occurredAt)) return false;
  // A pair a shared reference proves (`isDeterministicDuplicate`) is still asked about. The
  // importer settles one the moment the second copy arrives (ADR-0019), so a pair it wrote
  // never reaches this rule with both still counted. A pair that does was written by a path that
  // settles nothing — a payment typed by hand with the number of one already imported — and
  // assuming "the importer acted on it" left that one counted twice with nobody asked.
  //
  // A tax component is compared only with a tax component.
  //
  // On an Indian card statement one charge is routinely printed as several lines — the charge,
  // then `CGST`, then `SGST` — and the two halves of the tax are equal by construction, on the
  // same date, to the paisa. This rule's whole basis is "same amount, same day, no reference",
  // which those two satisfy perfectly while being a textbook *non*-duplicate. On the ledger
  // this was written against they produced 37 of the 69 questions waiting, every one of them
  // wrong, and answering any of them would have discarded half of a real tax charge. So a tax
  // line is never paired with a line that is not one, nor with another line of its own
  // statement (below), and across imports its *name* is the tax it is: `CGST` beside `CGST`,
  // never beside `SGST`.
  //
  // Across imports it is still compared (ADR-0070). A card statement downloaded again is new
  // bytes, so the file is not recognised, and its lines carry no reference, so no row is: every
  // line arrives a second time. Excluding tax lines there left the purchases asked about and the
  // tax counted twice with nobody asked.
  //
  // Deliberately scoped to the *possible* rule. `isDeterministicDuplicate` matches on a shared
  // bank reference, which is proof of one real-world line arriving twice; suppressing that for
  // tax rows would let a genuinely re-imported statement double-count its own tax.
  const taxComponent = isTaxComponent(a);
  if (taxComponent !== isTaxComponent(b)) return false;
  // Two different lines of one statement are two movements.
  //
  // This invariant guards against the ledger receiving one movement *twice* — an overlapping
  // statement, a second channel, a re-downloaded copy — and each of those arrives as an import
  // batch of its own. Within one batch the document is the only witness, and a document that
  // prints two lines differing in date, words or reference is stating two movements. Asking
  // about them anyway turned every ordinary same-amount day into questions: on a synthetic
  // 295-row bank statement with no duplicates at all, all 100 it raised paired two lines of that
  // one statement, and 59 of them paired consecutive days, which a 24-hour window admits for a
  // statement that prints dates.
  //
  // What is still asked: a line one batch prints twice, word for word, with no reference to
  // settle it — the within-file restatement ADR-0019 already treats as real. Not a tax line: a
  // statement prints one for every charge it taxes, so two equal ones are two charges' taxes.
  if (isOneBatch(a, b)) return !taxComponent && isSamePrintedLine(a, b);
  // Across batches — a second statement, a second channel, a hand entry — the two lines were
  // printed by different documents, so they are compared for what they say (ADR-0070).
  //
  // A transaction number is the strongest witness there is. The same one in two packagings
  // (`UPI-000000000105` on a statement, `000000000105` in an app) is one movement, and a bank
  // printing a payee's legal name where the app prints the brand must not hide that.
  if (referencesMatch(a.externalReference, b.externalReference)) return true;
  // Two different numbers of one kind name two transactions: a UTR identifies exactly one UPI
  // payment. Two juices on one day, each with its own number, are two juices.
  if (referencesTellApart(a, b)) return false;
  return describeOneMovement(a, b);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The same date, as this ledger dates things: the UTC date of `occurred_at`, which for a
 * statement line is the date the statement printed (every statement format stores its printed
 * date at UTC midnight). The same convention as `statement-balance.ts` and the importer.
 */
function isSameCalendarDay(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / MS_PER_DAY) === Math.floor(b.getTime() / MS_PER_DAY);
}

/**
 * Both lines carry a reference of the same known kind, and they are not the same identifier.
 *
 * Only ever a reason to ask *less*. A reference of unknown kind, or `other`, may belong to a
 * scheme the other line's issuer does not use, so it says nothing either way; so does a missing
 * one. `referencesMatch` has already been asked, so reaching here means the two differ.
 */
function referencesTellApart(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.externalReference === null || b.externalReference === null) return false;
  const kind = a.referenceType ?? null;
  if (kind === null || kind === 'other') return false;
  return kind === (b.referenceType ?? null);
}

/**
 * Words that say how money moved, or introduce a name, and never whom it went to.
 *
 * Added to the purpose reader's own list of words that are never a merchant
 * (`purpose.ts`, which already removes `UPI`, `POS`, `card`, `payment`, `Pvt`, `Ltd`…) — these
 * are the ones a *second* channel wraps around the same name: a card's UPI rail, a bank's
 * transfer rails, an app's "Paid to". Nothing on this list is a shop.
 */
const NOT_A_NAME = new Set([
  'upicc',
  'imps',
  'neft',
  'rtgs',
  'ach',
  'nach',
  'ecs',
  'bbps',
  'mmt',
  'paid',
  'from',
  'sent',
  'transfer',
  'via',
  'debit',
  'credit',
]);

interface LineName {
  /** What kind of line it is — a purchase, an instalment's interest, a fee, a refund, money in. */
  readonly nature: RowNature;
  /**
   * The words that name its payee, lower-cased, each once; empty when it names nobody. For a
   * tax component, the tax it is (`cgst`) — the one word that tells one tax line from another.
   */
  readonly words: readonly string[];
  /**
   * The payee a narration of `/`-separated parts names — `UPI / payee / number / note` — or
   * `null` when the line is not such a narration or names nobody in it.
   */
  readonly payee: readonly string[] | null;
}

/**
 * The name a line gives its payee, read the way the purpose reader reads a merchant.
 *
 * `purpose.ts` removes markers, reference numbers and card scaffolding, and stops at a
 * ` - INTEREST 3/6`-style marker; this removes the channel words above, words of one or two
 * letters (`IN`, `P2A`'s fragments) and masked digits (`XXXX`).
 */
function nameOf(rawDescription: string, direction: PaymentDirection): LineName {
  const reading = readStatementRow({ rawDescription, direction });
  if (reading.nature === 'tax_on_another_line') {
    return { nature: reading.nature, words: taxWordsOf(rawDescription), payee: null };
  }
  return {
    nature: reading.nature,
    words: nameWordsOf(reading.merchantText),
    payee: payeeOf(rawDescription, direction),
  };
}

function nameWordsOf(merchantText: string | null): string[] {
  const words = (merchantText ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 3 && !/^x+$/.test(word) && !NOT_A_NAME.has(word));
  return [...new Set(words)];
}

/** `CGST`, `C GST`, `SGST`, `IGST`, `UGST`, a lone `GST`, `VAT`, `TAX` — as one word each. */
const TAX_WORD = /\b(?:[csiu]\s*gst|gst|vat|tax)\b/gi;

function taxWordsOf(rawDescription: string): string[] {
  const words = (rawDescription.match(TAX_WORD) ?? []).map((word) =>
    word.toLowerCase().replace(/\s+/g, ''),
  );
  return [...new Set(words)];
}

/**
 * The payee a narration of `/`-separated parts names: the first part that names anyone.
 *
 * A bank prints a UPI or transfer line as parts — `UPI/SYNTH CAFE/000000000113/Payment from
 * Phone`, `NEFT/ABCD0001234/SYNTH LANDLORD/RENT` — and a card prints its UPI rail the same way
 * (`UPICC/300000000201/SYNTH PHARMACY`). The payee is one part; the others are the rail, the
 * number, the branch, the handle and the payer's own note. Reading the whole line as one name
 * lets the note stand between two captures of one payment: the bank's `… Payment from Phone`
 * and the card's `SYNTH CAFE BANGALORE` each have a word the other lacks.
 *
 * A token carrying a digit or an `@` — a reference number, a branch code, a UPI handle — never
 * names anyone, and neither does a rail word (`UPI`, `DR`, `NEFT`), so the first part left with
 * a name word is the payee.
 */
function payeeOf(rawDescription: string, direction: PaymentDirection): readonly string[] | null {
  const parts = rawDescription.split('/');
  if (parts.length < 2) return null;
  for (const part of parts) {
    const text = part
      .split(/\s+/)
      .filter((token) => !/[\d@]/.test(token))
      .join(' ')
      .trim();
    if (text === '') continue;
    const words = nameWordsOf(readStatementRow({ rawDescription: text, direction }).merchantText);
    if (words.length > 0) return words;
  }
  return null;
}

/**
 * The two lines describe one movement: the same kind of line, naming the same payee.
 *
 * **The same kind**: the purpose reader's reading of each line — a purchase, an instalment's
 * principal or interest, a fee, a bill payment, a refund, money in — must agree, so a plan's
 * principal is never taken for its interest however alike the rest reads. A line the reader
 * cannot place is unknown, never different.
 *
 * **The same payee** — the same or a sufficiently similar name, in the owner's words — is any
 * of four checks a person can make against the two lines:
 *
 * - every name word of one line appears in the other (`SYNTH SHOE STORE` in
 *   `SYNTH SHOE STORE BANGALORE`);
 * - the two are the same letters once spaces are ignored (`BIG BASKET`, `BIGBASKET`);
 * - the payee a narration names appears in the other line (`UPI/SYNTH CAFE/…/Payment from
 *   Phone` beside `SYNTH CAFE BANGALORE`), see {@link payeeOf};
 * - and in each of those, a word the issuer cut short counts as the word it begins
 *   (`SUPERMARKE`, `SUPERMARKET`) when at least four letters of it survive.
 *
 * Sharing a word is not enough — `SYNTH TEA STALL` is not `SYNTH AUTO RIDE`, and
 * `SRI SAI TRADERS` is not `SRI BALAJI TRADERS` — and a one-letter difference is a different
 * name. A line that names nobody is judged by its kind alone, and unknown words are never a
 * difference: missing information can only add a question.
 */
function describeOneMovement(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.rawDescription === undefined || b.rawDescription === undefined) return true;
  const left = nameOf(a.rawDescription, a.direction);
  const right = nameOf(b.rawDescription, b.direction);
  if (
    left.nature !== right.nature &&
    left.nature !== 'unreadable' &&
    right.nature !== 'unreadable'
  ) {
    return false;
  }
  if (left.words.length === 0 || right.words.length === 0) return true;
  return (
    everyWordIn(left.words, right.words) ||
    everyWordIn(right.words, left.words) ||
    left.words.join('') === right.words.join('') ||
    (left.payee !== null && everyWordIn(left.payee, right.words)) ||
    (right.payee !== null && everyWordIn(right.payee, left.words))
  );
}

function everyWordIn(words: readonly string[], other: readonly string[]): boolean {
  return words.every((word) => other.some((candidate) => sameWord(word, candidate)));
}

/**
 * How many letters of a word must survive for it to count as cut short. Three would make
 * `TEA` the start of `TEAK` and `SAI` the start of `SAIRAM`.
 */
const LETTERS_A_CUT_WORD_KEEPS = 4;

/**
 * One word, or the same word cut short. Issuers truncate a descriptor to a fixed width
 * (`purpose.ts` already strips the half-written legal suffixes this leaves), so the card's
 * `SUPERMARKE` is the bank's `SUPERMARKET`.
 */
function sameWord(one: string, other: string): boolean {
  if (one === other) return true;
  const [shorter, longer] = one.length <= other.length ? [one, other] : [other, one];
  return shorter.length >= LETTERS_A_CUT_WORD_KEEPS && longer.startsWith(shorter);
}

function isTaxComponent(candidate: DuplicateCandidate): boolean {
  return candidate.rawDescription !== undefined && isTaxComponentLine(candidate.rawDescription);
}

/** Both rows say where they came from and what they printed, and came from the same batch. */
function isOneBatch(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  return (
    a.importBatchId !== undefined &&
    a.importBatchId === b.importBatchId &&
    a.rawDescription !== undefined &&
    b.rawDescription !== undefined
  );
}

/** Nothing the statement printed tells the two lines apart. Amount and direction already match. */
function isSamePrintedLine(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  return (
    a.occurredAt.getTime() === b.occurredAt.getTime() &&
    a.rawDescription === b.rawDescription &&
    a.externalReference === b.externalReference
  );
}

function withinWindow(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DuplicateMatchOptions,
): boolean {
  const windowSeconds = options.windowSeconds ?? DEFAULT_DUPLICATE_WINDOW_SECONDS;
  const deltaMs = Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime());
  return deltaMs <= windowSeconds * 1000;
}
