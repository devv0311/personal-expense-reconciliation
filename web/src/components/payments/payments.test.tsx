import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentDecisions } from "@/components/payments/payment-decisions";
import { ImportStatementForm } from "@/components/payments/import-statement";
import { ManualPaymentForm } from "@/components/payments/manual-payment-form";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import {
  ACCOUNT,
  CLASSIFIED_CREDIT,
  COUNTERPARTY_OPTIONS,
  PEOPLE,
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
  /** Opens the dialog with an account chosen and a source named, ready for a file. */
  async function openImport(routes: Record<string, unknown> = {}) {
    const api = mockApi({ "/api/accounts": { accounts: [ACCOUNT] }, ...routes });
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
    await user.type(within(dialog).getByLabelText(/Where it came from/), "idfc-first-card");
    return { api, dialog, user };
  }

  function pdfFile(name = "august.pdf") {
    return new File(["%PDF-1.4\nsynthetic"], name, { type: "application/pdf" });
  }

  async function confirm(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import it" }));
  }

  it("sends the file's original bytes, base64-encoded, never its text", async () => {
    // A PDF or XLSX decoded as text is destroyed before any parser sees it, so what the
    // browser puts on the wire is the property worth asserting.
    const { api, dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "already_imported",
        importBatchId: "batch-1",
        contentHash: "b1a2c3",
        previouslyImportedAt: "2026-09-01T04:30:00.000Z",
        formatId: "idfc_first_credit_card_pdf",
        warnings: [],
        closingBalanceCandidate: null,
      },
    });

    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile());
    await confirm(dialog, user);

    expect(await screen.findByText("This file was already imported")).toBeInTheDocument();
    const body = api.bodyOf("/api/imports/statement");
    expect(body["formatId"]).toBe("auto");
    expect(body["filename"]).toBe("august.pdf");
    expect(body["contentBase64"]).toBe(btoa("%PDF-1.4\nsynthetic"));
    // The bytes go to the multi-format endpoint, not the CSV-only one.
    expect(api.callsTo("/api/imports/bank-csv")).toHaveLength(0);
  });

  it("still sends a CSV the same way, so the older format keeps working", async () => {
    const { api, dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "imported",
        importBatchId: "batch-2",
        contentHash: "c4d5e6",
        paymentIds: ["pay-1", "pay-2"],
        duplicates: [],
        formatId: "hdfc_bank_csv",
        warnings: [],
        closingBalanceCandidate: "4812000",
      },
    });

    await user.upload(
      within(dialog).getByLabelText("Statement file"),
      new File(["date,description,amount_inr,type,reference\n"], "august.csv", {
        type: "text/csv",
      }),
    );
    await confirm(dialog, user);

    expect(await screen.findByText("Imported 2 rows")).toBeInTheDocument();
    const body = api.bodyOf("/api/imports/statement");
    expect(body["filename"]).toBe("august.csv");
    expect(body["contentBase64"]).toBe(btoa("date,description,amount_inr,type,reference\n"));
  });

  it("shows what the reader could not read, rather than only what it matched", async () => {
    // A PDF has no columns, so a count alone would read as "your statement had four
    // transactions". The reader's own warnings are quoted instead.
    const { dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "imported",
        importBatchId: "batch-3",
        contentHash: "f7a8b9",
        paymentIds: ["pay-1", "pay-2", "pay-3", "pay-4"],
        duplicates: [],
        formatId: "idfc_first_credit_card_pdf",
        warnings: [
          {
            lineNumber: null,
            message:
              "Read 4 movement(s) from 17 lines of PDF text. A PDF has no column structure, " +
              "so anything this layout did not match was skipped rather than reported as a " +
              "bad row — check the count against the statement itself.",
          },
        ],
        closingBalanceCandidate: null,
      },
    });

    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile());
    await confirm(dialog, user);

    expect(await screen.findByText("Imported 4 rows")).toBeInTheDocument();
    expect(screen.getByText("Check this against the statement itself")).toBeInTheDocument();
    expect(
      screen.getByText(/check the count against the statement/, { selector: "li" }),
    ).toBeInTheDocument();
    // The layout that read the file is named, so a wrong detection is visible rather than not.
    expect(screen.getByText("idfc_first_credit_card_pdf")).toBeInTheDocument();
  });

  it("refuses a file past the local size limit without reading or sending it", async () => {
    const { api, dialog, user } = await openImport();

    const oversized = new File(["%PDF-1.4"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", { value: 26 * 1024 * 1024 });
    await user.upload(within(dialog).getByLabelText("Statement file"), oversized);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /larger than the 25 MB local import limit/,
    );
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  it("will not import before an account, a source and a file all exist", async () => {
    mockApi({ "/api/accounts": { accounts: [ACCOUNT] } });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
  });

  it("shows the API's refusal instead of claiming an import that did not happen", async () => {
    // A scanned statement is refused by name. The screen must say so rather than fall back to
    // a generic failure, because the two have different fixes.
    const refusal =
      "This PDF has no extractable text layer. It may be a scan or photograph rather than a " +
      "generated statement.";
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/imports/statement")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "IMPORT_SOURCE", message: refusal } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ accounts: [ACCOUNT] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof global.fetch;

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
    await user.type(within(dialog).getByLabelText(/Where it came from/), "idfc-first-card");
    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile("scan.pdf"));
    await confirm(dialog, user);

    expect(await within(dialog).findByText(/no extractable text layer/)).toBeInTheDocument();
    expect(screen.queryByText(/^Imported /)).not.toBeInTheDocument();
  });

  it("imports the file chosen last, even when an earlier read finishes after it", async () => {
    // A FileReader finishes when it finishes. Picking a large file and then a small one can
    // land the first read last, and without a guard the staged statement would be the file the
    // person had already replaced — imported under the name of the one they chose.
    const readers: FakeFileReader[] = [];
    class FakeFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      result: string | null = null;
      private file: File | null = null;
      constructor() {
        readers.push(this);
      }
      readAsDataURL(file: File) {
        this.file = file;
      }
      /** Completes this read with the contents its own file was given. */
      finish(contents: string) {
        this.result = `data:${this.file?.type ?? ""};base64,${btoa(contents)}`;
        this.onload?.();
      }
    }
    const realFileReader = global.FileReader;
    global.FileReader = FakeFileReader as unknown as typeof FileReader;

    try {
      const { api, dialog, user } = await openImport({
        "/api/imports/statement": {
          outcome: "imported",
          importBatchId: "batch-race",
          contentHash: "r1",
          paymentIds: ["pay-1"],
          duplicates: [],
          formatId: "idfc_first_credit_card_pdf",
          warnings: [],
          closingBalanceCandidate: null,
        },
      });

      const input = within(dialog).getByLabelText("Statement file");
      await user.upload(input, new File(["A"], "first.pdf", { type: "application/pdf" }));
      await user.upload(input, new File(["B"], "second.pdf", { type: "application/pdf" }));
      expect(readers).toHaveLength(2);

      // Out of order on purpose: the second selection completes, then the first.
      await act(async () => {
        readers[1]!.finish("SECOND-FILE-BYTES");
        await Promise.resolve();
      });
      await act(async () => {
        readers[0]!.finish("FIRST-FILE-BYTES");
        await Promise.resolve();
      });

      await confirm(dialog, user);
      await waitFor(() => expect(api.callsTo("/api/imports/statement")).toHaveLength(1));

      const body = api.bodyOf("/api/imports/statement");
      expect(body["filename"]).toBe("second.pdf");
      expect(body["contentBase64"]).toBe(btoa("SECOND-FILE-BYTES"));
      expect(body["contentBase64"]).not.toBe(btoa("FIRST-FILE-BYTES"));
    } finally {
      global.FileReader = realFileReader;
    }
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
      "/api/people": { people: PEOPLE },
      [`/api/payments/${payment.id}`]: payment,
    });
    renderWithQuery(<PaymentDecisions paymentId={payment.id} />);
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
