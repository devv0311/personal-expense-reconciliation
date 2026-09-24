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

  it("opens on arrival when a link from Add records asked it to, and closes for good", async () => {
    mockApi({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/payments": { paymentId: "pay-new", importBatchId: "batch-manual" },
    });
    renderWithQuery(<ManualPaymentForm openOnArrival />);
    const user = userEvent.setup();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Record a cash movement" }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

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

  /**
   * Says what the file is a statement of, then imports it.
   *
   * No reading is mocked in this block, so nothing has said what kind of account the file is
   * from, and the dialog asks (ADR-0068). The account these tests chose is a bank account.
   */
  async function confirm(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(
      await within(dialog).findByLabelText(/What kind of account is this statement from/),
      "bank",
    );
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
    // The layout that matched is provenance — recorded on the batch and shown in the import
    // history — and no longer the first thing this screen says to somebody holding a statement.
    expect(screen.queryByText("idfc_first_credit_card_pdf")).toBeNull();
  });

  it("says what was found, without anybody asking it to look", async () => {
    const { dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "imported",
        importBatchId: "batch-4",
        contentHash: "aa11bb",
        paymentIds: ["pay-1", "pay-2"],
        duplicates: [],
        formatId: "card_csv",
        warnings: [],
        closingBalanceCandidate: null,
        prepared: {
          ran: true,
          analysis: {
            recordsChecked: 2,
            connectionsFound: 0,
            suggestionsReady: 2,
            questionsForYou: 2,
            notUnderstood: 0,
            complete: true,
            stages: [],
          },
        },
      },
    });

    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile());
    await confirm(dialog, user);

    expect(await screen.findByText("I found a couple of things to confirm")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review suggestions" })).toHaveAttribute(
      "href",
      "/needs-attention",
    );
    // Never the words the machinery uses, on the screen a person lands on after an import.
    expect(screen.queryByText(/analys|pipeline|classif|model/i)).toBeNull();
  });

  it("reports only what this upload found, and asks the ledger for nothing more", async () => {
    // The completion panel is scoped to the file just added: its figures come from the import
    // response's own `prepared` block, which the API produced from the batch it committed in
    // that same request (ADR-0061). A second, ledger-wide read here would report other
    // statements' questions under this upload's heading — and would be a write nobody asked
    // for, on the screen where somebody has just finished asking for one specific thing.
    const { api, dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "imported",
        importBatchId: "batch-9",
        contentHash: "cc33dd",
        paymentIds: ["pay-1", "pay-2", "pay-3"],
        duplicates: [],
        formatId: "card_csv",
        warnings: [],
        closingBalanceCandidate: null,
        prepared: {
          ran: true,
          analysis: {
            recordsChecked: 3,
            connectionsFound: 1,
            suggestionsReady: 1,
            questionsForYou: 1,
            notUnderstood: 0,
            complete: true,
            stages: [],
          },
        },
      },
    });

    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile());
    await confirm(dialog, user);

    // What was saved, what was connected, and what still needs a decision — this upload's own.
    expect(await screen.findByText("Imported 3 rows")).toBeInTheDocument();
    expect(screen.getByText("I found one thing to confirm")).toBeInTheDocument();
    expect(screen.getByText(/1 record looks like they belong to a payment/)).toBeInTheDocument();

    // The import is the only write, and no separate ledger-wide analysis was triggered.
    expect(api.callsTo("/api/analysis")).toHaveLength(0);
    expect(api.callsTo("/api/imports/statement")).toHaveLength(1);
  });

  it("says a re-import had nothing new to read, rather than nothing at all", async () => {
    const { dialog, user } = await openImport({
      "/api/imports/statement": {
        outcome: "already_imported",
        importBatchId: "batch-1",
        contentHash: "b1a2c3",
        previouslyImportedAt: "2026-09-01T04:30:00.000Z",
        formatId: "card_csv",
        warnings: [],
        closingBalanceCandidate: null,
        prepared: {
          ran: false,
          reason: "This file was already on record, so there was nothing new to read.",
        },
      },
    });

    await user.upload(within(dialog).getByLabelText("Statement file"), pdfFile());
    await confirm(dialog, user);

    expect(await screen.findByText("This file was already imported")).toBeInTheDocument();
    expect(screen.getByText(/nothing has changed/i)).toBeInTheDocument();
    // Nothing new was written, so there is nothing new to confirm — and it does not pretend.
    expect(screen.queryByText(/things to confirm/)).toBeNull();
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

describe("reading a statement before it is imported", () => {
  /** A synthetic bank-account statement, as the preview route describes one. */
  const BANK_PREVIEW = {
    readable: true,
    formatId: "idfc_first_bank_account_pdf",
    formatLabel: "IDFC FIRST Bank — savings or current account statement (PDF)",
    accountKind: "bank",
    checksPrintedBalances: true,
    movementCount: 5,
    debitCount: 2,
    creditCount: 3,
    totalDebits: "148456",
    totalCredits: "5101234",
    firstDate: "2026-01-02",
    lastDate: "2026-01-05",
    closingBalance: "5952778",
    warnings: [],
    alreadyImported: null,
  };
  const CARD_ACCOUNT = {
    ...ACCOUNT,
    id: "a-card",
    name: "Synthetic Card",
    type: "card",
    institution: "Synthetic Bank",
    last4: null,
  };

  async function chooseFile(routes: Record<string, unknown>) {
    const api = mockApi(routes);
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      within(dialog).getByLabelText("Statement file"),
      new File(["%PDF-1.4\nsynthetic bank"], "statement.pdf", { type: "application/pdf" }),
    );
    return { api, dialog, user };
  }

  it("says what the file is and what is on it before anything is imported", async () => {
    const { api, dialog } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/imports/preview": BANK_PREVIEW,
    });

    expect(
      await within(dialog).findByText(/IDFC FIRST Bank — savings or current account statement/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/5 movements/)).toBeInTheDocument();
    expect(within(dialog).getByText("₹1,484.56")).toBeInTheDocument();
    expect(within(dialog).getByText("₹51,012.34")).toBeInTheDocument();
    expect(within(dialog).getByText(/accounted for by the balances/i)).toBeInTheDocument();
    // Reading is not importing: nothing has been written, and the file's own bytes were read.
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
    expect(api.bodyOf("/api/imports/preview")["contentBase64"]).toBe(
      btoa("%PDF-1.4\nsynthetic bank"),
    );
  });

  it("offers only bank accounts for a bank statement, and says why a card is not one", async () => {
    const { dialog, user } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/preview": BANK_PREVIEW,
    });

    await within(dialog).findByText(/5 movements/);
    expect(within(dialog).getByRole("option", { name: /Synthetic Card/ })).toBeDisabled();
    expect(within(dialog).getByRole("option", { name: /HDFC Savings/ })).toBeEnabled();

    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-bank");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
  });

  it("says plainly that no bank account exists yet, and leaves the choice to the person", async () => {
    const { api, dialog, user } = await chooseFile({
      "/api/accounts": { accounts: [CARD_ACCOUNT] },
      "/api/imports/preview": BANK_PREVIEW,
    });

    expect(await within(dialog).findByText(/no bank account/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Setup/ })).toHaveAttribute("href", "/setup");
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-bank");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  /** A synthetic credit-card statement, as the preview route describes one (ADR-0067). */
  const CARD_PREVIEW = {
    ...BANK_PREVIEW,
    formatId: "idfc_first_credit_card_pdf",
    formatLabel: "IDFC FIRST Bank credit card statement (PDF)",
    accountKind: "card",
    checksPrintedBalances: false,
    movementCount: 4,
    debitCount: 2,
    creditCount: 2,
    totalDebits: "373950",
    totalCredits: "145000",
    firstDate: "2026-07-02",
    lastDate: "2026-07-12",
    closingBalance: null,
  };

  it("offers only cards for a card statement, and says why a bank account is not one", async () => {
    const { api, dialog, user } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/preview": CARD_PREVIEW,
      "/api/imports/statement": {
        outcome: "already_imported",
        importBatchId: "batch-1",
        contentHash: "c1d2e3",
        previouslyImportedAt: "2026-09-01T04:30:00.000Z",
        formatId: "idfc_first_credit_card_pdf",
        warnings: [],
        closingBalanceCandidate: null,
      },
    });

    await within(dialog).findByText(/4 movements/);
    expect(within(dialog).getByRole("option", { name: /HDFC Savings.*not a card/ })).toBeDisabled();
    expect(within(dialog).getByRole("option", { name: /Synthetic Card/ })).toBeEnabled();

    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      CARD_ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-card");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import it" }));
    await waitFor(() => expect(api.callsTo("/api/imports/statement")).toHaveLength(1));
    expect(api.bodyOf("/api/imports/statement")["accountId"]).toBe(CARD_ACCOUNT.id);
  });

  it("says plainly that no card exists yet, points at Setup, and imports nothing", async () => {
    const { api, dialog, user } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/imports/preview": CARD_PREVIEW,
    });

    expect(
      await within(dialog).findByText(
        /This is a card statement, and there is no card on record yet\. Add the card in/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing has been imported/)).toBeInTheDocument();
    const setup = within(dialog).getByRole("link", { name: /Setup/ });
    expect(setup).toHaveAttribute("href", "/setup");
    // The way forward has to look like one: underlined at rest, not the sentence's own colour.
    expect(setup).toHaveClass("text-accent", "underline", "underline-offset-2");
    expect(within(dialog).getByRole("option", { name: /HDFC Savings/ })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-card");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  it("will not import a card statement into a bank account chosen before the file", async () => {
    const api = mockApi({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/preview": CARD_PREVIEW,
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
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-card");

    await user.upload(
      within(dialog).getByLabelText("Statement file"),
      new File(["%PDF-1.4\nsynthetic card"], "statement.pdf", { type: "application/pdf" }),
    );

    expect(
      await within(dialog).findByText(
        /This statement belongs to a card, and the account chosen is a bank account/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  it("points at Setup with a visible link when no account exists at all", async () => {
    const { dialog } = await chooseFile({
      "/api/accounts": { accounts: [] },
      "/api/imports/preview": { ...CARD_PREVIEW, accountKind: null },
    });

    expect(await within(dialog).findByText(/No accounts exist yet/)).toBeInTheDocument();
    const setup = within(dialog).getByRole("link", { name: /Setup/ });
    expect(setup).toHaveAttribute("href", "/setup");
    expect(setup).toHaveClass("text-accent", "underline", "underline-offset-2");
  });

  it("names the dialog for any statement, not only a bank's", async () => {
    await chooseFile({
      "/api/accounts": { accounts: [CARD_ACCOUNT] },
      "/api/imports/preview": CARD_PREVIEW,
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Import a statement" })).toBeInTheDocument();
  });

  it("does not offer to import a file it could not read", async () => {
    const { dialog, user } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/imports/preview": {
        readable: false,
        formatId: "auto",
        problems: [
          {
            lineNumber: 1,
            message:
              "This PDF has a text layer, but none of its lines matched a statement layout this build reads.",
          },
        ],
      },
    });

    expect(await within(dialog).findByText(/none of its lines matched/)).toBeInTheDocument();
    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-bank");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
  });

  it("says when these exact bytes are already on record", async () => {
    const { dialog } = await chooseFile({
      "/api/accounts": { accounts: [ACCOUNT] },
      "/api/imports/preview": {
        ...BANK_PREVIEW,
        alreadyImported: { importBatchId: "batch-1", importedAt: "2026-09-01T04:30:00.000Z" },
      },
    });

    // Distinct from the dialog's own sentence about rows "already on record": this is the file.
    expect(
      await within(dialog).findByText(/This exact file is already on record/),
    ).toBeInTheDocument();
  });
});

describe("saying what a CSV or spreadsheet is a statement of", () => {
  /**
   * A synthetic card-shaped CSV, as the preview route describes one (ADR-0068): read, and not
   * claiming any kind of account, because a table's columns never say whose it is.
   */
  const TABLE_PREVIEW = {
    readable: true,
    formatId: "card_statement_csv",
    formatLabel: "Amount with a debit/credit marker column (CSV or XLSX)",
    accountKind: null,
    checksPrintedBalances: false,
    movementCount: 2,
    debitCount: 1,
    creditCount: 1,
    totalDebits: "125000",
    totalCredits: "25000",
    firstDate: "2026-08-03",
    lastDate: "2026-08-05",
    closingBalance: null,
    warnings: [],
    alreadyImported: null,
  };
  const CARD_ACCOUNT = {
    ...ACCOUNT,
    id: "a-card",
    name: "Synthetic Card",
    type: "card",
    institution: "Synthetic Bank",
    last4: null,
  };
  const IMPORTED = {
    outcome: "imported",
    importBatchId: "batch-table",
    contentHash: "t1",
    paymentIds: ["pay-1", "pay-2"],
    duplicates: [],
    formatId: "card_statement_csv",
    warnings: [],
    closingBalanceCandidate: null,
  };
  const KIND = /What kind of account is this statement from/;

  function csvFile(contents = "Transaction Date,Transaction Description,Amount,Debit/Credit\n") {
    return new File([contents], "statement.csv", { type: "text/csv" });
  }

  async function chooseTable(routes: Record<string, unknown>) {
    const api = mockApi({ "/api/imports/preview": TABLE_PREVIEW, ...routes });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(within(dialog).getByLabelText("Statement file"), csvFile());
    await within(dialog).findByText(/2 movements/);
    return { api, dialog, user };
  }

  it("asks what kind of account the file is from, with no answer chosen for the person", async () => {
    const { dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
    });

    const question = within(dialog).getByLabelText(KIND);
    expect(question).toHaveValue("");
    expect(within(dialog).getByText(/a CSV or spreadsheet looks the same/i)).toBeInTheDocument();

    // Everything else in place, and still no import until the question is answered.
    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      CARD_ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-export");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
  });

  it("offers only accounts of the kind the person names, and says why the others are not", async () => {
    const { dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
    });

    await user.selectOptions(within(dialog).getByLabelText(KIND), "card");

    expect(within(dialog).getByRole("option", { name: /HDFC Savings.*not a card/ })).toBeDisabled();
    expect(within(dialog).getByRole("option", { name: /Synthetic Card/ })).toBeEnabled();
  });

  it("does not choose the account for the person, even when only one fits", async () => {
    const { dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
    });

    await user.selectOptions(within(dialog).getByLabelText(KIND), "card");

    expect(within(dialog).getByLabelText(/Account this statement belongs to/)).toHaveValue("");
  });

  it("sends the person's answer with the import, onto the account they chose", async () => {
    const { api, dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/statement": IMPORTED,
    });

    await user.selectOptions(within(dialog).getByLabelText(KIND), "card");
    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      CARD_ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-export");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import it" }));

    await waitFor(() => expect(api.callsTo("/api/imports/statement")).toHaveLength(1));
    const body = api.bodyOf("/api/imports/statement");
    expect(body["statementKind"]).toBe("card");
    expect(body["accountId"]).toBe(CARD_ACCOUNT.id);
  });

  it("says plainly when no account of the named kind exists, points at Setup, and imports nothing", async () => {
    const { api, dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [CARD_ACCOUNT] },
    });

    await user.selectOptions(within(dialog).getByLabelText(KIND), "bank");

    expect(
      within(dialog).getByText(
        /You said this is a bank account statement, and there is no bank account on record yet\./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing has been imported/)).toBeInTheDocument();
    const setup = within(dialog).getByRole("link", { name: /Setup/ });
    expect(setup).toHaveAttribute("href", "/setup");
    expect(
      within(dialog).getByRole("option", { name: /Synthetic Card.*not a bank account/ }),
    ).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-export");
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  it("will not import onto an account chosen first when the answer names another kind", async () => {
    const api = mockApi({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/preview": TABLE_PREVIEW,
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
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-export");
    await user.upload(within(dialog).getByLabelText("Statement file"), csvFile());
    await user.selectOptions(await within(dialog).findByLabelText(KIND), "card");

    expect(
      within(dialog).getByText(
        /You said this statement is from a card, and the account chosen is a bank account/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import it" })).toBeDisabled();
    expect(api.callsTo("/api/imports/statement")).toHaveLength(0);
  });

  it("asks again for each new file, because the answer was about the last one", async () => {
    const { dialog, user } = await chooseTable({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
    });
    await user.selectOptions(within(dialog).getByLabelText(KIND), "card");

    await user.upload(
      within(dialog).getByLabelText("Statement file"),
      csvFile("Date,Narration,Withdrawal Amt.,Deposit Amt.\n"),
    );

    await waitFor(() => expect(within(dialog).getByLabelText(KIND)).toHaveValue(""));
  });

  it("asks when the file could not be read ahead of the import, since nothing then says what it is", async () => {
    // No reading route: the reading is unavailable, not unreadable.
    mockApi({ "/api/accounts": { accounts: [ACCOUNT] } });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(within(dialog).getByLabelText("Statement file"), csvFile());

    expect(await within(dialog).findByLabelText(KIND)).toHaveValue("");
  });

  it("does not ask about a statement that names its own kind, and sends no answer for it", async () => {
    const api = mockApi({
      "/api/accounts": { accounts: [ACCOUNT, CARD_ACCOUNT] },
      "/api/imports/preview": {
        ...TABLE_PREVIEW,
        formatId: "idfc_first_credit_card_pdf",
        formatLabel: "IDFC FIRST Bank credit card statement (PDF)",
        accountKind: "card",
      },
      "/api/imports/statement": { ...IMPORTED, formatId: "idfc_first_credit_card_pdf" },
    });
    renderWithQuery(<ImportStatementForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Import a statement" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      within(dialog).getByLabelText("Statement file"),
      new File(["%PDF-1.4\nsynthetic card"], "statement.pdf", { type: "application/pdf" }),
    );
    await within(dialog).findByText(/2 movements/);

    expect(within(dialog).queryByLabelText(KIND)).toBeNull();
    await user.selectOptions(
      within(dialog).getByLabelText(/Account this statement belongs to/),
      CARD_ACCOUNT.id,
    );
    await user.type(within(dialog).getByLabelText(/Where it came from/), "synthetic-card");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Import it" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import it" }));
    await waitFor(() => expect(api.callsTo("/api/imports/statement")).toHaveLength(1));
    expect(api.bodyOf("/api/imports/statement")).not.toHaveProperty("statementKind");
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
