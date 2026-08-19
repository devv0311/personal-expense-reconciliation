/**
 * The single error type raised by `src/ai`.
 *
 * Distinct from `DomainError` (a financial rule was violated) and `ServiceError` (the
 * orchestration around one was wrong): an `AiContractError` means **the model returned
 * something that is not a proposal**. It is the first gate in `ai-boundary.md`'s validation
 * contract, and it fires before an `AIInference` row exists — a malformed response is not
 * stored as a bad proposal, it is not stored at all.
 */

export type AiContractErrorCode =
  /** The response was not a JSON object at all (null, an array, a string, …). */
  | 'MALFORMED_RESPONSE'
  /** A field the contract requires was absent or null. */
  | 'FIELD_MISSING'
  /** A field was present but not a permitted value or type. */
  | 'FIELD_INVALID'
  /** A field was present that this `proposedKind` must not carry, or that no key defines. */
  | 'FIELD_UNEXPECTED';

export class AiContractError extends Error {
  public readonly code: AiContractErrorCode;

  /** Structured context, always naming the offending `field` where there is one. */
  public readonly details: Readonly<Record<string, string>>;

  constructor(code: AiContractErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'AiContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** Narrowing helper for `catch` blocks and tests. */
export function isAiContractError(error: unknown): error is AiContractError {
  return error instanceof AiContractError;
}
