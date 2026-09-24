/**
 * The question a waiting decision actually is.
 *
 * The review queue's kinds are accurate and unusable as an opening line: *classification
 * decision*, *possible duplicate*, *rejected classification*, *unmatched evidence*. Each names
 * the mechanism that produced the item, so a reader has to classify their own problem before
 * the screen will help them. What every one of them *is*, underneath, is a short question with
 * a yes/no or a name for an answer.
 *
 * This module is the mapping, and it is pure so that it can be tested by calling it and so that
 * exactly one place decides what each kind is asking. It carries no facts and no amounts: the
 * question is the wording, the facts come from the queue item beside it.
 *
 * **An unrecognised kind gets a real question, never silence.** `labels.ts` set the precedent
 * in `web/` — a value the UI has not been taught still renders — and the rule matters more
 * here, because a kind this file has not been taught is still a decision somebody has to make.
 * Dropping it would be the one failure mode a review queue cannot have.
 */

/** What is being asked, and why — both in the reader's language, never the schema's. */
export interface AttentionQuestion {
  readonly question: string;
  /** The plain reason this is being asked. Never a reason code, never a confidence score. */
  readonly why: string;
}

export interface AttentionQuestionInput {
  /** A `ReviewItemKind`, or anything else — an unknown value is answered, not rejected. */
  readonly kind: string;
  readonly reasons: readonly string[];
  /** For a classification proposal: what the model said it was. Absent when unreadable. */
  readonly proposedKind?: string | null;
  /** For a document: how many payments are currently being proposed for it. */
  readonly candidateCount?: number;
}

/**
 * The question one waiting item represents.
 *
 * Written as a lookup with a fallthrough rather than an exhaustive `switch`, deliberately: an
 * exhaustive switch over `ReviewItemKind` would stop compiling when a kind is added, which
 * sounds like the safer choice and is the opposite of it here. This function is also reached
 * with kinds read back from the database, and the honest behaviour for one it has never seen
 * is to ask a generic question about it — not to throw, and not to return nothing.
 */
export function attentionQuestion(input: AttentionQuestionInput): AttentionQuestion {
  switch (input.kind) {
    case 'classification_decision':
      return classificationQuestion(input);
    case 'possible_duplicate':
      return {
        question: 'Is this the same payment recorded twice?',
        why:
          'Two payments on record are for the same amount on the same day, and nothing on them ' +
          'tells them apart: they name the same or a similar payee, or are the same kind of ' +
          'payment. ' +
          'Nothing has been discarded — until you say, both are counted.',
      };
    case 'rejected_classification':
      return {
        question: 'What was this payment for?',
        why:
          'Nothing on record says what this money was for. A suggestion was made and you ' +
          'turned it down, so the amount is still unaccounted for.',
      };
    case 'unmatched_evidence':
      return documentQuestion(input);
    case 'payment_unaccounted':
      return {
        question: 'What was this payment for?',
        why:
          'Money moved and nothing on record says why. Adding the bill, the receipt or the ' +
          'screenshot for it is usually all it takes.',
      };
    case 'allocation_missing':
      return {
        question: 'Who shared this expense?',
        why:
          'This expense is on record but nobody is named as having benefited from it, so it ' +
          'cannot yet say who owes whom.',
      };
    default:
      return {
        question: 'Does this still need your judgement?',
        why:
          'Something is waiting on a decision that this screen cannot describe in plain words ' +
          'yet. It is shown here rather than hidden, and the full review queue can act on it.',
      };
  }
}

function classificationQuestion(input: AttentionQuestionInput): AttentionQuestion {
  if (input.proposedKind === 'settlement') {
    return {
      question: 'Was this money a refund, a transfer or a repayment?',
      why:
        'It looks like it settles up with somebody rather than buying anything. Recording it ' +
        'as spending would count the same money twice, so it needs you to say which it is.',
    };
  }
  if (input.proposedKind === null || input.proposedKind === undefined) {
    return {
      question: 'What was this payment for?',
      why:
        'A suggestion was made about this payment and it can no longer be read back. Nothing ' +
        'was applied; it needs to be answered by hand or asked again.',
    };
  }
  return {
    question: 'What was this payment for?',
    why:
      'There is a suggestion for what this payment was, and nothing becomes true until you ' +
      'agree with it.',
  };
}

function documentQuestion(input: AttentionQuestionInput): AttentionQuestion {
  const candidates = input.candidateCount ?? 0;
  if (input.reasons.includes('evidence_match_ambiguous') || candidates > 1) {
    return {
      question: 'Which payment is this document about?',
      why:
        'More than one payment could be the one this document describes, and the document ' +
        'itself does not tell them apart. Only you can.',
    };
  }
  if (candidates === 1) {
    return {
      question: 'Does this document belong to this payment?',
      why:
        'A payment on record looks like the one this document is about. Attaching it is what ' +
        'turns the payment into something the ledger can explain.',
    };
  }
  return {
    question: 'What payment is this document about?',
    why:
      'This document is on file and attached to nothing. It may describe a payment already on ' +
      'record, or one nothing has imported yet.',
  };
}
