import { describe, expect, it } from "vitest";
import { ApiError, isUnansweredRequest } from "@/lib/api";

/**
 * Whether a failed request left the ledger's answer unknown is decided by the API contract: the
 * ledger answers a refusal with a structured `{ error: { code, message } }` body, so only a
 * dropped connection or an unstructured body (a proxy's page) is uncertain — whatever the status.
 */
describe("a request that ended without an answer from the ledger", () => {
  const refusal = (status: number, code: string) =>
    new ApiError(status, { error: { code, message: "Refused." } });

  it("is a dropped connection or an unstructured body", () => {
    expect(isUnansweredRequest(refusal(0, "NETWORK_ERROR"))).toBe(true);
    expect(isUnansweredRequest(refusal(503, "UNKNOWN_ERROR"))).toBe(true);
    expect(isUnansweredRequest(refusal(502, "UNKNOWN_ERROR"))).toBe(true);
    expect(isUnansweredRequest(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("is not a structured application refusal, whatever its status", () => {
    expect(isUnansweredRequest(refusal(503, "EVIDENCE_STORE_UNAVAILABLE"))).toBe(false);
    expect(isUnansweredRequest(refusal(409, "INVALID_STATE_TRANSITION"))).toBe(false);
    expect(isUnansweredRequest(refusal(500, "INTERNAL_ERROR"))).toBe(false);
  });
});
