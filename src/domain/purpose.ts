/**
 * What a statement line is likely *for*, read from the line itself.
 *
 * ```
 * domain.readStatementRow  ─▶ what kind of row this is at all
 * domain.inferPurpose      ─▶ that, plus ranked category candidates and the plain reason
 * ```
 *
 * **Pure, local and deterministic.** No network, no merchant directory, no model. The only
 * inputs are the row's own words, its direction, and the other rows already in this ledger.
 * Two calls with the same inputs give the same answer, which is what lets a surface re-derive
 * the alternatives beside a stored proposal instead of storing a second copy of them.
 *
 * **It never decides anything.** Everything here is a suggestion carrying a confidence and a
 * sentence explaining itself; it becomes true when a person confirms it through
 * `services.decideInference`, exactly as a model's proposal does (`ai-boundary.md`).
 *
 * ## The rule that matters most
 *
 * A credit-card statement is mostly *not* purchases. On the ledger this was written against,
 * 40 of 120 rows are a bare `CGST` or `SGST` with no merchant text at all, 13 carry `INTEREST`,
 * 15 carry `EMI` or an instalment marker, and 3 are the card bill being paid. A reader that
 * matched merchant words first would report interest on a gym instalment as gym spending, and
 * would turn a tax line into a purchase of nothing.
 *
 * So the **nature of the row is decided before any category is considered**, and only
 * {@link RowNature} `merchant_purchase` is offered a merchant-derived category. Every other
 * nature is explained in words instead: what the line actually is, and what it belongs to.
 * That ordering is the safety property, and `purpose.test.ts` asserts it directly.
 */

import type { ConfidenceLevel } from './enums.js';

/* ------------------------------------------------------------------------ categories */

/**
 * The categories a person may choose from.
 *
 * Deliberately a short, flat list of things somebody recognises about their own spending —
 * not an accounting chart. `Transfer` is here because moving money is a real answer to "what
 * was this for", and `Other` because an honest "none of these" must always be reachable.
 */
export const SPENDING_CATEGORIES = [
  'Gym & fitness',
  'Groceries',
  'Dining',
  'Transport',
  'Shopping',
  'Health',
  'Education',
  'Home',
  'Bills & subscriptions',
  'Transfer',
  'Other',
] as const;

export type SpendingCategory = (typeof SPENDING_CATEGORIES)[number];

export function isSpendingCategory(value: string): value is SpendingCategory {
  return (SPENDING_CATEGORIES as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------------------- nature */

/**
 * What a statement line *is*, before anything asks what it was for.
 *
 * `instalment_principal` and `instalment_interest` are separate members on purpose: they are
 * two halves of one arrangement and only one of them is even arguably a purchase. Collapsing
 * them would make the interest invisible, which is the specific way a statement reader
 * overstates what somebody spent.
 */
export type RowNature =
  | 'merchant_purchase'
  | 'instalment_principal'
  | 'instalment_interest'
  | 'card_fee'
  | 'tax_on_another_line'
  | 'card_bill_paid'
  | 'refund_or_reversal'
  | 'money_in'
  | 'unreadable';

export interface StatementRow {
  readonly rawDescription: string;
  readonly direction: 'debit' | 'credit';
}

/** Where in a plan an instalment row sits, when the line says so. */
export interface InstalmentPosition {
  readonly number: number;
  readonly of: number;
}

export interface RowReading {
  readonly nature: RowNature;
  /** The merchant words this row carries, cleaned of markers. `null` when it names none. */
  readonly merchantText: string | null;
  /** A stable key for "the same merchant", for recurrence and for grouping a plan. */
  readonly merchantKey: string | null;
  readonly instalment: InstalmentPosition | null;
}

/* ------------------------------------------------------------------------- the markers */

/**
 * Tax on a card statement is charged on another line of the same statement — a fee, or the
 * interest on an instalment. A bare `CGST`/`SGST` row is not a purchase of anything, and it is
 * the single most common row shape on a real Indian card statement.
 */
const TAX_ONLY = /^[\s\-:.]*(?:c\s*gst|s\s*gst|i\s*gst|ugst|gst|tax|vat)\b[\s\-:.@%0-9]*$/i;
const TAX_ANYWHERE = /\b(?:cgst|sgst|igst|ugst|gst|service tax)\b/i;

/** `… - INTEREST 3/6`, `EMI INTEREST`, `FINANCE CHARGE`. The cost of credit, never a purchase. */
const INTEREST = /\b(?:interest|finance charge|int\.?\s*chg)\b/i;

/** `… - PRINCIPAL 3/6`. One repayment of a purchase already made. */
const PRINCIPAL = /\b(?:principal|princ\.?)\b/i;

/** `EMI 1234 FEE`, `ANNUAL FEE`, `LATE PAYMENT`, `SURCHARGE`, `PROCESSING FEE`. */
const FEE =
  /\b(?:fee|fees|charges?|annual|joining|renewal|late payment|surcharge|processing|markup|conversion)\b/i;

/** `CARD PAYMENT RECEIVED`, `PAYMENT THANK YOU`, `AUTOPAY`. The bill being settled. */
const BILL_PAID =
  /\b(?:payment received|payment\s*-\s*thank|thank you|autopay|auto\s*debit|neft cr|imps cr)\b/i;

const REFUND = /\b(?:refund|reversal|reversed|cashback|charge\s*back|chargeback)\b/i;

/** An instalment marker, with or without a position: `3/6`, `<3/6>`, `EMI`, `INSTALMENT`. */
const INSTALMENT_WORD = /\b(?:emi|instal?ments?|instl)\b/i;
const INSTALMENT_POSITION = /[<([]?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*[>)\]]?/;

/**
 * Words that are never the merchant: card scaffolding, city suffixes the issuer appends, and
 * the markers above. Stripped before a merchant key is built so `Q SYN FITNESS` and
 * `Q SYN FITNESS - INTEREST 3/6` are recognisably the same shop.
 */
const NOT_MERCHANT_WORDS = new Set([
  'emi',
  'instalment',
  'installment',
  'instl',
  'interest',
  'principal',
  'princ',
  'fee',
  'fees',
  'charge',
  'charges',
  'gst',
  'cgst',
  'sgst',
  'igst',
  'ugst',
  'tax',
  'card',
  'payment',
  'received',
  'thank',
  'you',
  'ref',
  'refno',
  'txn',
  'transaction',
  'upi',
  'pos',
  'purchase',
  'autopay',
  'the',
  'and',
  'pvt',
  'ltd',
  'limited',
  'llp',
  'inc',
  'india',
  'indi',
  // Issuers truncate a descriptor to a fixed width, so the legal suffix arrives half-written.
  // Left in, it becomes part of the name a screen quotes back: “SYN FITNESS LIMI”.
  'limi',
  'lim',
  'limite',
  'priv',
  'pvtl',
]);

/**
 * Whether a line is a bare tax component — `CGST`, `SGST`, `IGST`, a lone `GST`.
 *
 * Exported as its own named predicate because two very different rules need it and neither
 * should re-implement the pattern: the purpose reader refuses to categorise one, and the
 * duplicate check refuses to pair one. It is the *whole line being tax* that matters, which is
 * why a purchase that merely states its GST is not one of these.
 */
export function isTaxComponentLine(rawDescription: string): boolean {
  const text = rawDescription.trim();
  if (text.length === 0) return false;
  return TAX_ONLY.test(text) || (TAX_ANYWHERE.test(text) && extractMerchantText(text) === null);
}

/* -------------------------------------------------------------------- reading the row */

/**
 * What this line is, decided from its own words before any category is considered.
 *
 * Order is the whole design. Tax is tested first because a tax line often carries nothing
 * else; interest before principal because a plan's interest line may name both; the bill
 * payment before anything else on the credit side, because it is the one credit that is
 * certainly not income.
 */
export function readStatementRow(row: StatementRow): RowReading {
  const text = row.rawDescription.trim();
  const instalment = readInstalmentPosition(text);
  const merchantText = extractMerchantText(text);
  const merchantKey = merchantText === null ? null : merchantKeyOf(merchantText);
  const base = { merchantText, merchantKey, instalment };

  if (text.length === 0) return { ...base, nature: 'unreadable' };

  // A line that is *only* a tax marker names nothing bought. One that merely mentions GST
  // beside a merchant is that merchant's purchase with the tax stated on it.
  if (TAX_ONLY.test(text) || (TAX_ANYWHERE.test(text) && merchantText === null)) {
    return { ...base, nature: 'tax_on_another_line' };
  }

  if (row.direction === 'credit') {
    if (BILL_PAID.test(text)) return { ...base, nature: 'card_bill_paid' };
    if (REFUND.test(text)) return { ...base, nature: 'refund_or_reversal' };
    return { ...base, nature: 'money_in' };
  }

  if (INTEREST.test(text)) return { ...base, nature: 'instalment_interest' };
  if (FEE.test(text) && !PRINCIPAL.test(text)) return { ...base, nature: 'card_fee' };
  if (PRINCIPAL.test(text) || (INSTALMENT_WORD.test(text) && instalment !== null)) {
    return { ...base, nature: 'instalment_principal' };
  }
  if (merchantText === null) return { ...base, nature: 'unreadable' };
  return { ...base, nature: 'merchant_purchase' };
}

function readInstalmentPosition(text: string): InstalmentPosition | null {
  // Only where an instalment is actually being discussed: `3/6` inside a date or a reference
  // number is not a position, and a card statement is full of both.
  if (!INSTALMENT_WORD.test(text) && !PRINCIPAL.test(text) && !INTEREST.test(text)) return null;
  const match = INSTALMENT_POSITION.exec(text);
  if (match === null) return null;
  const number = Number(match[1]);
  const of = Number(match[2]);
  if (!Number.isFinite(number) || !Number.isFinite(of) || of === 0 || number > of) return null;
  return { number, of };
}

/** The merchant words, with markers, reference numbers and card scaffolding removed. */
function extractMerchantText(text: string): string | null {
  const beforeMarker = text.split(/\s[-–]\s(?=[A-Za-z])/)[0] ?? text;
  // A single letter is kept, not dropped: “Q SYN FITNESS” begins with one, and a reader who
  // sees the name they know quoted back trusts the reason attached to it.
  const words = beforeMarker
    .split(/[^A-Za-z&]+/)
    .filter((word) => word.length > 0 && !NOT_MERCHANT_WORDS.has(word.toLowerCase()));
  if (words.length === 0) return null;
  return words.join(' ');
}

/** Case- and spacing-insensitive identity for "the same shop". */
function merchantKeyOf(merchantText: string): string {
  return merchantText.toLowerCase().replace(/[^a-z]+/g, '');
}

/* --------------------------------------------------------------------------- lexicon */

/**
 * Words that suggest a category, and the words a person would use to explain why.
 *
 * Small and local by design. This is not a merchant directory and must never become one: it
 * recognises what a *word* suggests, states that as the reason, and leaves the decision to
 * the reader. A miss costs a person one tap on **Something else**; a confident wrong answer
 * costs them a wrong total, so every entry is a word whose meaning is unambiguous on its own.
 */
interface LexiconEntry {
  readonly category: SpendingCategory;
  readonly words: readonly string[];
  /** Completed as "…, which usually means <this>." */
  readonly meaning: string;
}

const LEXICON: readonly LexiconEntry[] = [
  {
    category: 'Gym & fitness',
    // No 'run': it is a word about motion long before it is a word about gyms, and a generic
    // word that corroborates a real one is how a single hint gets reported as a certainty.
    words: [
      'fitness',
      'gym',
      'yoga',
      'pilates',
      'crossfit',
      'cult',
      'sports',
      'workout',
      'wellness',
    ],
    meaning: 'a gym, a studio or something else fitness-related',
  },
  {
    category: 'Groceries',
    words: [
      'mart',
      'supermarket',
      'grocer',
      'grocery',
      'bazaar',
      'bazar',
      'kirana',
      'provision',
      'fresh',
      'farm',
      'dairy',
      'blinkit',
      'zepto',
      'instamart',
      'bigbasket',
      'dmart',
    ],
    meaning: 'food and household shopping',
  },
  {
    category: 'Dining',
    words: [
      'restaurant',
      'cafe',
      'coffee',
      'kitchen',
      'bakery',
      'pizza',
      'burger',
      'biryani',
      'dhaba',
      'bar',
      'brew',
      'chai',
      'eatery',
      'food',
      'swiggy',
      'zomato',
      'dine',
    ],
    meaning: 'eating or drinking out',
  },
  {
    category: 'Transport',
    words: [
      'uber',
      'ola',
      'rapido',
      'cab',
      'taxi',
      'metro',
      'railway',
      'irctc',
      'petrol',
      'fuel',
      'diesel',
      'parking',
      'toll',
      'fastag',
      'airlines',
      'indigo',
      'flight',
      'travel',
    ],
    meaning: 'getting somewhere',
  },
  {
    category: 'Shopping',
    words: [
      'amazon',
      'flipkart',
      'myntra',
      'ajio',
      'meesho',
      'nykaa',
      'store',
      'retail',
      'fashion',
      'apparel',
      'electronics',
      'decathlon',
      'lifestyle',
      'shoppers',
    ],
    meaning: 'buying things',
  },
  {
    category: 'Health',
    words: [
      'pharmacy',
      'pharma',
      'chemist',
      'medical',
      'medicos',
      'hospital',
      'clinic',
      'diagnostic',
      'lab',
      'apollo',
      'dental',
      'doctor',
      'health',
    ],
    meaning: 'health or medicine',
  },
  {
    category: 'Education',
    words: [
      'school',
      'college',
      'university',
      'institute',
      'academy',
      'tuition',
      'course',
      'learning',
      'udemy',
      'coursera',
      'classes',
      'education',
    ],
    meaning: 'learning or a course',
  },
  {
    category: 'Home',
    words: [
      'furniture',
      'ikea',
      'hardware',
      'interior',
      'plumb',
      'electric',
      'repair',
      'cleaning',
      'homecentre',
      'urbanclap',
      'urban',
      'rent',
    ],
    meaning: 'the home itself',
  },
  {
    category: 'Bills & subscriptions',
    words: [
      'recharge',
      'broadband',
      'airtel',
      'jio',
      'vodafone',
      'electricity',
      'bescom',
      'gas',
      'water',
      'insurance',
      'premium',
      'netflix',
      'spotify',
      'prime',
      'subscription',
      'icloud',
      'google',
      'apple',
      'adobe',
      'membership',
    ],
    meaning: 'a bill or a subscription',
  },
];

/* --------------------------------------------------------------------------- inference */

export interface PurposeCandidate {
  readonly category: SpendingCategory;
  readonly confidence: ConfidenceLevel;
  /** One plain sentence. Never a token list, never a score. */
  readonly why: string;
}

/** Another payment already in this ledger, as recurrence and grouping need to see it. */
export interface RelatedPayment {
  readonly paymentId: string;
  readonly rawDescription: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  /** A category a person has already confirmed for this payment, when one exists. */
  readonly confirmedCategory?: string | null;
}

export interface PurposeInput {
  readonly row: StatementRow;
  /** Every other payment on file. Used for recurrence, for a plan's siblings, and for nothing else. */
  readonly related?: readonly RelatedPayment[];
}

export interface PurposeReading extends RowReading {
  /** Best first. Deliberately empty where this must not guess. */
  readonly candidates: readonly PurposeCandidate[];
  /** Plain sentences explaining the row. Always at least one. */
  readonly why: readonly string[];
  /** How many other payments name the same merchant. */
  readonly seenBefore: number;
  /** The other rows of the same instalment plan, when this row is part of one. */
  readonly partOfPlan: readonly string[];
  /**
   * True when this row should never be counted as a purchase of its own.
   *
   * The field surfaces the safety rule rather than leaving a caller to re-derive it from
   * `nature`, which is how two callers end up disagreeing about the same row.
   */
  readonly countsAsPurchase: boolean;
}

/**
 * What this payment is likely for, with the reason, and what else it might be.
 *
 * The nature decides first and the lexicon never overrides it: a row carrying `INTEREST` is
 * interest even when the merchant's own name is sitting next to it on the same line.
 */
export function inferPurpose(input: PurposeInput): PurposeReading {
  const reading = readStatementRow(input.row);
  const related = input.related ?? [];
  const siblings = reading.merchantKey === null ? [] : sameMerchant(related, reading.merchantKey);
  const seenBefore = siblings.length;
  const plan = reading.merchantKey === null ? [] : planSiblings(siblings);

  const base = { ...reading, seenBefore, partOfPlan: plan };
  const named = reading.merchantText;

  switch (reading.nature) {
    case 'tax_on_another_line':
      return {
        ...base,
        countsAsPurchase: false,
        why: [
          'This is tax charged on another line of the same statement — a fee, or the interest on an instalment.',
          'It is not something you bought, so it is not counted as spending on its own.',
        ],
        candidates: [],
      };

    case 'instalment_interest':
      return {
        ...base,
        countsAsPurchase: false,
        why: [
          instalmentSentence('the interest', reading.instalment, named),
          'Interest is what the card charged you for paying over time. The purchase itself is a separate line.',
        ],
        candidates: [
          {
            category: 'Bills & subscriptions',
            confidence: 'medium',
            why: 'Interest on a card is a cost of borrowing rather than a purchase.',
          },
          { category: 'Other', confidence: 'low', why: 'If you would rather keep it separate.' },
        ],
      };

    case 'instalment_principal':
      return {
        ...base,
        countsAsPurchase: false,
        why: [
          instalmentSentence('one repayment', reading.instalment, named),
          'The purchase already happened. This line is paying it off, so counting it again would count the same money twice.',
        ],
        // The merchant's likely category is offered rather than led with: a person may
        // legitimately want the instalments filed under what they bought, and that is their
        // call to make, not this function's.
        candidates: named === null ? [] : demote(lexiconCandidates(named, 0)),
      };

    case 'card_fee':
      return {
        ...base,
        countsAsPurchase: false,
        why: ['This is a charge from the card itself — a fee rather than something you bought.'],
        candidates: [
          {
            category: 'Bills & subscriptions',
            confidence: 'medium',
            why: 'A card fee is a cost of the account rather than a purchase.',
          },
          { category: 'Other', confidence: 'low', why: 'If you would rather keep it separate.' },
        ],
      };

    case 'card_bill_paid':
      return {
        ...base,
        countsAsPurchase: false,
        why: [
          'This is money you paid to this card. It settles what you already owed on it.',
          'Paying a card bill is not spending — the spending was the purchases it is paying for.',
        ],
        candidates: [
          {
            category: 'Transfer',
            confidence: 'high',
            why: 'Money moving between your own accounts, not money spent.',
          },
        ],
      };

    case 'refund_or_reversal':
      return {
        ...base,
        countsAsPurchase: false,
        why: [
          'This is money coming back — a refund or a reversal.',
          'It belongs against the original purchase rather than being recorded as something new.',
        ],
        candidates: [],
      };

    case 'money_in':
      return {
        ...base,
        countsAsPurchase: false,
        why: ['Money arrived rather than left. Nothing on record says where it came from.'],
        candidates: [],
      };

    case 'unreadable':
      return {
        ...base,
        countsAsPurchase: false,
        why: ['This line does not name anything recognisable, so there is nothing to go on yet.'],
        candidates: [],
      };

    case 'merchant_purchase': {
      const why = [`The description says ${quote(named ?? input.row.rawDescription)}.`];
      if (seenBefore > 0) why.push(recurrenceSentence(seenBefore, siblings));
      const confirmed = confirmedCategoryAmong(siblings);
      if (confirmed !== null) {
        why.push(`You filed an earlier payment to the same place under ${quote(confirmed)}.`);
      }
      const candidates = purchaseCandidates(named, seenBefore, confirmed);
      if (candidates.length === 0) {
        why.push('Nothing in the wording says what kind of purchase it was.');
      }
      return { ...base, countsAsPurchase: true, why, candidates };
    }
  }
}

/* -------------------------------------------------------------------------- internals */

function quote(text: string): string {
  return `“${text}”`;
}

function instalmentSentence(
  part: string,
  position: InstalmentPosition | null,
  merchant: string | null,
): string {
  const where =
    position === null ? 'an instalment plan' : `instalment ${position.number} of ${position.of}`;
  const shop = merchant === null ? '' : ` on a purchase from ${quote(merchant)}`;
  return `This is ${part} of ${where}${shop}.`;
}

function recurrenceSentence(count: number, siblings: readonly RelatedPayment[]): string {
  const monthly = looksMonthly(siblings);
  if (count === 1) return 'One other payment on file names the same place.';
  if (monthly) return `You have paid the same place ${count} other times, at about a month apart.`;
  return `${count} other payments on file name the same place.`;
}

/** Ranked candidates for a genuine purchase. */
function purchaseCandidates(
  merchantText: string | null,
  seenBefore: number,
  confirmed: string | null,
): readonly PurposeCandidate[] {
  if (merchantText === null) return [];
  const fromWords = lexiconCandidates(merchantText, seenBefore);

  // A category a person already chose for this same merchant outranks anything a word
  // suggests: it is a decision they made, not a guess this function is making.
  if (confirmed !== null && isSpendingCategory(confirmed)) {
    const rest = fromWords.filter((candidate) => candidate.category !== confirmed);
    return [
      {
        category: confirmed,
        confidence: 'high',
        why: `You have filed this place under ${quote(confirmed)} before.`,
      },
      ...rest,
    ];
  }
  return fromWords;
}

/**
 * The lexicon's opinion about a merchant's words, best first.
 *
 * Confidence rises with corroboration and never reaches `high` on one word alone: a single
 * word is a hint, and a hint stated confidently is how a reader is talked into a wrong total.
 */
function lexiconCandidates(merchantText: string, seenBefore: number): readonly PurposeCandidate[] {
  const words = merchantText
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1);
  const hits: { entry: LexiconEntry; matched: string[] }[] = [];

  for (const entry of LEXICON) {
    const matched = entry.words.filter((word) =>
      words.some(
        (candidate) => candidate === word || (word.length >= 5 && candidate.includes(word)),
      ),
    );
    if (matched.length > 0) hits.push({ entry, matched });
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => b.matched.length - a.matched.length);
  const ambiguous = hits.length > 1 && hits[0]!.matched.length === hits[1]!.matched.length;

  return hits.slice(0, 3).map(({ entry, matched }, index) => ({
    category: entry.category,
    confidence: confidenceFor({ index, matched: matched.length, seenBefore, ambiguous }),
    why:
      index === 0
        ? `${quote(matched[0]!)} in the description usually means ${entry.meaning}.`
        : `It could also be ${entry.meaning}.`,
  }));
}

function confidenceFor(input: {
  index: number;
  matched: number;
  seenBefore: number;
  ambiguous: boolean;
}): ConfidenceLevel {
  if (input.index > 0) return 'low';
  if (input.ambiguous) return 'low';
  if (input.matched >= 2 || input.seenBefore >= 2) return 'high';
  return 'medium';
}

/** Caps every candidate at `low`, for a row that should not lead with a purchase category. */
function demote(candidates: readonly PurposeCandidate[]): readonly PurposeCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    confidence: 'low',
    why: `${candidate.why} This line is a repayment, not the purchase itself.`,
  }));
}

function sameMerchant(
  related: readonly RelatedPayment[],
  merchantKey: string,
): readonly RelatedPayment[] {
  return related.filter((payment) => {
    const reading = readStatementRow(payment);
    return reading.merchantKey === merchantKey;
  });
}

/** Siblings that are themselves instalment rows — the rest of one plan. */
function planSiblings(siblings: readonly RelatedPayment[]): readonly string[] {
  return siblings
    .filter((payment) => {
      const nature = readStatementRow(payment).nature;
      return nature === 'instalment_principal' || nature === 'instalment_interest';
    })
    .map((payment) => payment.paymentId);
}

function confirmedCategoryAmong(siblings: readonly RelatedPayment[]): string | null {
  for (const sibling of siblings) {
    const category = sibling.confirmedCategory;
    if (category !== undefined && category !== null && category.trim() !== '') return category;
  }
  return null;
}

/** True when the gaps between sightings cluster around a month. */
function looksMonthly(siblings: readonly RelatedPayment[]): boolean {
  if (siblings.length < 2) return false;
  const days = [...siblings]
    .map((payment) => payment.occurredAt.getTime())
    .sort((a, b) => a - b)
    .flatMap((time, index, times) =>
      index === 0 ? [] : [(time - times[index - 1]!) / (24 * 60 * 60 * 1000)],
    );
  return days.length > 0 && days.every((gap) => gap >= 24 && gap <= 38);
}
