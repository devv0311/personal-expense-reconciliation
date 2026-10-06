import { useQuery } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "@/components/attention/question-card";
import { mockApi } from "@/test-support/api-mock";
import { CLASSIFICATION_QUESTION, INTEREST_QUESTION, PEOPLE } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { AttentionItem } from "@/lib/types";

/**
 * Saying what a payment was for.
 *
 * The tests are about the three ways this can mislead somebody: sounding certain when it is
 * not, offering a category on a line that is not a purchase, and making a correction harder
 * than an agreement. The fourth — writing anything without being asked — is covered by there
 * being no path from a click to a request that does not pass through the dialog.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderQuestion(item: AttentionItem = CLASSIFICATION_QUESTION) {
  const api = mockApi({ "/decision": { outcome: "accepted" } });
  renderWithQuery(<QuestionCard item={item} openHref={null} />);
  return api;
}

describe("what a payment looks like it was for", () => {
  it("leads with the suggestion and the plain reason, before any way to go looking", () => {
    renderQuestion();

    expect(screen.getByText(/This is probably/)).toBeInTheDocument();
    expect(screen.getByText("Gym & fitness")).toBeInTheDocument();
    expect(screen.getByText(/usually means a gym/i)).toBeInTheDocument();
  });

  it("says how sure it is in words, never as a score", () => {
    const { rerender } = renderWithQuery(
      <QuestionCard
        item={{
          ...CLASSIFICATION_QUESTION,
          suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, confidence: "high" },
        }}
        openHref={null}
      />,
    );
    expect(screen.getByText(/This looks like/)).toBeInTheDocument();

    rerender(
      <QuestionCard
        item={{
          ...CLASSIFICATION_QUESTION,
          suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, confidence: "low" },
        }}
        openHref={null}
      />,
    );
    expect(screen.getByText(/This might be/)).toBeInTheDocument();
    expect(screen.queryByText(/confidence|%|score/i)).toBeNull();
  });

  it("offers the alternatives it has, with their reasons, and the whole list behind a control that says so", async () => {
    const user = userEvent.setup();
    renderQuestion();

    expect(screen.getByRole("button", { name: "Health" })).toBeInTheDocument();
    // The reason is visible text rather than a `title`: a tooltip does not exist on a phone.
    expect(screen.getByText("It could also be health or medicine.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose another category" }));

    const select = screen.getByLabelText("What was it for?");
    expect(within(select).getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Other" })).toBeInTheDocument();
  });

  it("agreeing sends an agreement, not a rewrite", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: /Yes, gym & fitness/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /That's what it was/ }));

    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({ decision: "accept" });
  });

  it("choosing something else sends the correction through the same decision", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: "Health" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /That's what it was/ }));

    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({
      decision: "modify",
      modifiedOutput: { proposedKind: "expense", category: "Health", paidByPersonHint: null },
    });
  });

  it("states what confirming does, and what it does not, before it happens", async () => {
    const user = userEvent.setup();
    renderQuestion();

    await user.click(screen.getByRole("button", { name: /Yes, gym & fitness/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/counts it under that from now on/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/creates no debt to anybody/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/will be suggested this category/i)).toBeInTheDocument();
  });

  it("writes nothing from the card itself", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: "Health" }));
    expect(api.callsTo("/decision")).toHaveLength(0);
  });
});

describe("a line that is not a purchase", () => {
  it("warns before it offers anything at all", () => {
    renderQuestion(INTEREST_QUESTION);

    expect(screen.getByText(/not a purchase of its own/i)).toBeInTheDocument();
    expect(screen.getByText(/count the same money twice/i)).toBeInTheDocument();
  });

  it("never offers the shop named on the same line", () => {
    renderQuestion(INTEREST_QUESTION);

    expect(screen.getByText("Bills & subscriptions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, gym & fitness/i })).toBeNull();
    expect(screen.getByText(/Interest is what the card charged you/i)).toBeInTheDocument();
  });

  it("says so again in the dialog, rather than only on the card", async () => {
    const user = userEvent.setup();
    renderQuestion(INTEREST_QUESTION);

    await user.click(screen.getByRole("button", { name: /Yes, bills & subscriptions/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/interest, a fee or a repayment rather than a purchase/i),
    ).toBeInTheDocument();
  });
});

describe("a payment nothing has proposed anything about", () => {
  it("explains the reading, offering nothing to agree with", () => {
    renderQuestion({
      ...CLASSIFICATION_QUESTION,
      suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, inferenceId: null },
    });

    expect(screen.getByText(/Nothing is suggested for this payment yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, gym & fitness/i })).toBeNull();
  });
});

/* ------------------------------------------------- choosing who it was for, before approval */

const SHARE_PREVIEW = {
  expenseId: "exp-1",
  grossAmount: "300000",
  netAmount: "300000",
  method: "equal",
  paidBy: { personId: "p-dev", name: "Dev", isYou: true },
  shares: [
    {
      beneficiaryType: "person",
      beneficiaryId: "p-dev",
      name: "Dev",
      isYou: true,
      amount: "150000",
      percentage: null,
      members: null,
    },
    {
      beneficiaryType: "person",
      beneficiaryId: "p-alex",
      name: "Alex",
      isYou: false,
      amount: "150000",
      percentage: null,
      members: null,
    },
  ],
  obligations: [{ personId: "p-alex", name: "Alex", amount: "150000", direction: "collect" }],
  noObligationsBecause: null,
  replacesExistingAllocation: false,
  refusal: null,
};

/** Only the payer named: nobody would owe anything, as the ledger itself says. */
const PAYER_ONLY_PREVIEW = {
  ...SHARE_PREVIEW,
  shares: SHARE_PREVIEW.shares.slice(0, 1).map((share) => ({ ...share, amount: "300000" })),
  obligations: [],
  noObligationsBecause: "Nobody would owe anything: you paid, and nobody else is named.",
};

const SAVED_HISTORY = (ids: readonly string[]) => ({
  expenseId: "exp-1",
  allocationVersions: [
    {
      allocationId: "alloc-1",
      method: "equal",
      decidedAt: "2026-08-03T00:00:00.000Z",
      decidedBy: "manual",
      supersededAt: null,
      lines: ids.map((id) => ({
        beneficiaryType: "person",
        beneficiaryId: id,
        beneficiaryName: id === "p-dev" ? "Dev" : id === "p-alex" ? "Alex" : "Sam",
        amount: "150000",
        expenseItemId: null,
      })),
    },
  ],
  events: [],
  sources: { allocationIds: [], adjustmentIds: [], evidenceIds: [], settlementIds: [] },
});

const WITH_EXPENSE: AttentionItem = {
  ...CLASSIFICATION_QUESTION,
  suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, expenseId: "exp-1" },
};

function renderChoice(options: { preview?: unknown; allocationStatus?: number } = {}) {
  const api = mockApi({
    "/api/people": { people: PEOPLE },
    "/api/expenses/exp-1/allocation/preview": (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        beneficiaries?: unknown[];
      };
      // The ledger's answer follows who is named: with only the payer, nobody owes anything.
      return (
        options.preview ?? (body.beneficiaries?.length === 1 ? PAYER_ONLY_PREVIEW : SHARE_PREVIEW)
      );
    },
    "/api/expenses/exp-1/allocation": { allocationId: "alloc-1" },
    "/decision": { outcome: "modified" },
  });
  renderWithQuery(<QuestionCard item={WITH_EXPENSE} openHref={null} />);
  return api;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Yes, gym & fitness/i }));
  return screen.findByRole("dialog");
}

describe("saying who it was for, before it is approved", () => {
  it("leaves the one-tap answer exactly as it was: just me, an agreement, nothing divided", async () => {
    const user = userEvent.setup();
    const api = renderChoice();

    const dialog = await openDialog(user);
    expect(within(dialog).getByLabelText("Who was this for?")).toHaveValue("personal");
    expect(within(dialog).getByRole("button", { name: "That's what it was" })).toBeInTheDocument();
    // No share controls, no preview request, until somebody asks for them.
    expect(within(dialog).queryByText("Who benefited")).toBeNull();
    expect(api.callsTo("/allocation/preview")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "That's what it was" }));
    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({ decision: "accept" });
    expect(api.callsTo("/allocation")).toHaveLength(0);
  });

  it("says before approval that the kind cannot be changed afterwards, and that personal creates no debt", async () => {
    const user = userEvent.setup();
    renderChoice();

    const dialog = await openDialog(user);
    expect(within(dialog).getByText(/cannot be changed afterwards/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/creates no debt to anybody/i)).toBeInTheDocument();
    // Never a pointer at a correction screen that does not exist.
    expect(within(dialog).queryByText(/on the expense itself/i)).toBeNull();
  });

  it("asks the ledger for the split as if approved as shared, and shows its figures", async () => {
    const user = userEvent.setup();
    const api = renderChoice();

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");
    await user.click(await within(dialog).findByRole("button", { name: "Alex" }));

    // The ledger's own shares and the debt, quoted — nothing here divides ₹3,000.00 by two.
    expect(await within(dialog).findByText("You should collect from Alex")).toBeInTheDocument();
    expect(within(dialog).getAllByText("₹1,500.00").length).toBeGreaterThan(0);
    const preview = api.callsTo("/allocation/preview").at(-1)!;
    expect(preview.body).toMatchObject({
      method: "equal",
      beneficiaries: [
        { type: "person", id: "p-dev" },
        { type: "person", id: "p-alex" },
      ],
      ifApprovedAs: { relationshipType: "shared" },
    });
    expect(
      within(dialog).getByText(/is what\s+creates the debts|creates the debts/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Record it and save the split" }),
    ).toBeEnabled();
  });

  it("will not record a shared expense with nobody else named", async () => {
    const user = userEvent.setup();
    renderChoice();

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");

    expect(await within(dialog).findByText(/Pick at least one other person/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Record it and save the split" }),
    ).toBeDisabled();
  });

  it("approves as shared first, then saves the split, as two separate recorded steps in that order", async () => {
    const user = userEvent.setup();
    const api = renderChoice();

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");
    await user.click(await within(dialog).findByRole("button", { name: "Alex" }));
    await within(dialog).findByText("You should collect from Alex");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    await waitFor(() => expect(api.callsTo("/allocation").length).toBeGreaterThan(0));
    const writes = api.calls.filter(
      (call) => call.method === "POST" && !call.url.includes("preview"),
    );
    expect(writes.map((call) => call.url.replace(/^.*\/api/, ""))).toEqual([
      "/review/inferences/inf-1/decision",
      "/expenses/exp-1/allocation",
    ]);
    expect(writes[0]!.body).toMatchObject({
      decision: "modify",
      modifiedOutput: {
        proposedKind: "expense",
        relationshipType: "shared",
        category: "Gym & fitness",
      },
    });
    expect(writes[1]!.body).toMatchObject({
      method: "equal",
      beneficiaries: [
        { type: "person", id: "p-dev" },
        { type: "person", id: "p-alex" },
      ],
    });
  });

  it("keeps the question open and says so when the approval went through but the split did not save", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      {
        "/api/people": { people: PEOPLE },
        "/api/expenses/exp-1/allocation/preview": SHARE_PREVIEW,
        "/api/expenses/exp-1/allocation": () => ({
          error: { code: "PRECONDITION_FAILED", message: "The split could not be saved." },
        }),
        "/decision": { outcome: "modified" },
      },
      {},
    );
    // The decision succeeds; only the allocation route refuses.
    const original = global.fetch;
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/expenses/exp-1/allocation") && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "PRECONDITION_FAILED", message: "The split could not be saved." },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return (original as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    renderWithQuery(<QuestionCard item={WITH_EXPENSE} openHref={null} />);

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");
    await user.click(await within(dialog).findByRole("button", { name: "Alex" }));
    await within(dialog).findByText("You should collect from Alex");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    expect(await within(dialog).findByText(/but the split did not save/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nobody owes anything yet/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /Say who shared it on its own page/ }),
    ).toHaveAttribute("href", "/expenses/exp-1/share");
    // Still on screen: closing it is what lets the queue refresh.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(api.callsTo("/decision")).toHaveLength(1);
  });

  /**
   * The approval and the split are two writes. These stand in for a server whose approval has
   * committed and whose split fails the first `allocationFailures` times, and which, like the
   * real one, refuses to decide the same proposal twice.
   */
  function renderAfterCommittedApproval(options: {
    allocationFailures: number;
    expenseState?: string;
  }) {
    const api = mockApi({
      "/api/people": { people: PEOPLE },
      "/api/expenses/exp-1/allocation/preview": SHARE_PREVIEW,
      "/api/expenses/exp-1/allocation": { allocationId: "alloc-1" },
      "/api/expenses/exp-1/history": SAVED_HISTORY(["p-dev", "p-alex"]),
      "/api/expenses/exp-1": {
        id: "exp-1",
        description: "GYM",
        category: "Gym & fitness",
        grossAmount: "300000",
        netAmount: "300000",
        currency: "INR",
        occurredAt: "2026-08-03T00:00:00.000Z",
        relationshipType: "shared",
        paidByPersonId: "p-dev",
        state: options.expenseState ?? "approved",
      },
      "/decision": { outcome: "modified" },
    });
    const original = global.fetch;
    const sent: string[] = [];
    let failures = options.allocationFailures;
    let decided = false;
    const refuse = (status: number, code: string, message: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code, message } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.endsWith("/decision")) {
        sent.push("decision");
        if (decided) {
          return refuse(409, "INVALID_STATE_TRANSITION", "This was already decided.");
        }
        decided = true;
      }
      if (init?.method === "POST" && url.endsWith("/api/expenses/exp-1/allocation")) {
        sent.push("allocation");
        if (failures > 0) {
          failures -= 1;
          return refuse(409, "PRECONDITION_FAILED", "The split could not be saved.");
        }
      }
      return (original as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    renderWithQuery(<QuestionCard item={WITH_EXPENSE} openHref={null} />);
    return { api, sent };
  }

  async function approveAsShared(user: ReturnType<typeof userEvent.setup>) {
    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");
    await user.click(await within(dialog).findByRole("button", { name: "Alex" }));
    await within(dialog).findByText("You should collect from Alex");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));
    await within(dialog).findByText(/but the split did not save/i);
    return dialog;
  }

  it("retries only the split after a partial failure — the committed approval is never sent again", async () => {
    const user = userEvent.setup();
    const { sent } = renderAfterCommittedApproval({ allocationFailures: 1 });

    const dialog = await approveAsShared(user);
    expect(sent).toEqual(["decision", "allocation"]);

    // What is left is said, and the button no longer claims to approve anything.
    expect(
      within(dialog).queryByRole("button", { name: "Record it and save the split" }),
    ).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save the split" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual(["decision", "allocation", "allocation"]);
  });

  it("writes nothing on a retry when the split turns out to have been saved already", async () => {
    const user = userEvent.setup();
    // The first allocation actually reached the ledger but its answer did not come back, so the
    // expense already reads as allocated by the time the person retries.
    const { sent } = renderAfterCommittedApproval({
      allocationFailures: 1,
      expenseState: "allocated",
    });

    const dialog = await approveAsShared(user);
    await user.click(within(dialog).getByRole("button", { name: "Save the split" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual(["decision", "allocation"]);
  });

  it("finds the same unfinished state again when the dialog is closed and reopened", async () => {
    const user = userEvent.setup();
    const { sent } = renderAfterCommittedApproval({ allocationFailures: 1 });

    const first = await approveAsShared(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(first).not.toBeInTheDocument();

    const reopened = await openDialog(user);
    expect(within(reopened).getByText(/already approved/i)).toBeInTheDocument();
    // The kind is committed, so it is shown and not offered as a choice again.
    expect(within(reopened).queryByLabelText("Who was this for?")).toBeNull();
    await user.click(await within(reopened).findByRole("button", { name: "Alex" }));
    await within(reopened).findByText("You should collect from Alex");
    await user.click(within(reopened).getByRole("button", { name: "Save the split" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual(["decision", "allocation", "allocation"]);
  });

  /**
   * A small ledger standing behind `fetch`, with the transport under the test's control: a
   * request can be dropped before it reaches the ledger, or reach it and lose its answer.
   */
  function renderWithTransport(plan: {
    decision?: ("ok" | "drop" | "lost" | "late" | "gateway")[];
    allocation?: ("ok" | "drop" | "lost")[];
    readsFail?: boolean;
  }) {
    const api = mockApi({
      "/api/people": { people: PEOPLE },
      "/api/expenses/exp-1/allocation/preview": SHARE_PREVIEW,
    });
    const original = global.fetch;
    const sent: string[] = [];
    let state = "review_required";
    let kind = "personal";
    let category = "Gym & fitness";
    let held = ["p-dev", "p-alex"];
    const commit = (asKind: string) => {
      state = "approved";
      kind = asKind;
    };
    let late: () => void = () => undefined;
    let armed = false;
    const decision = [...(plan.decision ?? [])];
    const allocation = [...(plan.allocation ?? [])];
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const post = init?.method === "POST";
      if (post && url.endsWith("/decision")) {
        sent.push("decision");
        const mode = decision.shift() ?? "ok";
        const asKind =
          (
            JSON.parse(String(init?.body ?? "{}")) as {
              modifiedOutput?: { relationshipType?: string };
            }
          ).modifiedOutput?.relationshipType ?? "personal";
        if (mode === "drop") return Promise.reject(new TypeError("Failed to fetch"));
        // Reaches the ledger later, after the first recovery read has already looked.
        if (mode === "late") {
          late = () => commit(asKind);
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        // The delayed original lands just before this send, after the recovery read looked.
        if (armed) {
          armed = false;
          commit(asKind);
        }
        if (state !== "review_required") {
          return json({ error: { code: "INVALID_STATE_TRANSITION", message: "Decided." } }, 409);
        }
        commit(asKind);
        if (mode === "lost") return Promise.reject(new TypeError("Failed to fetch"));
        // A proxy answers after the upstream committed: not the ledger's own structured body.
        if (mode === "gateway") {
          return Promise.resolve(new Response("<html>Service Unavailable</html>", { status: 503 }));
        }
        return json({ outcome: "modified" });
      }
      if (post && url.endsWith("/api/expenses/exp-1/allocation")) {
        sent.push("allocation");
        const mode = allocation.shift() ?? "ok";
        if (mode === "drop") return Promise.reject(new TypeError("Failed to fetch"));
        state = "allocated";
        if (mode === "lost") return Promise.reject(new TypeError("Failed to fetch"));
        return json({ allocationId: "alloc-1" }, 201);
      }
      if (!post && url.endsWith("/api/expenses/exp-1")) {
        sent.push("read");
        if (plan.readsFail) return Promise.reject(new TypeError("Failed to fetch"));
        return json({
          id: "exp-1",
          state,
          category,
          relationshipType: kind,
          grossAmount: "300000",
        });
      }
      if (!post && url.endsWith("/api/expenses/exp-1/history")) {
        sent.push("history");
        return json(SAVED_HISTORY(held));
      }
      if (!post && url.endsWith("/api/test-queue"))
        return json({ pending: state === "review_required" });
      return (original as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    // The card lives only while the ledger still lists the proposal as pending, as in the app.
    function Queue() {
      const queue = useQuery({
        queryKey: ["review-queue"],
        queryFn: () =>
          fetch("/api/test-queue").then((r) => r.json() as Promise<{ pending: boolean }>),
      });
      return queue.data?.pending === false ? (
        <p>The question is gone.</p>
      ) : (
        <QuestionCard item={WITH_EXPENSE} openHref={null} />
      );
    }
    renderWithQuery(<Queue />);
    return {
      api,
      sent,
      /** The original request, delayed, finally reaches the ledger. */
      commitLate: () => late(),
      /** Another tab approves under another category. */
      otherTabCategory: (next: string) => {
        category = next;
      },
      /** Another tab saves a split between these people. */
      otherTabSplits: (ids: string[]) => {
        held = ids;
        state = "allocated";
      },
      /** Another tab decides this proposal. */
      otherTabApproves: (asKind: string) => commit(asKind),
      /** The next decision send meets an approval that landed after the last read. */
      landBeforeNextSend: () => {
        armed = true;
      },
    };
  }

  async function shareWithAlex(user: ReturnType<typeof userEvent.setup>) {
    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByLabelText("Who was this for?"), "shared");
    await user.click(await within(dialog).findByRole("button", { name: "Alex" }));
    await within(dialog).findByText("You should collect from Alex");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));
    return dialog;
  }

  it("a request dropped before the ledger recorded it is checked, reported as not approved, and retried safely", async () => {
    const user = userEvent.setup();
    const { sent } = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    expect(await within(dialog).findByText(/had not recorded the approval/i)).toBeVisible();
    // Sent once, then the ledger was read; nothing else.
    expect(sent).toEqual(["decision", "read"]);

    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The retry read the ledger first, found nothing approved, sent the decision, and read again
    // for a saved split before writing one.
    expect(sent).toEqual(["decision", "read", "read", "decision", "read", "allocation"]);
  });

  it("an original request that commits after the recovery read is found on retry, and never sent again", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["late"] });

    const dialog = await shareWithAlex(user);
    // Honest about the read: not recorded *when checked*, and the first request may still arrive.
    expect(await within(dialog).findByText(/could still arrive/i)).toBeVisible();
    expect(within(dialog).queryByText(/nothing was approved/i)).toBeNull();

    ledger.commitLate();
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // One decision ever sent; the retry read the committed approval, then saved the split.
    expect(ledger.sent.filter((entry) => entry === "decision")).toHaveLength(1);
    expect(ledger.sent.at(-1)).toBe("allocation");
  });

  it("a stale 409 is settled from the ledger: committed as asked continues with the split, once", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    await within(dialog).findByText(/could still arrive/i);
    // The retry reads "pending", then the original lands, then the retry's send meets a 409.
    ledger.landBeforeNextSend();
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The 409 was met (second decision send), settled by reading, and the split saved once.
    expect(ledger.sent.filter((entry) => entry === "decision")).toHaveLength(2);
    expect(ledger.sent.filter((entry) => entry === "allocation")).toHaveLength(1);
    expect(ledger.sent.indexOf("allocation")).toBeGreaterThan(ledger.sent.lastIndexOf("decision"));
    expect(ledger.sent.at(-1)).toBe("allocation");
  });

  it("another tab's different outcome is shown, never overwritten, and the requested split is not applied", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    await within(dialog).findByText(/could still arrive/i);
    ledger.otherTabApproves("personal");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    expect(await within(dialog).findByText(/already decided another way/i)).toBeVisible();
    expect(within(dialog).getByText(/approved as personal/i)).toBeVisible();
    expect(within(dialog).getByText(/split you chose was not saved/i)).toBeVisible();
    expect(ledger.sent).not.toContain("allocation");
    expect(ledger.sent.filter((entry) => entry === "decision")).toHaveLength(1);
  });

  it("keeps the explanation on screen when the queue no longer lists the proposal, and refreshes on close", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    await within(dialog).findByText(/could still arrive/i);
    ledger.otherTabApproves("personal");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    // The card must not vanish with the queue before the message is read.
    expect(await within(dialog).findByText(/already decided another way/i)).toBeVisible();
    expect(screen.queryByText(/question is gone/i)).toBeNull();
    await user.keyboard("{Escape}");
    expect(await screen.findByText(/question is gone/i)).toBeVisible();
  });

  it("an approval of the same kind under another category is a different outcome, not ours", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    await within(dialog).findByText(/could still arrive/i);
    ledger.otherTabApproves("shared");
    ledger.otherTabCategory("Groceries");
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    expect(await within(dialog).findByText(/already decided another way/i)).toBeVisible();
    expect(within(dialog).getByText(/approved under “Groceries”/)).toBeVisible();
    expect(ledger.sent).not.toContain("allocation");
  });

  it("a split another tab saved between other people is never taken for ours", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["drop"] });

    const dialog = await shareWithAlex(user);
    await within(dialog).findByText(/could still arrive/i);
    ledger.otherTabApproves("shared");
    ledger.otherTabSplits(["p-dev", "p-sam"]);
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));

    expect(await within(dialog).findByText(/already split a different way/i)).toBeVisible();
    expect(within(dialog).getByText(/Dev, Sam/)).toBeVisible();
    expect(ledger.sent).not.toContain("allocation");
    expect(ledger.sent.filter((entry) => entry === "decision")).toHaveLength(1);
  });

  it("a direct 409 for a different outcome is also shown as such, not treated as success", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({});
    ledger.otherTabApproves("personal");

    const dialog = await shareWithAlex(user);
    expect(await within(dialog).findByText(/already decided another way/i)).toBeVisible();
    expect(ledger.sent).not.toContain("allocation");
  });

  it("an unstructured gateway answer after the upstream committed is uncertain, not a refusal", async () => {
    const user = userEvent.setup();
    const ledger = renderWithTransport({ decision: ["gateway"] });

    await shareWithAlex(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Read back as committed; the decision was sent once and the split saved once.
    expect(ledger.sent).toEqual(["decision", "read", "allocation"]);
  });

  it("a decision recorded with its answer lost is found by reading the ledger, never sent again", async () => {
    const user = userEvent.setup();
    const { sent } = renderWithTransport({ decision: ["lost"] });

    await shareWithAlex(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual(["decision", "read", "allocation"]);
  });

  it("when the ledger cannot be read either, says the result is not known and sends nothing until it can be checked", async () => {
    const user = userEvent.setup();
    const { sent } = renderWithTransport({ decision: ["lost"], readsFail: true });

    const dialog = await shareWithAlex(user);
    expect(
      await within(dialog).findByText(/can't yet tell whether the approval was recorded/i),
    ).toBeVisible();
    expect(within(dialog).queryByText(/nothing was approved/i)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Record it and save the split" }));
    await within(dialog).findByText(/can't yet tell/i);
    // The retry only read; the decision was not sent a second time.
    expect(sent.filter((entry) => entry === "decision")).toHaveLength(1);
  });

  it("a split whose answer was lost is read back and treated as saved, without a second save", async () => {
    const user = userEvent.setup();
    const { sent } = renderWithTransport({ allocation: ["lost"] });

    await shareWithAlex(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Read back, and compared with the split that was sent (the people, not just the state).
    expect(sent).toEqual(["decision", "allocation", "read", "history"]);
  });

  it("does not say the split did not save when that is not known", async () => {
    const user = userEvent.setup();
    const { sent } = renderWithTransport({ allocation: ["lost"], readsFail: true });

    const dialog = await shareWithAlex(user);
    expect(await within(dialog).findByText(/may or may not have saved/i)).toBeVisible();
    expect(within(dialog).queryByText(/did not save/i)).toBeNull();
    expect(within(dialog).queryByText(/Nobody owes anything yet/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save the split" }));
    await within(dialog).findByText(/may or may not have saved/i);
    expect(sent.filter((entry) => entry === "allocation")).toHaveLength(1);
  });

  it("does not offer who-shared on a line that is not a purchase", async () => {
    const user = userEvent.setup();
    renderQuestion(INTEREST_QUESTION);

    await user.click(screen.getByRole("button", { name: /Yes, bills & subscriptions/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Who was this for?")).toBeNull();
  });

  it("can be operated from the keyboard: labelled select, toggle buttons that say whether they are pressed, Escape to leave", async () => {
    const user = userEvent.setup();
    renderChoice();

    const dialog = await openDialog(user);
    const select = within(dialog).getByLabelText("Who was this for?");
    select.focus();
    await user.keyboard("{ArrowDown}");
    await user.selectOptions(select, "shared");
    const alex = await within(dialog).findByRole("button", { name: "Alex" });
    expect(alex).toHaveAttribute("aria-pressed", "false");
    alex.focus();
    await user.keyboard("{Enter}");
    expect(alex).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
