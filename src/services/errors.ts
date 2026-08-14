/**
 * Orchestration errors.
 *
 * Distinct from `DomainError`: a `DomainError` means a financial rule was violated (the
 * numbers do not add up), whereas a `ServiceError` means the orchestration around it was
 * wrong (the row is missing, the expense is in the wrong state, an audit event was not
 * written). Keeping them apart means `src/api` can map "your data is invalid" and "this
 * operation is not available right now" to different responses without string-matching.
 */

export type ServiceErrorCode =
  /** A referenced row does not exist. */
  | 'ENTITY_NOT_FOUND'
  /** The operation is not valid for the entity's current state. */
  | 'PRECONDITION_FAILED'
  /**
   * A mutating transaction completed without recording an `AuditEvent`.
   *
   * This is the structural half of invariant #21: rather than trusting every call site to
   * remember, `runAudited` refuses to commit a mutation that recorded nothing.
   */
  | 'AUDIT_EVENT_MISSING';

export class ServiceError extends Error {
  public readonly code: ServiceErrorCode;
  public readonly details: Readonly<Record<string, string>>;

  constructor(code: ServiceErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
