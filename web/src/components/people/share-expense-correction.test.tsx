import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareExpense } from "@/components/people/share-expense";
import { mockApi } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { AllocationPreviewResult } from "@/lib/types";

/**
 * Correcting an expense approved as just yours into one other people shared (ADR-0073).
 *
 * What these pin: the correction is offered only where the ledger listed it; the preview asks the
 * ledger "as if corrected"; the dialog states the consequence and requires a reason; what is sent
 * names the kind the screen showed; and after a lost answer the screen reads the ledger before
 * sending anything again, so a correction is never applied twice and a failure is never reported
 * as a success.
 */

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PERSONAL = {
  id: "exp-1",
  description: "Dinner",
  category: "Dining",
  grossAmount: "60000",
  netAmount: "60000",
  currency: "INR",
  occurredAt: "2026-08-02T10:00:00.000Z",
  relationshipType: "personal",
  paidByPersonId: "p0",
  state: "approved",
  kindCorrection: { targets: ["shared", "paid_on_behalf", "household_shared_flat"] },
};

const PEOPLE = [
  { id: "p0", displayName: "Dev", splitwiseUserId: null, isUser: true },
  { id: "p1", displayName: "Priya", splitwiseUserId: null, isUser: false },
];

const share = (id: string, name: string, isYou: boolean, amount: string) => ({
  beneficiaryType: "person" as const,
  beneficiaryId: id,
  name,
  isYou,
  amount,
  percentage: null,
  members: null,
});

const ONLY_ME: AllocationPreviewResult = {
  expenseId: "exp-1",
  grossAmount: "60000",
  netAmount: "60000",
  method: "equal",
  paidBy: { personId: "p0", name: "Dev", isYou: true },
  shares: [share("p0", "Dev", true, "60000")],
  obligations: [],
  noObligationsBecause: "Nobody would owe anything: you paid, and nobody else is named.",
  replacesExistingAllocation: false,
  refusal: null,
};

const WITH_PRIYA: AllocationPreviewResult = {
  ...ONLY_ME,
  shares: [share("p0", "Dev", true, "30000"), share("p1", "Priya", false, "30000")],
  obligations: [{ personId: "p1", name: "Priya", amount: "30000", direction: "collect" }],
  noObligationsBecause: null,
};

/** The preview answers from the people named, as the ledger would. */
function previewFor(_url: string, init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as {
    beneficiaries?: { id: string }[];
  };
  return (body.beneficiaries?.length ?? 0) > 1 ? WITH_PRIYA : ONLY_ME;
}

const HISTORY_CORRECTED = {
  expenseId: "exp-1",
  allocationVersions: [
    {
      allocationId: "a1",
      method: "equal",
      decidedAt: "2026-08-03T00:00:00.000Z",
      decidedBy: "manual",
      supersededAt: null,
      lines: [
        { beneficiaryType: "person", beneficiaryId: "p0", beneficiaryName: "Dev", amount: "30000" },
        {
          beneficiaryType: "person",
          beneficiaryId: "p1",
          beneficiaryName: "Priya",
          amount: "30000",
        },
      ],
    },
  ],
  events: [],
  sources: { allocationIds: [], adjustmentIds: [], evidenceIds: [], settlementIds: [] },
};

async function chooseSharedWithPriya(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Recorded as just yours" });
  await user.click(screen.getByRole("radio", { name: /^Shared/ }));
  await user.click(screen.getByRole("button", { name: "Priya" }));
  await screen.findByText("You should collect from Priya");
}

async function confirmWithReason(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: "Correct it and save who shared it" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/Why it is being corrected/), "Dinner with Priya");
  await user.click(within(dialog).getByRole("button", { name: label }));
  return dialog;
}

describe("correcting an expense approved as just yours", () => {
  it("is not offered when the ledger lists no correction", async () => {
    mockApi({
      "/api/expenses/exp-1/allocation/preview": ONLY_ME,
      "/api/expenses/exp-1": { ...PERSONAL, kindCorrection: { targets: [] } },
      "/api/people": { people: PEOPLE },
    });
    renderWithQuery(<ShareExpense expenseId="exp-1" />);
    await screen.findByRole("heading", { name: "Who shared this?" });
    expect(screen.queryByRole("heading", { name: "Recorded as just yours" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("asks the ledger what it would come to as if corrected, and blocks a correction naming only the payer", async () => {
    const mock = mockApi({
      "/api/expenses/exp-1/allocation/preview": previewFor,
      "/api/expenses/exp-1": PERSONAL,
      "/api/people": { people: PEOPLE },
    });
    const user = userEvent.setup();
    renderWithQuery(<ShareExpense expenseId="exp-1" />);

    await screen.findByRole("heading", { name: "Recorded as just yours" });
    await user.click(screen.getByRole("radio", { name: /^Shared/ }));
    await waitFor(() =>
      expect(
        mock
          .callsTo("/allocation/preview")
          .some(
            (call) =>
              (call.body as { ifCorrectedTo?: { relationshipType: string } }).ifCorrectedTo
                ?.relationshipType === "shared",
          ),
      ).toBe(true),
    );
    await screen.findByText(/Name at least one other person with a share/);
    expect(
      screen.getByRole("button", { name: "Correct it and save who shared it" }),
    ).toBeDisabled();
  });

  it("states the consequence, requires a reason, and sends the kind it showed", async () => {
    const mock = mockApi({
      "/api/expenses/exp-1/allocation/preview": previewFor,
      "/api/expenses/exp-1/relationship": { from: "personal", to: "shared" },
      "/api/expenses/exp-1": PERSONAL,
      "/api/people": { people: PEOPLE },
    });
    const user = userEvent.setup();
    renderWithQuery(<ShareExpense expenseId="exp-1" />);
    await chooseSharedWithPriya(user);

    await user.click(screen.getByRole("button", { name: "Correct it and save who shared it" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/from just yours to shared/);
    expect(dialog).toHaveTextContent(/together, or not at all/);
    expect(dialog).toHaveTextContent(/will owe you their share/);
    // No reason yet: the decision cannot be confirmed.
    expect(within(dialog).getByRole("button", { name: "Correct it" })).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Why it is being corrected/),
      "Dinner with Priya",
    );
    await user.click(within(dialog).getByRole("button", { name: "Correct it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(mock.bodyOf("/relationship")).toMatchObject({
      actor: "user",
      expectedRelationshipType: "personal",
      relationshipType: "shared",
      reason: "Dinner with Priya",
      method: "equal",
      beneficiaries: [
        { type: "person", id: "p0" },
        { type: "person", id: "p1" },
      ],
    });
  });

  it("after a lost answer, reads the ledger and reports done without sending twice", async () => {
    let posted = 0;
    const mock = mockApi({
      "/api/expenses/exp-1/allocation/preview": previewFor,
      "/api/expenses/exp-1/relationship": () => {
        posted += 1;
        throw new TypeError("Failed to fetch");
      },
      "/api/expenses/exp-1/history": HISTORY_CORRECTED,
      // The first read is the screen's; every read after the lost answer finds it corrected.
      "/api/expenses/exp-1": () =>
        posted === 0
          ? PERSONAL
          : {
              ...PERSONAL,
              relationshipType: "shared",
              state: "allocated",
              kindCorrection: { targets: [] },
            },
      "/api/people": { people: PEOPLE },
    });
    const user = userEvent.setup();
    renderWithQuery(<ShareExpense expenseId="exp-1" />);
    await chooseSharedWithPriya(user);
    await confirmWithReason(user, "Correct it");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toBe(1);
    expect(mock.callsTo("/history").length).toBeGreaterThan(0);
  });

  it("after a lost answer that never landed, says so, and checks again before resending", async () => {
    let posted = 0;
    const mock = mockApi({
      "/api/expenses/exp-1/allocation/preview": previewFor,
      "/api/expenses/exp-1/relationship": () => {
        posted += 1;
        if (posted === 1) throw new TypeError("Failed to fetch");
        return { from: "personal", to: "shared" };
      },
      "/api/expenses/exp-1": PERSONAL,
      "/api/people": { people: PEOPLE },
    });
    const user = userEvent.setup();
    renderWithQuery(<ShareExpense expenseId="exp-1" />);
    await chooseSharedWithPriya(user);
    const dialog = await confirmWithReason(user, "Correct it");

    await within(dialog).findByText(/the correction was not recorded/);
    const retry = within(dialog).getByRole("button", { name: "Check the ledger and continue" });
    const readsBefore = mock
      .callsTo("/api/expenses/exp-1")
      .filter((c) => c.method === "GET").length;
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toBe(2);
    // It looked before sending the second time.
    expect(
      mock.callsTo("/api/expenses/exp-1").filter((c) => c.method === "GET").length,
    ).toBeGreaterThan(readsBefore);
  });

  it("when another tab changed it some other way, says what the ledger holds and applies nothing", async () => {
    let posted = 0;
    mockApi({
      "/api/expenses/exp-1/allocation/preview": previewFor,
      "/api/expenses/exp-1/relationship": () => {
        posted += 1;
        throw new TypeError("Failed to fetch");
      },
      "/api/expenses/exp-1": () =>
        posted === 0
          ? PERSONAL
          : { ...PERSONAL, relationshipType: "household_shared_flat", state: "allocated" },
      "/api/people": { people: PEOPLE },
    });
    const user = userEvent.setup();
    renderWithQuery(<ShareExpense expenseId="exp-1" />);
    await chooseSharedWithPriya(user);
    const dialog = await confirmWithReason(user, "Correct it");

    await within(dialog).findByText(
      /already changed another way — it is recorded as household shared flat/,
    );
    expect(posted).toBe(1);
  });
});
