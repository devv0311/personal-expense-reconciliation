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

/**
 * The payload built for an external call still contained something that identifies a real
 * account, card, handle, or person (Phase 17, `security-model.md`).
 *
 * Deliberately its own type rather than an `AiContractError`: a contract error is the model
 * misbehaving on the way *in*, and this is this system misbehaving on the way *out*. It is the
 * fail-closed half of the redaction boundary — raised **instead of** sending, so an unredacted
 * identifier never leaves the machine even if a redaction rule was wrong or a new field was
 * added to a payload without one.
 *
 * `details` names the field and the *kind* of identifier found. It never carries the value:
 * an error about a leak must not itself be the leak, and these messages reach logs, which
 * `security-model.md` keeps free of raw financial detail.
 */
export class SanitizationError extends Error {
  public readonly code = 'PAYLOAD_NOT_SANITIZED' as const;

  public readonly details: Readonly<Record<string, string>>;

  constructor(message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'SanitizationError';
    this.details = Object.freeze({ ...details });
  }
}

/** Narrowing helper for `catch` blocks and tests. */
export function isSanitizationError(error: unknown): error is SanitizationError {
  return error instanceof SanitizationError;
}
