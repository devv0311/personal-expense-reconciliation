import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CashFlowDecisions } from "@/components/payments/cash-flow-decisions";
import { ImportStatementForm } from "@/components/payments/import-statement";
import { ManualPaymentForm } from "@/components/payments/manual-payment-form";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import {
  ACCOUNT,
  CLASSIFIED_CREDIT,
  COUNTERPARTY_OPTIONS,
  UNEXPLAINED_PAYMENT,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { PaymentWorkspaceItem } from "@/lib/types";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("recording a movement by hand", () => {
  function renderForm(): ApiMock {
    const api = mockApi({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/payments": { paymentId: "pay-new", importBatchId: "batch-manual" },
    });
    renderWithQuery(<ManualPaymentForm />);
    return api;
  }

  it("sends an exact paise magnitude and a separate direction, never a signed amount", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record a movement" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /HDFC Savings/ })).toBeInTheDocument(),
    );

    await user.selectOptions(within(dialog).getByLabelText("Account"), ACCOUNT.id);
    await user.type(within(dialog).getByLabelText("Amount"), "1,234.50");
    await user.selectOptions(within(dialog).getByLabelText("Direction"), "credit");
    await user.type(within(dialog).getByLabelText("What it was"), "Cash back from Priya");
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() => expect(api.callsTo("/api/payments")).not.toHaveLength(0));
    const body = api.callsTo("/api/payments")[0]!.body as Record<string, unknown>;
    expect(body["amount"]).toBe("123450");
    expect(body["direction"]).toBe("credit");
    expect(body["description"]).toBe("Cash back from Priya");
  });

  it("refuses to submit before an account, an amount and a description exist", async () => {
    renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record a movement" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Record it" })).toBeDisabled();
  });
});

describe("importing a statement", () => {
  it("says a re-imported file was recognised rather than written twice", async () => {
    mockApi({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/imports/bank-csv": {
        outcome: "already_imported",
        importBatchId: "batch-1",
        contentHash: "b1a2c3",
        previouslyImportedAt: "2026-09-01T04:30:00.000Z",
      },
    });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /HDFC Savings/ })).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "hdfc-export");
    await user.upload(
      within(dialog).getByLabelText("CSV file"),
      new File(["date,description,amount_inr,type,reference\n"], "august.csv", {
        type: "text/csv",
      }),
    );

    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import it" }));

    expect(await screen.findByText("This file was already imported")).toBeInTheDocument();
  });

  it("states the all-or-nothing consequence before the button that does it", async () => {
    mockApi({ "/api/accounts": { accounts: [ACCOUNT] } });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/If any row cannot be read, nothing at all is imported/),
    ).toBeInTheDocument();
  });
});

describe("interpreting one movement", () => {
  function renderDecisions(payment: PaymentWorkspaceItem = UNEXPLAINED_PAYMENT): ApiMock {
    const api = mockApi({
      [`/api/payments/${payment.id}/counterparty`]: { paymentId: payment.id },
      [`/api/payments/${payment.id}/cash-flow`]: {
        paymentId: payment.id,
        cashFlowState: "normalized",
        cashFlowCategory: null,
      },
      "/api/payments/counterparty-options": COUNTERPARTY_OPTIONS,
      [`/api/payments/${payment.id}`]: payment,
    });
    renderWithQuery(<CashFlowDecisions paymentId={payment.id} />);
    return api;
  }

  it("keeps who and what-for as two separate decisions", async () => {
    renderDecisions();

    expect(await screen.findByText("Who was on the other side")).toBeInTheDocument();
    expect(screen.getByText("What the money was doing")).toBeInTheDocument();
  });

  it("records a counterparty with the id it resolved to", async () => {
    const api = renderDecisions();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Say who" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "merchant");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Blinkit" })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Which one"), "m-blinkit");
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() => expect(api.callsTo("pay-1/counterparty")).not.toHaveLength(0));
    const body = api.callsTo("pay-1/counterparty")[0]!.body as Record<string, unknown>;
    expect(body["counterpartyType"]).toBe("merchant");
    expect(body["counterpartyId"]).toBe("m-blinkit");
  });

  it("does not offer a refund role on a debit, because a debit refund is impossible", async () => {
    renderDecisions({ ...UNEXPLAINED_PAYMENT, cashFlowState: "normalized" });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Propose a role" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("option", { name: "Refund" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Peer settlement" })).toBeInTheDocument();
  });

  it("states the evidence gate on the approval it is about to ask for", async () => {
    renderDecisions(CLASSIFIED_CREDIT);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Needs a recorded expense adjustment against this payment/),
    ).toBeInTheDocument();
  });

  it("will not decline a proposed role without a reason", async () => {
    const api = renderDecisions(CLASSIFIED_CREDIT);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Decline it" })).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Reason/),
      "The credit is a cashback, not a refund",
    );
    await user.click(within(dialog).getByRole("button", { name: "Decline it" }));

    await waitFor(() => expect(api.callsTo("/cash-flow/reject")).not.toHaveLength(0));
    expect(api.callsTo("/cash-flow/reject")[0]!.body).toMatchObject({
      reason: "The credit is a cashback, not a refund",
    });
  });
});
