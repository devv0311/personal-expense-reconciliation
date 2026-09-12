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
  /** A source file could not be read; every rejected row is reported (Phase 6). */
  | 'IMPORT_SOURCE_INVALID'
  /**
   * A well-formed AI proposal that the ledger contradicts (gate 2, `ai-boundary.md`).
   *
   * Distinct from `AiContractError`, which means the response was not a proposal at all. This
   * one means it was a proposal about something that does not exist, or about a payment that
   * proves otherwise — an expense funded by a credit, a payer who is not the account owner, a
   * counterparty nobody has heard of.
   */
  | 'AI_PROPOSAL_INVALID'
  /** A document exceeded `MAX_EVIDENCE_DOCUMENT_BYTES` (`evidence-service.ts`). */
  | 'EVIDENCE_DOCUMENT_TOO_LARGE'
  /**
   * Evidence storage could not be read or written.
   *
   * The ledger row and the document it points at live in different systems by design
   * (`security-model.md`), so the document store failing is a distinct, retryable condition
   * from anything being wrong with the row.
   */
  | 'EVIDENCE_STORE_UNAVAILABLE'
  /**
   * A mutating transaction completed without recording an `AuditEvent`.
   *
   * This is the structural half of invariant #21: rather than trusting every call site to
   * remember, `runAudited` refuses to commit a mutation that recorded nothing.
   */
  | 'AUDIT_EVENT_MISSING'
  /**
   * `SplitwisePort.createExpense`/`recordPayment` rejected (`splitwise-service.ts`).
   *
   * Distinct from `PRECONDITION_FAILED`: the request was valid and the ledger was ready to
   * sync, but the external call itself failed. No `SplitwiseExpense`/`SplitwiseSettlement` row
   * is ever written in this case, so retrying is simply calling the route again.
   */
  | 'SPLITWISE_SYNC_FAILED'
  /**
   * A message transport refused, or is not configured (`proof-pack-delivery-service.ts`).
   *
   * Always accompanied by a `proof_pack_deliveries` row in `failed` state carrying the
   * reason — a send that failed is recorded rather than lost, because "did that ever go?"
   * has to be answerable afterwards.
   */
  | 'MESSAGE_DELIVERY_FAILED'
  /**
   * A balance provider could not be read (`balance-provider-service.ts`).
   *
   * Never turned into a zero or a boundary. An unread account is recorded as unread
   * (ADR-0053).
   */
  | 'BALANCE_PROVIDER_UNAVAILABLE';

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
